// RUTA Insight/Alert Engine - the "Notification Queue" pipeline stage:
// resolves WHO should be notified about a genuinely-new insight (see
// insightStore.ts's recordInsight - this is only ever called with a
// non-null result, i.e. an insight that did NOT already exist), applies
// per-recipient preferences/frequency-cap/quiet-hours, and inserts one
// ruta_notification_queue row per eligible recipient - the idempotency
// mechanism (Prevent duplicate notifications using idempotency keys" from
// the spec) that makes it safe to call this more than once for the same
// insight (e.g. a retried caller, or a future backfill).
//
// Caller: insightScanService.ts, once per genuinely-new insight, from
// inside the SAME per-tenant loop that already resolved this tenant's
// timezone for insightDetection.ts - `timezone` is threaded in here rather
// than re-derived, so a tenant's timezone is looked up once per scan
// iteration, not once per pipeline stage.

import { eq } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { rutaNotificationQueue } from "../../infrastructure/db/schema";
import { listRutaAlertCandidates } from "../../infrastructure/db/repositories/whatsapp";
import { publishInsightNotification } from "../../infrastructure/queue/qstash";
import { PERMISSIONS } from "../../domain/permissions";
import { getPreferences, isUnderFrequencyCap, isWithinQuietHours, nextEligibleInstant } from "./notificationPreferences";
import { recordQueuePublishFailure } from "../../infrastructure/observability/telemetry";
import type { StoredInsight } from "./insightStore";

export interface EnqueueSummary {
  candidates: number;
  eligible: number;
  queuedPending: number;
  skippedMuted: number;
  skippedFrequencyCap: number;
  alreadyQueued: number; // idempotency conflict - this insight/user pair was already enqueued (e.g. a re-run)
}

/** Resolves eligible recipients for `insight` and enqueues (or skips, with a
 * recorded terminal status) a ruta_notification_queue row for each one.
 * Only ever called by insightScanService.ts with a genuinely-new insight
 * (recordInsight's non-null result) - a duplicate re-detection never
 * reaches here, so this function itself doesn't need to re-check that. */
export async function enqueueNotificationsForInsight(tenantId: string, insight: StoredInsight, timezone: string): Promise<EnqueueSummary> {
  const summary: EnqueueSummary = { candidates: 0, eligible: 0, queuedPending: 0, skippedMuted: 0, skippedFrequencyCap: 0, alreadyQueued: 0 };

  const candidates = await listRutaAlertCandidates(tenantId);
  const eligible = candidates.filter((c) => c.permissions.includes(PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY));
  summary.candidates = candidates.length;
  summary.eligible = eligible.length;

  const now = new Date();

  for (const recipient of eligible) {
    const idempotencyKey = `${insight.id}:${recipient.userId}`;
    const prefs = await getPreferences(tenantId, recipient.userId);

    if (!prefs.enabled) {
      const inserted = await insertQueueRow(tenantId, insight.id, recipient.userId, idempotencyKey, "skipped_muted", now, "muted_by_recipient");
      if (inserted) summary.skippedMuted += 1;
      else summary.alreadyQueued += 1;
      continue;
    }

    if (!(await isUnderFrequencyCap(tenantId, recipient.userId, prefs))) {
      const inserted = await insertQueueRow(tenantId, insight.id, recipient.userId, idempotencyKey, "skipped_frequency_cap", now, "daily_frequency_cap_reached");
      if (inserted) summary.skippedFrequencyCap += 1;
      else summary.alreadyQueued += 1;
      continue;
    }

    // Quiet hours DELAY delivery (via QStash's own notBefore), they never
    // skip it outright - see ruta_notification_queue.status's own schema
    // comment for why there is deliberately no "skipped_quiet_hours" status.
    const scheduledFor = isWithinQuietHours(now, timezone, prefs) ? nextEligibleInstant(now, timezone, prefs) : now;

    const inserted = await insertQueueRow(tenantId, insight.id, recipient.userId, idempotencyKey, "pending", scheduledFor, null);
    if (!inserted) {
      summary.alreadyQueued += 1;
      continue;
    }

    const notBefore = scheduledFor.getTime() > now.getTime() ? Math.floor(scheduledFor.getTime() / 1000) : undefined;
    // Observability (Phase H) - "Track: ... Queue failures". The queue row
    // itself is already durably inserted above ('pending'/scheduled) before
    // this publish is attempted, so a publish failure here doesn't lose the
    // notification (a later manual/backfill re-run of this same insight
    // would still see it as already-queued via the idempotency key) - it
    // only means QStash never got told to actually deliver it. Recorded and
    // RE-THROWN (never swallowed) so this insight's row is left correctly
    // reflecting "queued but not confirmed publishable" and the caller
    // (insightScanService.ts's own per-tenant try/catch) still counts this
    // as an error for that tenant's sweep, unchanged from before this
    // instrumentation - only the failure is now also a named, counted metric
    // instead of a generic caught-and-logged exception.
    let messageId: string;
    try {
      messageId = await publishInsightNotification({ queueId: inserted.id, tenantId }, { notBefore });
    } catch (err) {
      recordQueuePublishFailure({ queue: "ruta_notification", tenantId, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    await recordQstashMessageId(inserted.id, messageId);
    summary.queuedPending += 1;
  }

  return summary;
}

interface InsertedQueueRow {
  id: string;
}

/** Inserts one queue row, guarded by the (tenantId, idempotencyKey) unique
 * index - returns the inserted row's id when this was genuinely new, or
 * null when a row for this exact (insight, recipient) pair already existed
 * (onConflictDoNothing's no-op path) - the actual "prevent duplicate
 * notifications" guarantee, independent of anything checked above in JS. */
async function insertQueueRow(
  tenantId: string,
  insightId: string,
  userId: string,
  idempotencyKey: string,
  status: "pending" | "skipped_muted" | "skipped_frequency_cap",
  scheduledFor: Date,
  failureReason: string | null,
): Promise<InsertedQueueRow | null> {
  const db = await getDb();
  const rows = await db
    .insert(rutaNotificationQueue)
    .values({
      tenantId,
      insightId,
      userId,
      idempotencyKey,
      status,
      scheduledFor,
      failureReason,
      // A skipped_* row is already in its terminal state the moment it's
      // written - deliveredAt stays null (nothing was ever sent), but
      // lastAttemptAt records when this decision was made, same as a real
      // delivery attempt would.
      lastAttemptAt: status === "pending" ? null : new Date(),
    })
    .onConflictDoNothing({ target: [rutaNotificationQueue.tenantId, rutaNotificationQueue.idempotencyKey] })
    // Deliberately bare .returning() - see insightStore.ts's recordInsight
    // for why a `.returning({ ... })` column-selection object hits a
    // drizzle-orm/TypeScript inference limit on these Phase E tables
    // specifically; the full-row form resolves fine.
    .returning();
  const row = rows[0];
  return row ? { id: row.id } : null;
}

async function recordQstashMessageId(queueId: string, messageId: string): Promise<void> {
  const db = await getDb();
  await db.update(rutaNotificationQueue).set({ qstashMessageId: messageId, updatedAt: new Date() }).where(eq(rutaNotificationQueue.id, queueId));
}
