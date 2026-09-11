// notificationDelivery.ts - the final "-> WhatsApp" pipeline stage. Real
// Postgres (describe.skipIf(!process.env.DATABASE_URL)); only graphClient's
// network call (sendWhatsappTextMessage) is mocked, same convention as
// rutaAiAssistant.flow.test.ts. Proves: the atomic claim guard, the 24h
// inbound-window gate, re-checked mute/frequency-cap at delivery time,
// successful delivery's side effects (status + setLastInsight), and the
// revert-to-pending-then-throw-RetryableProcessingError contract on a
// genuine send failure.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { getDb } from "../../infrastructure/db/client";
import { companies, metaConnections, metaWhatsappAccounts, roles, rutaNotificationQueue, users } from "../../infrastructure/db/schema";
import { encryptSecret } from "../../infrastructure/security/encryption";
import { touchLastInboundMessage, upsertUserWhatsappLink } from "../../infrastructure/db/repositories/whatsapp";
import { PERMISSIONS } from "../../domain/permissions";
import { deliverQueuedNotification } from "./notificationDelivery";
import { updatePreferences } from "./notificationPreferences";
import { recordInsight, type StoredInsight } from "./insightStore";
import { RetryableProcessingError } from "../processLead";

vi.mock("../../infrastructure/meta/graphClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/meta/graphClient")>();
  return { ...actual, sendWhatsappTextMessage: vi.fn(async () => {}) };
});

const TZ = "Asia/Kolkata";

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

/** A fresh tenant with a real, minimal, SELECTED WhatsApp send context -
 * mirrors rutaAiAssistant.flow.test.ts's own makeRutaTenant exactly (the
 * same rows resolveWhatsappSendContext reads). */
