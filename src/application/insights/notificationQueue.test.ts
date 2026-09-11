// notificationQueue.ts - the "Notification Queue" pipeline stage. Real
// Postgres (describe.skipIf(!process.env.DATABASE_URL)) plus the globally
// mocked QStash (vitest.setup.ts / src/testSupport/qstashCapture.ts) -
// proves idempotency, eligibility filtering (permission + WhatsApp link),
// mute/frequency-cap skip behavior, and quiet-hours delay (via QStash's
// notBefore), all independent of the actual wall-clock time the test suite
// happens to run at.

import { beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { companies, roles, rutaNotificationQueue, users } from "../../infrastructure/db/schema";
import { upsertUserWhatsappLink } from "../../infrastructure/db/repositories/whatsapp";
import { PERMISSIONS } from "../../domain/permissions";
import { publishedMessages, resetPublishedMessages, type CapturedRutaNotificationPublish } from "../../testSupport/qstashCapture";
import { enqueueNotificationsForInsight } from "./notificationQueue";
import { updatePreferences } from "./notificationPreferences";
import { recordInsight, type StoredInsight } from "./insightStore";
import type { DetectedInsight } from "./insightDetection";

const TZ = "Asia/Kolkata";

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

async function makeTenant(label: string): Promise<string> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Queue ${label}`, slug: unique(`nq-${label}`), accountType: "individual", timezone: TZ }).returning();
  return company!.id;
}

async function makeUser(tenantId: string, label: string, opts: { broadGrant?: boolean; linkPhone?: string | null } = {}): Promise<string> {
  const db = await getDb();
  const broadGrant = opts.broadGrant ?? true;
  const [role] = await db
    .insert(roles)
    .values({ companyId: tenantId, name: unique("Role"), permissions: broadGrant ? [PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY] : [], isSystem: true })
    .returning();
  const [user] = await db.insert(users).values({ companyId: tenantId, roleId: role!.id, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: label }).returning();
  if (opts.linkPhone !== null) {
    const result = await upsertUserWhatsappLink(tenantId, user!.id, opts.linkPhone ?? unique("ph"));
    expect(result.ok).toBe(true);
  }
  return user!.id;
}

async function makeInsight(tenantId: string, overrides: Partial<DetectedInsight> = {}): Promise<StoredInsight> {
  const stored = await recordInsight(tenantId, {
    kind: "overdue_followups",
    severity: "warning",
    dedupeKey: unique("dedupe"),
    title: "Overdue follow-ups",
    message: "⚠️ RUTA Alert\n5 follow-ups are overdue or due right now, company-wide.",
    metrics: { count: 5 },
    ...overrides,
  });
  expect(stored).not.toBeNull();
  return stored!;
}

function rutaPublishes(): CapturedRutaNotificationPublish[] {
  return publishedMessages.filter((m): m is CapturedRutaNotificationPublish => m.kind === "ruta_notification");
}

async function rowFor(tenantId: string, insightId: string, userId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(rutaNotificationQueue)
    .where(and(eq(rutaNotificationQueue.tenantId, tenantId), eq(rutaNotificationQueue.insightId, insightId), eq(rutaNotificationQueue.userId, userId)));
  return row ?? null;
}

describe.skipIf(!process.env.DATABASE_URL)("enqueueNotificationsForInsight - behavior (real Postgres)", () => {
  beforeEach(() => {
    resetPublishedMessages();
  });

  it("enqueues a pending row and publishes to QStash for an eligible, un-muted, quiet-hours-off recipient", async () => {
    const tenantId = await makeTenant("eligible");
    const userId = await makeUser(tenantId, "U");
    await updatePreferences(tenantId, userId, { quietHoursStartMinute: null, quietHoursEndMinute: null });
    const insight = await makeInsight(tenantId);

    const summary = await enqueueNotificationsForInsight(tenantId, insight, TZ);
    expect(summary).toMatchObject({ candidates: 1, eligible: 1, queuedPending: 1, skippedMuted: 0, skippedFrequencyCap: 0, alreadyQueued: 0 });

    const row = await rowFor(tenantId, insight.id, userId);
    expect(row?.status).toBe("pending");
    expect(row?.idempotencyKey).toBe(`${insight.id}:${userId}`);

    const published = rutaPublishes();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ queueId: row!.id, tenantId, notBefore: undefined });
  });

  it("idempotency: calling it twice for the same insight never double-queues or double-publishes", async () => {
    const tenantId = await makeTenant("idem");
    const userId = await makeUser(tenantId, "U");
    await updatePreferences(tenantId, userId, { quietHoursStartMinute: null, quietHoursEndMinute: null });
    const insight = await makeInsight(tenantId);

    const first = await enqueueNotificationsForInsight(tenantId, insight, TZ);
    expect(first.queuedPending).toBe(1);
    expect(first.alreadyQueued).toBe(0);

    const second = await enqueueNotificationsForInsight(tenantId, insight, TZ);
    expect(second.queuedPending).toBe(0);
    expect(second.alreadyQueued).toBe(1);

    expect(rutaPublishes()).toHaveLength(1); // still just the one publish from the first call

    const db = await getDb();
    const rows = await db
      .select()
      .from(rutaNotificationQueue)
      .where(and(eq(rutaNotificationQueue.tenantId, tenantId), eq(rutaNotificationQueue.insightId, insight.id), eq(rutaNotificationQueue.userId, userId)));
    expect(rows).toHaveLength(1); // exactly one row for this (insight, recipient) pair
  });

  it("a muted recipient gets a skipped_muted row and no QStash publish", async () => {
    const tenantId = await makeTenant("muted");
    const userId = await makeUser(tenantId, "U");
    await updatePreferences(tenantId, userId, { enabled: false });
    const insight = await makeInsight(tenantId);

    const summary = await enqueueNotificationsForInsight(tenantId, insight, TZ);
    expect(summary).toMatchObject({ eligible: 1, queuedPending: 0, skippedMuted: 1 });

    const row = await rowFor(tenantId, insight.id, userId);
    expect(row?.status).toBe("skipped_muted");
    expect(row?.failureReason).toBe("muted_by_recipient");
    expect(rutaPublishes()).toHaveLength(0);
  });

  it("a recipient already at their frequency cap gets a skipped_frequency_cap row and no QStash publish", async () => {
    const tenantId = await makeTenant("cap");
    const userId = await makeUser(tenantId, "U");
    await updatePreferences(tenantId, userId, { maxPerDay: 1, quietHoursStartMinute: null, quietHoursEndMinute: null });

    // Manually insert one already-SENT notification within the rolling 24h
    // window so this recipient starts already at their cap of 1.
    const db = await getDb();
    const priorInsight = await makeInsight(tenantId, { dedupeKey: unique("prior") });
    await db.insert(rutaNotificationQueue).values({
      tenantId,
      insightId: priorInsight.id,
      userId,
      idempotencyKey: unique("idem-prior"),
      status: "sent",
      deliveredAt: new Date(),
    });

    const insight = await makeInsight(tenantId);
    const summary = await enqueueNotificationsForInsight(tenantId, insight, TZ);
    expect(summary).toMatchObject({ eligible: 1, queuedPending: 0, skippedFrequencyCap: 1 });

    const row = await rowFor(tenantId, insight.id, userId);
    expect(row?.status).toBe("skipped_frequency_cap");
    expect(row?.failureReason).toBe("daily_frequency_cap_reached");
    expect(rutaPublishes()).toHaveLength(0);
  });

  it("quiet hours delay a pending row's scheduledFor and pass notBefore to QStash, rather than skipping delivery outright", async () => {
    const tenantId = await makeTenant("quiet");
    const userId = await makeUser(tenantId, "U");
    // A window covering the entire day, independent of whatever real
    // wall-clock time this test happens to run at.
    await updatePreferences(tenantId, userId, { quietHoursStartMinute: 0, quietHoursEndMinute: 24 * 60 });
    const insight = await makeInsight(tenantId);

    const now = new Date();
    const summary = await enqueueNotificationsForInsight(tenantId, insight, TZ);
    expect(summary.queuedPending).toBe(1);

    const row = await rowFor(tenantId, insight.id, userId);
    expect(row?.status).toBe("pending");
    expect(row!.scheduledFor.getTime()).toBeGreaterThan(now.getTime());

    const published = rutaPublishes();
    expect(published).toHaveLength(1);
    expect(published[0]!.notBefore).toBeGreaterThan(Math.floor(now.getTime() / 1000));
  });

  it("only WhatsApp-linked users with the broad-query permission are candidates - a non-broad role and an unlinked user are both excluded", async () => {
    const tenantId = await makeTenant("filter");
    const eligibleUser = await makeUser(tenantId, "Eligible");
    await updatePreferences(tenantId, eligibleUser, { quietHoursStartMinute: null, quietHoursEndMinute: null });
    await makeUser(tenantId, "Restricted", { broadGrant: false }); // linked, but no broad grant
    await makeUser(tenantId, "Unlinked", { linkPhone: null }); // broad grant, but never linked a phone

    const insight = await makeInsight(tenantId);
    const summary = await enqueueNotificationsForInsight(tenantId, insight, TZ);

    // candidates = every WhatsApp-linked user regardless of permission (2:
    // Eligible + Restricted) - Unlinked never even shows up as a candidate.
    expect(summary.candidates).toBe(2);
    expect(summary.eligible).toBe(1);
    expect(summary.queuedPending).toBe(1);

    const db = await getDb();
    const rows = await db.select().from(rutaNotificationQueue).where(and(eq(rutaNotificationQueue.tenantId, tenantId), eq(rutaNotificationQueue.insightId, insight.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(eligibleUser);
  });

  it("candidates are tenant-scoped - a WhatsApp-linked, eligible user in a DIFFERENT tenant is never a candidate", async () => {
    const tenantId = await makeTenant("scope-a");
    const otherTenantId = await makeTenant("scope-b");
    await makeUser(otherTenantId, "OtherTenantUser"); // eligible, but in a different tenant

    const insight = await makeInsight(tenantId);
    const summary = await enqueueNotificationsForInsight(tenantId, insight, TZ);
    expect(summary.candidates).toBe(0);
    expect(summary.eligible).toBe(0);
    expect(summary.queuedPending).toBe(0);
  });
});
