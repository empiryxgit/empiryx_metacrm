import { and, eq, gte, lt, or, sql as rawSql } from "drizzle-orm";
import { getDb } from "./client";
import { leadProcessingLog, leads, rawMetaEvents, reconciliationRuns } from "./schema";
import { firstOrThrow } from "./util";
import type { IntegrationCounts } from "../../domain/types";

// ---- Raw events ---------------------------------------------------------

export async function saveRawEvent(input: {
  companyId: string;
  campaignId: string;
  objectType: string;
  rawPayload: unknown;
  signatureHeader: string | null;
  metaLeadId: string | null;
  pageId: string | null;
  formId: string | null;
}) {
  const db = await getDb();
  const rows = await db
    .insert(rawMetaEvents)
    .values({
      companyId: input.companyId,
      campaignId: input.campaignId,
      objectType: input.objectType,
      rawPayload: input.rawPayload as object,
      signatureHeader: input.signatureHeader,
      metaLeadId: input.metaLeadId,
      pageId: input.pageId,
      formId: input.formId,
      status: "received",
    })
    .returning();
  return firstOrThrow(rows);
}

export async function markRawEventEnqueued(rawEventId: string, qstashMessageId: string) {
  const db = await getDb();
  await db
    .update(rawMetaEvents)
    .set({ status: "enqueued", enqueuedAt: new Date(), qstashMessageId })
    .where(eq(rawMetaEvents.id, rawEventId));
}

export async function markRawEventEnqueueFailed(rawEventId: string, error: string) {
  const db = await getDb();
  await db
    .update(rawMetaEvents)
    .set({ status: "enqueue_failed", enqueueError: error })
    .where(eq(rawMetaEvents.id, rawEventId));
}

/** Raw events written to Postgres but never confirmed enqueued - either the QStash
 * publish call itself failed, or the process crashed between the durability write
 * and the publish call (status still "received" past the cutoff). Recovered by the
 * reconciliation handler's unenqueued-event sweep (see api/internal/reconciliation.ts).
 * Global across tenants deliberately - it's a small, cheap sweep and each row already
 * carries its own company_id/campaign_id, so no per-tenant scoping is needed here. */
export async function getUnenqueuedRawEvents(olderThanMinutes: number) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return db
    .select()
    .from(rawMetaEvents)
    .where(
      or(
        eq(rawMetaEvents.status, "enqueue_failed"),
        and(eq(rawMetaEvents.status, "received"), lt(rawMetaEvents.receivedAt, cutoff)),
      ),
    )
    .limit(500);
}

// ---- Leads ----------------------------------------------------------------

export async function leadExistsByMetaLeadId(metaLeadId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(eq(leads.metaLeadId, metaLeadId))
    .limit(1);
  return Boolean(row);
}

export interface InsertLeadInput {
  companyId: string;
  crmCampaignId: string;
  metaLeadId: string;
  platform: string;
  pageId: string;
  formId: string;
  adId?: string;
  adName?: string;
  adSetId?: string;
  adSetName?: string;
  campaignId?: string; // Meta's OWN ad-campaign id (distinct from crmCampaignId)
  campaignName?: string;
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  formResponses: unknown;
  metaCreatedAt: Date;
  rawEventId: string;
}

export type InsertLeadResult =
  | { outcome: "inserted"; id: string }
  | { outcome: "duplicate" };

/**
 * Inserts a lead, relying on the unique index on meta_lead_id as the
 * authoritative idempotency guard. A unique-violation here means another
 * concurrent invocation (or a QStash redelivery) won the race - that is
 * treated as a normal duplicate outcome, never as an error.
 */
export async function insertLead(input: InsertLeadInput): Promise<InsertLeadResult> {
  const db = await getDb();
  try {
    const rows = await db
      .insert(leads)
      .values({
        ...input,
        status: "processed",
        processedAt: new Date(),
      })
      .returning();
    return { outcome: "inserted", id: firstOrThrow(rows).id };
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      return { outcome: "duplicate" };
    }
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  const pgError = err as { code?: string; cause?: { code?: string } };
  return pgError?.code === "23505" || pgError?.cause?.code === "23505";
}

