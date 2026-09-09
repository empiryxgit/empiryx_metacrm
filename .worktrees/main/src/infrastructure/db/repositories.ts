import { randomUUID } from "crypto";
import { and, desc, eq, gte, inArray, lt, or, sql as rawSql, type SQL } from "drizzle-orm";
import { getDb } from "./client";
import { leadFollowUps, leadProcessingLog, leads, rawMetaEvents, reconciliationRuns, users } from "./schema";
import { firstOrThrow } from "./util";
import type { IntegrationCounts } from "../../domain/types";
import { computeLeadQuality } from "../../domain/leadQuality";

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
  branchId?: string | null;
  crmCampaignId: string;
  metaLeadId: string;
  platform: string;
  pageId: string;
  formId: string;
  // Phase 12 - the form's own display name (resolveLeadFields.ts), not
  // returned by Meta's leadgen API itself - see that resolver's own
  // comment. Optional for the same "every existing caller keeps working
  // unchanged" reason customFields below is.
  formName?: string;
  adId?: string;
  adName?: string;
  adSetId?: string;
  adSetName?: string;
  campaignId?: string; // Meta's OWN ad-campaign id (distinct from crmCampaignId)
  campaignName?: string;
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  // Phase 10 - fields resolved from the Meta form's field mapping that
  // don't target a system column (see resolveLeadFields.ts). Optional so
  // every existing caller of insertLead/insertRecoveredLead keeps working
  // unchanged; the leads.custom_fields column already defaults to '{}'.
  customFields?: Record<string, unknown>;
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
  const quality = await scoreLeadSafely(input.companyId, input.fullName, input.email, input.phoneNumber, input.formResponses);
  try {
    const rows = await db
      .insert(leads)
      .values({
        ...input,
        status: "processed",
        processedAt: new Date(),
        qualityScore: quality.qualityScore,
        qualityLabel: quality.qualityLabel,
        qualityFlags: quality.qualityFlags,
        qualityScoredAt: new Date(),
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

// Exported so other lead-insert paths (e.g. metaLeadEvents.ts's
// insertMetaSyncLead) can rely on the exact same "unique violation = a
// normal duplicate outcome" treatment, without duplicating the pg error
// shape check.
export function isUniqueViolation(err: unknown): boolean {
  const pgError = err as { code?: string; cause?: { code?: string } };
  return pgError?.code === "23505" || pgError?.cause?.code === "23505";
}

/** Whether this tenant already captured another lead sharing the same
 * phone number or email within the last `withinMinutes` - the one signal
 * computeLeadQuality (src/domain/leadQuality.ts) needs that isn't
 * computable without a DB read (see that file's own header comment for
 * why the split exists). Backed by ix_leads_company_id_phone_number for
 * the phone half of the check; the email half is an unindexed filter on
 * the same query, acceptable at this table's realistic scale. Purely a
 * soft quality signal, never an idempotency guard - leads.meta_lead_id's
 * unique index (see isUniqueViolation above) remains the only thing that
 * actually blocks a duplicate insert. */
export async function hasRecentLeadWithSameContact(
  companyId: string,
  phoneNumber: string | null | undefined,
  email: string | null | undefined,
  withinMinutes = 10,
): Promise<boolean> {
  const phone = (phoneNumber ?? "").trim();
  const mail = (email ?? "").trim().toLowerCase();
  if (!phone && !mail) return false;

  const db = await getDb();
  const cutoff = new Date(Date.now() - withinMinutes * 60_000);
  const contactConditions = [];
  if (phone) contactConditions.push(eq(leads.phoneNumber, phone));
  if (mail) contactConditions.push(eq(leads.email, mail));

  const [row] = await db
    .select({ id: leads.id })
    .from(leads)
    .where(and(eq(leads.companyId, companyId), gte(leads.createdAt, cutoff), or(...contactConditions)))
    .limit(1);
  return Boolean(row);
}

export interface LeadQualityColumns {
  qualityScore: number | null;
  qualityLabel: string | null;
  qualityFlags: string[];
}

/** Scores a new lead's contact-quality signals for insertion, wrapping the
 * whole thing (the duplicate lookup above included) so a scoring failure
 * of any kind - a transient DB error, anything unexpected - can NEVER
 * fail the lead's own insert. Falls back to "unscored" (all null/empty)
 * rather than throwing - the exact same "enrichment must never block
 * persistence" principle every other enrichment step in this codebase
 * (resolveLeadFields, campaign attribution, historical backfill, ...)
 * already follows. Every leads.insert(...) values() for a DIGITAL lead
 * should call this - see insertLead/insertRecoveredLead below and
 * metaLeadEvents.ts's insertMetaSyncLead. insertManualLead deliberately
 * never calls this (a human already vetted that record by typing it in). */
export async function scoreLeadSafely(
  companyId: string,
  fullName: string | null | undefined,
  email: string | null | undefined,
  phoneNumber: string | null | undefined,
  formResponses: unknown,
): Promise<LeadQualityColumns> {
  try {
    const isRecentDuplicateSubmission = await hasRecentLeadWithSameContact(companyId, phoneNumber, email);
    const result = computeLeadQuality({ fullName, email, phoneNumber, formResponses, isRecentDuplicateSubmission });
    return { qualityScore: result.score, qualityLabel: result.label, qualityFlags: result.flags };
  } catch (err) {
    console.error(`[lead-quality] Failed to score a new lead for tenant ${companyId} - inserting it unscored rather than failing it:`, err);
    return { qualityScore: null, qualityLabel: null, qualityFlags: [] };
  }
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

/** Same shape as getRecentMetaLeadIds above, scoped by companyId (tenant)
 * rather than crmCampaignId - what the tenant-level pipeline's own
 * reconciliation sweep needs (see src/application/reconcile.ts), since a
 * lead ingested through that pipeline doesn't necessarily have a
 * crmCampaignId at all (an unmapped Meta campaign - see
 * processMetaLeadEvent.ts's header comment - still captures the lead). */
export async function getRecentMetaLeadIdsForCompany(companyId: string, sinceIso: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db
    .select({ metaLeadId: leads.metaLeadId })
    .from(leads)
    .where(and(eq(leads.companyId, companyId), gte(leads.createdAt, new Date(sinceIso))));
  return new Set(rows.map((r) => r.metaLeadId));
}

export async function insertRecoveredLead(input: InsertLeadInput): Promise<InsertLeadResult> {
  const db = await getDb();
  const quality = await scoreLeadSafely(input.companyId, input.fullName, input.email, input.phoneNumber, input.formResponses);
  try {
    const rows = await db
      .insert(leads)
      .values({
        ...input,
        status: "processed",
        processedAt: new Date(),
        recoveredByReconciliation: true,
        qualityScore: quality.qualityScore,
        qualityLabel: quality.qualityLabel,
        qualityFlags: quality.qualityFlags,
        qualityScoredAt: new Date(),
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

/**
 * Phase 15 - "Last Lead" for the Meta Integration status screen: the most
 * recent lead this tenant received through EITHER Meta pipeline (the legacy
 * per-campaign one and the tenant-level automatic sync both write into this
 * same `leads` table with source="meta_lead_ads" - see insertLead /
 * insertMetaSyncLead). Ordered by metaCreatedAt (Meta's own "when this lead
 * happened" timestamp, always set for a Meta-sourced lead) rather than our
 * own createdAt, so a reconciliation-recovered lead still reports the time
 * it actually came in, not the time we happened to notice it. Returns null
 * for a tenant that has never received a Meta lead - the status screen
 * renders that as "No leads received yet", never an error.
 */
export async function getLastMetaLeadReceivedAt(companyId: string): Promise<Date | null> {
  const db = await getDb();
  const [row] = await db
    .select({ metaCreatedAt: leads.metaCreatedAt })
    .from(leads)
    .where(and(eq(leads.companyId, companyId), eq(leads.source, "meta_lead_ads")))
    .orderBy(rawSql`${leads.metaCreatedAt} DESC`)
    .limit(1);
  return row?.metaCreatedAt ?? null;
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

/**
 * `branchCondition` (see branchAccessCondition) is folded directly into the
 * UPDATE's own WHERE clause rather than checked in a separate SELECT first -
 * one atomic query, no read-then-write race, and a lead outside the
 * caller's branch access simply matches zero rows (returns false) instead
 * of ever being touched. Omit it for internal/system callers that already
 * have their own scoping (there are none today - every API caller passes
 * one, see api/leads/handler.ts).
 */
export async function updateLeadPipelineStage(companyId: string, leadId: string, stage: string, branchCondition?: SQL): Promise<boolean> {
  const db = await getDb();
  const conditions = [eq(leads.companyId, companyId), eq(leads.id, leadId)];
  if (branchCondition) conditions.push(branchCondition);
  const rows = await db
    .update(leads)
    .set({ pipelineStage: stage, updatedAt: new Date() })
    .where(and(...conditions))
    .returning();
  return rows.length > 0;
}

/**
 * Lead counts per CRM campaign - powers the "Leads" column on the
 * Campaigns screen's synced-Meta-campaigns table. Scoped to companyId
 * (not just the campaign ids) as defense in depth against a caller ever
 * passing a campaign id from a different tenant. Returns a plain map so
 * the caller can default missing campaigns to 0 rather than needing to
 * distinguish "0 leads" from "not in the result set".
 */
export async function getLeadCountsForCampaigns(companyId: string, campaignIds: string[]): Promise<Record<string, number>> {
  if (campaignIds.length === 0) return {};
  const db = await getDb();
  const rows = await db
    .select({ crmCampaignId: leads.crmCampaignId, count: rawSql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.companyId, companyId), inArray(leads.crmCampaignId, campaignIds)))
    .groupBy(leads.crmCampaignId);
  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.crmCampaignId) result[row.crmCampaignId] = row.count;
  }
  return result;
}

/** Same shape as getLeadCountsForCampaigns above, but keyed by Meta's OWN
 * raw campaign id (leads.campaignId, text) rather than our crmCampaignId -
 * powers the "Leads" column on the Campaigns screen's Meta Campaigns table
 * (see listMetaCampaignsWithMapping), which counts every lead a synced
 * Meta campaign has produced regardless of whether it's been mapped to a
 * CRM campaign yet. */
export async function getLeadCountsByMetaCampaignId(companyId: string, metaCampaignIds: string[]): Promise<Record<string, number>> {
  if (metaCampaignIds.length === 0) return {};
  const db = await getDb();
  const rows = await db
    .select({ campaignId: leads.campaignId, count: rawSql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.companyId, companyId), inArray(leads.campaignId, metaCampaignIds)))
    .groupBy(leads.campaignId);
  const result: Record<string, number> = {};
  for (const row of rows) {
    if (row.campaignId) result[row.campaignId] = row.count;
  }
  return result;
}

// ---- Manual customers (Flow B) -----------------------------------------

export interface InsertManualLeadInput {
  companyId: string;
  branchId?: string | null;
  fullName: string;
  phoneNumber?: string;
  email?: string;
  source: string;
  ownerId?: string;
  pipelineStage: string;
  nextFollowUpAt?: Date;
  notes?: string;
  customFields: Record<string, unknown>;
}

/** Creates a manually-entered customer - a lead/customer record with no
 * originating Meta event. Uses a synthetic, guaranteed-unique "manual:"
 * prefixed value for meta_lead_id (still NOT NULL + unique-indexed) rather
 * than requiring a schema change; platform/page_id/form_id/raw_event_id
 * are left null since none of them apply. */
export async function insertManualLead(input: InsertManualLeadInput) {
  const db = await getDb();
  const rows = await db
    .insert(leads)
    .values({
      companyId: input.companyId,
      branchId: input.branchId ?? null,
      metaLeadId: `manual:${randomUUID()}`,
      leadType: "manual_customer",
      source: input.source,
      fullName: input.fullName,
      phoneNumber: input.phoneNumber,
      email: input.email,
      ownerId: input.ownerId,
      pipelineStage: input.pipelineStage,
      nextFollowUpAt: input.nextFollowUpAt,
      notes: input.notes,
      customFields: input.customFields,
      metaCreatedAt: new Date(),
      status: "processed",
      processedAt: new Date(),
    })
    .returning();
  return firstOrThrow(rows);
}

export interface InsertFormLeadInput {
  companyId: string;
  branchId?: string | null;
  crmCampaignId?: string | null;
  fullName: string;
  phoneNumber?: string;
  email?: string;
  source: string;
  // "manual_customer" for a form filled internally by a salesperson (Add
  // Customer using the configured internal form), "digital_lead" for a
  // public-form submission - an automatic, unattended inbound capture just
  // like a Meta lead, just not routed through the Meta webhook. See
  // api/forms/handler.ts for both callers.
  leadType: "digital_lead" | "manual_customer";
  ownerId?: string;
  pipelineStage: string;
  nextFollowUpAt?: Date;
  notes?: string;
  customFields: Record<string, unknown>;
  formResponses?: unknown;
}

/** The Forms module's single lead-write path - used by BOTH the internal
 * "Add Customer" form submission and the public lead-capture form
 * submission (see api/forms/handler.ts). Deliberately generalizes
 * insertManualLead() above (same synthetic-metaLeadId technique, same
 * table) rather than duplicating it, so every non-Meta origin (internal
 * form, public form, and the pre-existing manual "+Add Customer" fallback)
 * ends up as the exact same kind of `leads` row - there is no separate
 * "form submission" entity for a lead to live in. */
export async function insertFormLead(input: InsertFormLeadInput) {
  const db = await getDb();
  const rows = await db
    .insert(leads)
    .values({
      companyId: input.companyId,
      branchId: input.branchId ?? null,
      crmCampaignId: input.crmCampaignId ?? null,
      metaLeadId: `form:${randomUUID()}`,
      leadType: input.leadType,
      source: input.source,
      fullName: input.fullName,
      phoneNumber: input.phoneNumber,
      email: input.email,
      ownerId: input.ownerId,
      pipelineStage: input.pipelineStage,
      nextFollowUpAt: input.nextFollowUpAt,
      notes: input.notes,
      customFields: input.customFields,
      formResponses: (input.formResponses ?? []) as object,
      metaCreatedAt: new Date(),
      status: "processed",
      processedAt: new Date(),
    })
    .returning();
  return firstOrThrow(rows);
}

export interface UpdateLeadCrmFieldsInput {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  ownerId?: string | null;
  pipelineStage?: string;
  nextFollowUpAt?: Date | null;
  notes?: string;
  customFields?: Record<string, unknown>;
  branchId?: string | null;
}

/** Generic CRM-field update for the "Add to CRM" flow (turning a Meta lead
 * into a fully-worked customer record) and general edits. Deliberately
 * never touches source/leadType/metaLeadId/crmCampaignId/campaignName -
 * a record's original acquisition source is preserved for the life of the
 * record regardless of how the CRM data around it is enriched later. */
/** Same branchCondition-in-the-WHERE-clause approach as
 * updateLeadPipelineStage above - see its comment. */
export async function updateLeadCrmFields(companyId: string, leadId: string, input: UpdateLeadCrmFieldsInput, branchCondition?: SQL) {
  const db = await getDb();
  const conditions = [eq(leads.companyId, companyId), eq(leads.id, leadId)];
  if (branchCondition) conditions.push(branchCondition);
  const rows = await db
    .update(leads)
    .set({ ...input, updatedAt: new Date() })
    .where(and(...conditions))
    .returning();
  return rows[0] ?? null;
}

// ---- Follow-ups (Pipeline lead-details popup) --------------------------
//
// A structured, append-only log of contact attempts against a lead/
// customer - separate from `leads.notes` (one freeform field) and
// `leads.nextFollowUpAt` (just the next due date). See leadFollowUps in
// schema.ts for the full rationale.

/** Existence + tenant/branch-access check shared by both follow-up
 * endpoints below - same "company_id + branch_id enforced on the backend"
 * contract as updateLeadPipelineStage/updateLeadCrmFields above, so a
 * caller can never list or log a follow-up against a lead outside their
 * own company or branch access just by guessing its id. */
export async function isLeadAccessible(companyId: string, leadId: string, branchCondition?: SQL): Promise<boolean> {
  const db = await getDb();
  const conditions = [eq(leads.companyId, companyId), eq(leads.id, leadId)];
  if (branchCondition) conditions.push(branchCondition);
  const rows = await db.select({ id: leads.id }).from(leads).where(and(...conditions)).limit(1);
  return rows.length > 0;
}

export interface InsertLeadFollowUpInput {
  companyId: string;
  leadId: string;
  remarks: string;
  outcome?: string;
  nextFollowUpAt?: Date | null;
  createdBy?: string;
}

/** Logs one follow-up entry, and - only when `nextFollowUpAt` is provided -
 * moves the lead's own `nextFollowUpAt` column forward in the same call, so
 * the Pipeline list's "Next follow-up" column always reflects whatever was
 * most recently set here without the caller needing a second request.
 * Scoped to companyId on every write as defense in depth (the caller has
 * already been authorized via isLeadAccessible above, including branch
 * access, before this is ever invoked). */
export async function insertLeadFollowUp(input: InsertLeadFollowUpInput) {
  const db = await getDb();
  const rows = await db
    .insert(leadFollowUps)
    .values({
      companyId: input.companyId,
      leadId: input.leadId,
      remarks: input.remarks,
      outcome: input.outcome,
      nextFollowUpAt: input.nextFollowUpAt ?? undefined,
      createdBy: input.createdBy,
    })
    .returning();

  if (input.nextFollowUpAt) {
    await db
      .update(leads)
      .set({ nextFollowUpAt: input.nextFollowUpAt, updatedAt: new Date() })
      .where(and(eq(leads.companyId, input.companyId), eq(leads.id, input.leadId)));
  }

  return firstOrThrow(rows);
}

/** Full follow-up history for one lead, newest first, with each entry's
 * author name resolved from `users` (left join - a since-deleted user's
 * entries still show up, just with authorName: null, per createdBy's ON
 * DELETE SET NULL above). */
export async function listLeadFollowUps(companyId: string, leadId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: leadFollowUps.id,
      remarks: leadFollowUps.remarks,
      outcome: leadFollowUps.outcome,
      nextFollowUpAt: leadFollowUps.nextFollowUpAt,
      createdAt: leadFollowUps.createdAt,
      createdBy: leadFollowUps.createdBy,
      authorName: users.fullName,
    })
    .from(leadFollowUps)
    .leftJoin(users, eq(users.id, leadFollowUps.createdBy))
    .where(and(eq(leadFollowUps.companyId, companyId), eq(leadFollowUps.leadId, leadId)))
    .orderBy(desc(leadFollowUps.createdAt));
  return rows;
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
