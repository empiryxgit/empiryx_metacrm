// RUTA Insight/Alert Engine - the final "-> WhatsApp" pipeline stage: the
// QStash-invoked worker that attempts ONE queued notification's delivery.
// Invoked by api/internal/handler.ts's handleNotifyDeliver (action=
// "notify-deliver"), itself triggered by publishInsightNotification
// (src/infrastructure/queue/qstash.ts). Mirrors processWhatsAppMessageEvent.ts's
// own shape: an atomic "claim" UPDATE (same idiom as
// organizationInvitations.acceptInvitation's one-shot UPDATE ... WHERE
// status = ... RETURNING - see that table's own doc comment) so a QStash
// redelivery of an already-completed or already-in-flight row is a safe,
// idempotent no-op rather than a double send; RetryableProcessingError
// (src/application/processLead.ts) for transient failures, translated by
// the handler into a 5xx so QStash retries with its own backoff; anything
// else is a terminal, recorded outcome.
//
// *** OPEN PREREQUISITE, distinct from the already-flagged Azure OpenAI one
// *** - see graphClient.ts's sendWhatsappTextMessage own comment: every
// WhatsApp send this codebase has ever made has been a free-form REPLY,
// always inside Meta's 24-hour customer-service window - that's the ONLY
// reason no message-template approval is needed there. A proactive alert
// (this file) is not a reply. It is only safe to send free-form when
// userWhatsappLinks.lastInboundMessageAt shows the recipient messaged RUTA
// within the last 24 hours; outside that window this worker deliberately
// never attempts the send (a doomed API call, or a policy violation) - it
// fails the row cleanly with failure_reason=
// 'outside_24h_window_no_template_configured' instead. Insight DETECTION
// and QUEUEING both work fully today regardless of this; only delivery to a
// recipient who hasn't messaged RUTA recently is gated on it, until a
// Meta-approved message template is provisioned and this branch is swapped
// to use it.

import { eq, sql } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { rutaNotificationQueue } from "../../infrastructure/db/schema";
import { getSelectedMetaWhatsappAccount, getUserWhatsappLinkByUserId, setLastInsight } from "../../infrastructure/db/repositories/whatsapp";
import { getActiveMetaConnectionInternal } from "../../infrastructure/db/repositories/metaIntegration";
import { sendWhatsappTextMessage } from "../../infrastructure/meta/graphClient";
import { RetryableProcessingError } from "../processLead";
import { getPreferences, isUnderFrequencyCap } from "./notificationPreferences";
import { getInsightById } from "./insightStore";
import { recordWhatsappDeliveryFailure } from "../../infrastructure/observability/telemetry";

/** Recipient must have messaged RUTA within this many hours for a PROACTIVE
 * send to still be inside Meta's 24h customer-service window - see this
 * file's own header. Deliberately a little under the real 24h Meta enforces
 * (23, not 24) so a slow QStash retry near the boundary fails closed rather
 * than risking a send Meta itself would reject. */
const INBOUND_WINDOW_HOURS = 23;

export type NotifyDeliverOutcome =
  | "sent"
  | "already_handled"
  | "skipped_muted"
  | "skipped_frequency_cap"
  | "outside_24h_window"
  | "no_send_context"
  | "recipient_unlinked"
  | "insight_not_found";

/** Attempts delivery of one queued notification. Never throws for an
 * outcome this function itself considers terminal (those are all recorded
 * on the row and returned normally) - it throws ONLY RetryableProcessingError,
 * and only for a failure worth QStash retrying (the actual WhatsApp send
 * call failing). The caller (api/internal/handler.ts) is what turns that
 * into a 5xx. */