/** Scoped to a single CRM campaign - reconciliation sweeps one campaign's Meta
 * forms at a time and only needs to know what that campaign already has. */
export async function getRecentMetaLeadIds(crmCampaignId: string, sinceIso: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .select({ metaLeadId: leads.metaLeadId })
    .from(leads)
    .where(and(eq(leads.crmCampaignId, crmCampaignId), gte(leads.createdAt, new Date(sinceIso))));
  return new Set(rows.map((r) => r.metaLeadId));
}

export async function insertRecoveredLead(input: InsertLeadInput): Promise<InsertLeadResult> {
  const db = await getDb();
  try {
    const rows = await db
      .insert(leads)
      .values({
        ...input,
        status: "processed",
        processedAt: new Date(),
        recoveredByReconciliation: true,
      })
      .returning();
    return { outcome: "inserted", id: firstOrThrow(rows).id };
  } catch (err) {
    if (isUniqueViolation(err)) return { outcome: "duplicate" };
    throw err;
  }
}

export async function markLeadDeadLettered(metaLeadId: string, error: string) {
  const db = await getDb();
  await db
    .update(leads)
    .set({ status: "dead_lettered", lastError: error, updatedAt: new Date() })
    .where(eq(leads.metaLeadId, metaLeadId));
}

export async function incrementRetryCount(metaLeadId: string, error: string) {
  const db = await getDb();
  await db
    .update(leads)
    .set({
      retryCount: rawSql`${leads.retryCount} + 1`,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(leads.metaLeadId, metaLeadId));
}

export async function updateLeadPipelineStage(companyId: string, leadId: string, stage: string) {
  const db = await getDb();
  await db
    .update(leads)
    .set({ pipelineStage: stage, updatedAt: new Date() })
    .where(and(eq(leads.companyId, companyId), eq(leads.id, leadId)));
}

// ---- Audit log --------------------------------------------------------

export async function logEvent(input: {
  leadId?: string;
  rawEventId?: string;
  eventType: string;
  detail?: string;
}) {
  const db = await getDb();
  await db.insert(leadProcessingLog).values(input);
}

// ---- Monitoring ---------------------------------------------------------

export async function getIntegrationCounts(companyId: string, sinceIso: string): Promise<IntegrationCounts> {
  const db = await getDb();
  const since = new Date(sinceIso);

  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.companyId, companyId), gte(leads.createdAt, since)));

  const processed = rows.filter((r) => r.status === "processed");
  const avgProcessingSeconds =
    processed.length === 0
      ? 0
      : processed.reduce((sum, r) => {
          if (!r.processedAt) return sum;
          return sum + (r.processedAt.getTime() - r.createdAt.getTime()) / 1000;
        }, 0) / processed.length;

  return {
    received: rows.length,
    processed: processed.length,
    pending: rows.filter((r) => r.status === "pending" || r.status === "processing").length,
    failed: rows.filter((r) => r.status === "failed").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    deadLettered: rows.filter((r) => r.status === "dead_lettered").length,
    retries: rows.reduce((sum, r) => sum + r.retryCount, 0),
    avgProcessingSeconds: Math.round(avgProcessingSeconds * 100) / 100,
  };
}

export async function recordReconciliationRun(input: {
  companyId: string;
  campaignId: string;
  formsScanned: number;
  metaLeadsSeen: number;
  missingLeadsFound: number;
  missingLeadsRecovered: number;
  errors: number;
  notes?: string;
}) {
  const db = await getDb();
  await db.insert(reconciliationRuns).values({
    ...input,
    completedAt: new Date(),
  });
}

export async function getLastReconciliationRun(companyId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(reconciliationRuns)
    .where(eq(reconciliationRuns.companyId, companyId))
    .orderBy(rawSql`${reconciliationRuns.startedAt} DESC`)
    .limit(1);
  return row;
}