async function makeTenant(label: string, opts: { withSendContext?: boolean } = {}): Promise<string> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Delivery ${label}`, slug: unique(`nd-${label}`), accountType: "individual", timezone: TZ }).returning();
  if (opts.withSendContext ?? true) {
    const [conn] = await db
      .insert(metaConnections)
      .values({ tenantId: company!.id, metaUserId: unique("meta-user"), accessTokenEncrypted: encryptSecret("fake-access-token") })
      .returning();
    await db.insert(metaWhatsappAccounts).values({ tenantId: company!.id, metaConnectionId: conn!.id, wabaId: unique("waba"), phoneNumberId: unique("phone"), isSelected: true });
  }
  return company!.id;
}

async function makeUser(tenantId: string, label: string): Promise<string> {
  const db = await getDb();
  const [role] = await db.insert(roles).values({ companyId: tenantId, name: unique("Role"), permissions: [PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY], isSystem: true }).returning();
  const [user] = await db.insert(users).values({ companyId: tenantId, roleId: role!.id, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: label }).returning();
  return user!.id;
}

/** Links `userId` a WhatsApp number; `withinWindow` controls
 * lastInboundMessageAt - true stamps it via the real touchLastInboundMessage
 * (fresh, inside the 23h gate), false leaves it null (never messaged -
 * outside the window by construction, upsertUserWhatsappLink never sets
 * it on creation). */
async function linkUser(tenantId: string, userId: string, withinWindow: boolean): Promise<void> {
  const result = await upsertUserWhatsappLink(tenantId, userId, unique("ph"));
  expect(result.ok).toBe(true);
  if (withinWindow) await touchLastInboundMessage(tenantId, userId);
}

async function makeInsight(tenantId: string, message = "⚠️ RUTA Alert\ntest insight"): Promise<StoredInsight> {
  const stored = await recordInsight(tenantId, {
    kind: "overdue_followups",
    severity: "warning",
    dedupeKey: unique("dedupe"),
    title: "Overdue follow-ups",
    message,
    metrics: { count: 5 },
  });
  expect(stored).not.toBeNull();
  return stored!;
}

async function enqueueRow(tenantId: string, insightId: string, userId: string, status: "pending" | "sending" | "sent" | "failed" = "pending"): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(rutaNotificationQueue)
    .values({ tenantId, insightId, userId, idempotencyKey: unique("idem"), status, scheduledFor: new Date() })
    .returning();
  return row!.id;
}

async function fetchRow(queueId: string) {
  const db = await getDb();
  const [row] = await db.select().from(rutaNotificationQueue).where(eq(rutaNotificationQueue.id, queueId));
  return row ?? null;
}

async function fetchLink(tenantId: string, userId: string) {
  const db = await getDb();
  const { userWhatsappLinks } = await import("../../infrastructure/db/schema");
  const [row] = await db.select().from(userWhatsappLinks).where(and(eq(userWhatsappLinks.tenantId, tenantId), eq(userWhatsappLinks.userId, userId)));
  return row ?? null;
}

describe.skipIf(!process.env.DATABASE_URL)("deliverQueuedNotification - behavior (real Postgres)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers successfully: sends the WhatsApp message, marks the row 'sent', and records setLastInsight on the link", async () => {
    const tenantId = await makeTenant("happy");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId, "⚠️ RUTA Alert\nthe exact message body");
    const queueId = await enqueueRow(tenantId, insight.id, userId);

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("sent");

    expect(vi.mocked(graphClient.sendWhatsappTextMessage)).toHaveBeenCalledTimes(1);
    const call = vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls[0]!;
    expect(call[3]).toBe("⚠️ RUTA Alert\nthe exact message body");

    const row = await fetchRow(queueId);
    expect(row?.status).toBe("sent");
    expect(row?.deliveredAt).not.toBeNull();

    const link = await fetchLink(tenantId, userId);
    expect(link?.lastInsightId).toBe(insight.id);
    expect(link?.lastInsightAt).not.toBeNull();
  });

  it("atomic claim guard: a row not in 'pending' status is a no-op and returns 'already_handled'", async () => {
    const tenantId = await makeTenant("claim");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId, "sent"); // already terminal

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("already_handled");
    expect(vi.mocked(graphClient.sendWhatsappTextMessage)).not.toHaveBeenCalled();

    const row = await fetchRow(queueId);
    expect(row?.status).toBe("sent"); // untouched
  });

  it("a redelivery of an already-'sending' row is also a safe no-op (concurrent-invocation guard)", async () => {
    const tenantId = await makeTenant("concurrent");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId, "sending");

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("already_handled");
    expect(vi.mocked(graphClient.sendWhatsappTextMessage)).not.toHaveBeenCalled();
  });

  it("outside the 24h inbound window: fails cleanly with 'outside_24h_window', never attempts the send", async () => {
    const tenantId = await makeTenant("stale-window");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, false); // never messaged RUTA - lastInboundMessageAt stays null
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId);

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("outside_24h_window");
    expect(vi.mocked(graphClient.sendWhatsappTextMessage)).not.toHaveBeenCalled();

    const row = await fetchRow(queueId);
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toBe("outside_24h_window_no_template_configured");
  });

  it("re-checks mute status at delivery time, even though the row was pending when enqueued", async () => {
    const tenantId = await makeTenant("re-mute");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId);
    await updatePreferences(tenantId, userId, { enabled: false }); // muted AFTER enqueueing

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("skipped_muted");
    expect(vi.mocked(graphClient.sendWhatsappTextMessage)).not.toHaveBeenCalled();

    const row = await fetchRow(queueId);
    expect(row?.status).toBe("skipped_muted");
    expect(row?.failureReason).toBe("muted_by_recipient");
  });

  it("re-checks the frequency cap at delivery time", async () => {
    const tenantId = await makeTenant("re-cap");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    await updatePreferences(tenantId, userId, { maxPerDay: 1 });

    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId);

    // A different, already-sent notification pushes this recipient over
    // their cap of 1 before delivery is attempted.
    const db = await getDb();
    const otherInsight = await makeInsight(tenantId, "other");
    await db.insert(rutaNotificationQueue).values({ tenantId, insightId: otherInsight.id, userId, idempotencyKey: unique("idem-other"), status: "sent", deliveredAt: new Date() });

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("skipped_frequency_cap");
    const row = await fetchRow(queueId);
    expect(row?.status).toBe("skipped_frequency_cap");
    expect(row?.failureReason).toBe("daily_frequency_cap_reached");
  });

  it("no WhatsApp send context configured for the tenant: fails with 'no_send_context'", async () => {
    const tenantId = await makeTenant("no-ctx", { withSendContext: false });
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId);

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("no_send_context");
    const row = await fetchRow(queueId);
    expect(row?.status).toBe("failed");
    expect(row?.failureReason).toBe("no_whatsapp_send_context");
  });

  it("a send failure reverts the row to 'pending' (not left stuck at 'sending') and throws RetryableProcessingError", async () => {
    const tenantId = await makeTenant("send-fail");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId);

    vi.mocked(graphClient.sendWhatsappTextMessage).mockRejectedValueOnce(new Error("simulated Graph API failure"));

    await expect(deliverQueuedNotification(queueId, tenantId)).rejects.toThrow(RetryableProcessingError);

    const row = await fetchRow(queueId);
    expect(row?.status).toBe("pending"); // reverted, not stuck at 'sending'
    expect(row?.failureReason).toContain("simulated Graph API failure");

    // A subsequent retry can re-claim the SAME row (the claim guard only
    // excludes non-'pending' rows).
    vi.mocked(graphClient.sendWhatsappTextMessage).mockResolvedValueOnce(undefined);
    const retryOutcome = await deliverQueuedNotification(queueId, tenantId);
    expect(retryOutcome).toBe("sent");
  });

  // Note: there is no standalone "insight row deleted underneath a pending
  // queue row" test here - rutaNotificationQueue.insightId is a NOT NULL FK
  // to rutaInsights with ON DELETE CASCADE (schema.ts), so deleting the
  // insight deletes the queue row right along with it; the
  // insight_not_found branch in deliverQueuedNotification is defensive
  // code that the schema's own FK guarantees should make unreachable in
  // practice, not a reachable real-Postgres scenario to construct here.

  it("an unlinked recipient (link removed after enqueueing) fails with 'recipient_unlinked'", async () => {
    const tenantId = await makeTenant("unlinked");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId);

    const db = await getDb();
    const { userWhatsappLinks } = await import("../../infrastructure/db/schema");
    await db.delete(userWhatsappLinks).where(and(eq(userWhatsappLinks.tenantId, tenantId), eq(userWhatsappLinks.userId, userId)));

    const outcome = await deliverQueuedNotification(queueId, tenantId);
    expect(outcome).toBe("recipient_unlinked");
    const row = await fetchRow(queueId);
    expect(row?.failureReason).toBe("recipient_unlinked");
  });

  it("is tenant-scoped - a queueId from a DIFFERENT tenant claims nothing", async () => {
    const tenantId = await makeTenant("scope-a");
    const otherTenantId = await makeTenant("scope-b");
    const userId = await makeUser(tenantId, "U");
    await linkUser(tenantId, userId, true);
    const insight = await makeInsight(tenantId);
    const queueId = await enqueueRow(tenantId, insight.id, userId);

    const outcome = await deliverQueuedNotification(queueId, otherTenantId);
    expect(outcome).toBe("already_handled"); // the WHERE clause's tenantId match fails, so nothing is claimed
    expect(vi.mocked(graphClient.sendWhatsappTextMessage)).not.toHaveBeenCalled();

    const row = await fetchRow(queueId);
    expect(row?.status).toBe("pending"); // untouched
  });
});