export async function deliverQueuedNotification(queueId: string, tenantId: string): Promise<NotifyDeliverOutcome> {
  const db = await getDb();

  // Atomic claim - only a row still 'pending' gets claimed; a redelivery
  // that arrives after this same row already reached a terminal state (or
  // is already mid-flight from a concurrent invocation) finds nothing to
  // claim and is a safe, idempotent no-op.
  const claimed = await db
    .update(rutaNotificationQueue)
    .set({ status: "sending", attempts: sql`${rutaNotificationQueue.attempts} + 1`, lastAttemptAt: new Date(), updatedAt: new Date() })
    .where(sql`${rutaNotificationQueue.id} = ${queueId} AND ${rutaNotificationQueue.tenantId} = ${tenantId} AND ${rutaNotificationQueue.status} = 'pending'`)
    // Deliberately bare .returning() - see insightStore.ts's recordInsight
    // for why a `.returning({ ... })` column-selection object hits a
    // drizzle-orm/TypeScript inference limit on these Phase E tables
    // specifically; the full-row form resolves fine.
    .returning();
  const claimedRow = claimed[0];
  if (!claimedRow) return "already_handled";
  const row = { id: claimedRow.id, insightId: claimedRow.insightId, userId: claimedRow.userId };

  const terminal = async (status: "skipped_muted" | "skipped_frequency_cap" | "failed", failureReason: string): Promise<void> => {
    await db.update(rutaNotificationQueue).set({ status, failureReason, updatedAt: new Date() }).where(eq(rutaNotificationQueue.id, row.id));
  };

  // Re-check preferences/frequency cap - both may have changed since this
  // row was enqueued (the scan runs every 30 minutes; a lot can happen in
  // between, and the frequency cap in particular is meant to be checked as
  // close to send time as possible).
  const prefs = await getPreferences(tenantId, row.userId);
  if (!prefs.enabled) {
    await terminal("skipped_muted", "muted_by_recipient");
    return "skipped_muted";
  }
  if (!(await isUnderFrequencyCap(tenantId, row.userId, prefs))) {
    await terminal("skipped_frequency_cap", "daily_frequency_cap_reached");
    return "skipped_frequency_cap";
  }

  const link = await getUserWhatsappLinkByUserId(tenantId, row.userId);
  if (!link) {
    await terminal("failed", "recipient_unlinked");
    return "recipient_unlinked";
  }

  const withinWindow = link.lastInboundMessageAt !== null && Date.now() - link.lastInboundMessageAt.getTime() <= INBOUND_WINDOW_HOURS * 60 * 60 * 1000;
  if (!withinWindow) {
    await terminal("failed", "outside_24h_window_no_template_configured");
    return "outside_24h_window";
  }

  const insight = await getInsightById(tenantId, row.insightId);
  if (!insight) {
    await terminal("failed", "insight_not_found");
    return "insight_not_found";
  }

  const sendCtx = await resolveWhatsappSendContext(tenantId);
  if (!sendCtx) {
    await terminal("failed", "no_whatsapp_send_context");
    return "no_send_context";
  }

  try {
    await sendWhatsappTextMessage(sendCtx.phoneNumberId, sendCtx.accessToken, link.phoneNumber, insight.message);
  } catch (err) {
    // Revert to 'pending' so a QStash retry can re-claim this same row
    // rather than being permanently shut out by the claim guard above.
    const messageText = err instanceof Error ? err.message : String(err);
    // Observability (Phase H) - "Track: ... WhatsApp delivery failures".
    // `insight.message` (the actual alert text) is NEVER passed here - only
    // the technical send error - same discipline as rutaAiAssistant.ts's
    // own reply() failure path.
    recordWhatsappDeliveryFailure({ stage: "proactive_notification", tenantId, error: messageText });
    await db.update(rutaNotificationQueue).set({ status: "pending", failureReason: messageText, updatedAt: new Date() }).where(eq(rutaNotificationQueue.id, row.id));
    throw new RetryableProcessingError(`Failed to deliver RUTA insight notification ${queueId}: ${messageText}`);
  }

  await db.update(rutaNotificationQueue).set({ status: "sent", deliveredAt: new Date(), failureReason: null, updatedAt: new Date() }).where(eq(rutaNotificationQueue.id, row.id));
  await setLastInsight(tenantId, row.userId, row.insightId);
  return "sent";
}

// ---------------------------------------------------------------------------
// A deliberate, self-contained duplicate of rutaAiAssistant.ts's own
// (module-private, unexported) getSendContext - same reasoning
// notificationPreferences.ts's file header already gives for its own
// duplication of rutaDateRange.ts internals: this worker only needs the
// phoneNumberId/accessToken pair (not rutaAiAssistant.ts's timezone), and
// exporting that function purely for this one extra caller would widen a
// module boundary that otherwise has none today.
// ---------------------------------------------------------------------------

interface WhatsappSendContext {
  phoneNumberId: string;
  accessToken: string;
}

async function resolveWhatsappSendContext(tenantId: string): Promise<WhatsappSendContext | null> {
  const [account, connection] = await Promise.all([getSelectedMetaWhatsappAccount(tenantId), getActiveMetaConnectionInternal(tenantId)]);
  if (!account?.phoneNumberId || !connection?.accessToken) return null;
  return { phoneNumberId: account.phoneNumberId, accessToken: connection.accessToken };
}
