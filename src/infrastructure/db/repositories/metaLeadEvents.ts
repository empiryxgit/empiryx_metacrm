// Repository for crm.meta_lead_events (Phase 2 schema) - durable capture of
// every incoming Meta leadgen webhook event (see api/webhooks/meta/handler.ts's
// leadgen resource, via src/application/metaSync/metaLeadEventService.ts),
// PLUS (as of the "automatic campaign sync" UI change) the dedicated lead-write
// path that turns a captured event into an actual crm.leads row - see
// insertMetaSyncLead below and src/application/metaSync/processMetaLeadEvent.ts,
// the tenant-level counterpart to the legacy src/application/processLead.ts.

import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../client";
import { leads, metaLeadEvents, metaPages } from "../schema";
import { firstOrThrow } from "../util";
import { isUniqueViolation, type InsertLeadResult } from "../repositories";

/**
 * Which tenant(s) currently own this Meta Page, for routing an incoming
 * page-level webhook event (identified only by Meta's own page id - the
 * payload carries no tenant info at all). Scoped to
 * webhookSubscribed=true - a Page this tenant synced but never
 * selected/subscribed should never receive events attributed to it.
 * Normally exactly one row (a given Meta Page is realistically connected
 * by one tenant's OAuth grant), but this returns every match rather than
 * assuming that, since nothing prevents it in principle.
 */
export async function getSubscribedMetaPagesByPageId(pageId: string) {
  const db = await getDb();
  return db
    .select()
    .from(metaPages)
    .where(and(eq(metaPages.pageId, pageId), eq(metaPages.webhookSubscribed, true)));
}

export interface RecordMetaLeadEventInput {
  tenantId: string;
  leadgenId: string;
  pageId: string | null;
  formId: string | null;
  adId: string | null;
  adsetId: string | null;
  campaignId: string | null;
  rawPayload: unknown;
}

/**
 * Inserts one captured leadgen event, keyed on the (tenantId, leadgenId)
 * unique index - a redelivered or duplicate Meta webhook call for an event
 * already captured for this tenant is silently a no-op (onConflictDoNothing),
 * not an error: idempotency here, not "did this insert something new".
 * Returns the new row's id if one was actually inserted (so the caller can
 * enqueue it for processing), or null if this was a duplicate.
 */
export async function recordMetaLeadEvent(input: RecordMetaLeadEventInput): Promise<string | null> {
  const db = await getDb();
  const rows = await db
    .insert(metaLeadEvents)
    .values({
      tenantId: input.tenantId,
      leadgenId: input.leadgenId,
      pageId: input.pageId,
      formId: input.formId,
      adId: input.adId,
      adsetId: input.adsetId,
      campaignId: input.campaignId,
      rawPayload: input.rawPayload,
      status: "received",
    })
    .onConflictDoNothing({ target: [metaLeadEvents.tenantId, metaLeadEvents.leadgenId] })
    .returning();
  return rows[0]?.id ?? null;
}

/**
 * Phase 13 - looks up an existing event by the exact same (tenantId,
 * leadgenId) idempotency key recordMetaLeadEvent's unique index enforces.
 * Used only on the "already exists" branch of the webhook flow (Meta
 * redelivered leadgen_id): lets the caller tell "already fully handled -
 * safely ignore" apart from "captured but never confirmed enqueued -
 * safe to reprocess right now" (see captureLeadgenEvents's own comment).
 */
export async function getMetaLeadEventByTenantAndLeadgenId(tenantId: string, leadgenId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaLeadEvents)
    .where(and(eq(metaLeadEvents.tenantId, tenantId), eq(metaLeadEvents.leadgenId, leadgenId)))
    .limit(1);
  return row ?? null;
}

/**
 * Phase 19 (tenant isolation audit) - scoped by tenantId as well as id,
 * matching this file's own getMetaLeadEventByTenantAndLeadgenId. `id`
 * here comes from the same QStash message as `tenantId` (both set,
 * together, by enqueueCapturedLeadgenEvents right after
 * captureLeadgenEvents inserted this exact row for this exact tenant) and
 * the two should always already agree; scoping anyway means a future bug
 * that ever let them diverge fails closed (returns null - the caller's
 * existing "event not found" error path) instead of silently processing a
 * DIFFERENT tenant's lead event under the wrong tenant context. "Every
 * Meta record must belong to the correct tenant" - enforced here, not
 * just assumed.
 */
export async function getMetaLeadEventById(tenantId: string, id: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaLeadEvents)
    .where(and(eq(metaLeadEvents.tenantId, tenantId), eq(metaLeadEvents.id, id)))
    .limit(1);
  return row ?? null;
}

/**
 * Phase 11 - events durably stored by the webhook receiver but never
 * confirmed enqueued for processing (the QStash publish call itself
 * failed, or the process was cut off between the durability write and the
 * publish call). Same shape as repositories.ts's getUnenqueuedRawEvents
 * for the legacy pipeline, deliberately reusing status "received" as the
 * sentinel rather than adding a distinct "enqueue_failed" state (and a
 * migration for it): a row this query finds is retried by
 * reconcile.ts's runReconciliation, which leaves it at "received" again on
 * a repeat failure - a future sweep will simply pick it up again once
 * `olderThanMinutes` has passed once more. Global across tenants
 * deliberately, same reasoning as the raw-event sweep - each row already
 * carries its own tenantId for routing.
 */
export async function getUnenqueuedMetaLeadEvents(olderThanMinutes: number) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return db
    .select()
    .from(metaLeadEvents)
    .where(and(eq(metaLeadEvents.status, "received"), lt(metaLeadEvents.receivedAt, cutoff)))
    .limit(500);
}

/** Set right after a successful (best-effort) QStash publish - mirrors
 * rawMetaEvents' "received" -> "enqueued" transition for the legacy
 * pipeline. If the publish itself fails, the row is deliberately left at
 * "received" rather than marked anything - "do not silently fail" means a
 * failed enqueue must stay visibly unprocessed, not get relabeled as done. */
export async function markMetaLeadEventEnqueued(id: string) {
  const db = await getDb();
  await db.update(metaLeadEvents).set({ status: "enqueued", updatedAt: new Date() }).where(eq(metaLeadEvents.id, id));
}

/**
 * Phase 14 - the Background Worker's very first write, before it does
 * anything else (before the Meta API call, before any DB write of its
 * own): flips the event from "enqueued" (queued, not yet picked up) to
 * "processing" (a worker is actively on it right now). This is the one
 * genuinely new state in the RECEIVED -> PROCESSING -> COMPLETED / FAILED
 * (with RETRYING in between on a recoverable failure) status machine - it
 * gives real-time visibility into "is something actually working on this"
 * that "enqueued" alone can't: an event stuck at "enqueued" means the
 * worker hasn't started yet (or died before this line ran); one stuck at
 * "processing" past a reasonable window means a worker started but never
 * finished (crashed mid-flight) - two different operational pictures that
 * collapsing them into one status would hide.
 */
export async function markMetaLeadEventProcessing(id: string) {
  const db = await getDb();
  await db.update(metaLeadEvents).set({ status: "processing", updatedAt: new Date() }).where(eq(metaLeadEvents.id, id));
}

/** COMPLETED - the lead was created (or the outcome was a legitimate
 * duplicate, see markMetaLeadEventDuplicate) and there is nothing more for
 * the worker to do. Renamed from markMetaLeadEventProcessed (Phase
 * 2-13's name) to match Phase 14's explicit status vocabulary; same
 * behavior. */
export async function markMetaLeadEventCompleted(id: string) {
  const db = await getDb();
  await db
    .update(metaLeadEvents)
    .set({ status: "completed", processedAt: new Date(), updatedAt: new Date() })
    .where(eq(metaLeadEvents.id, id));
}

export async function markMetaLeadEventDuplicate(id: string) {
  const db = await getDb();
  await db
    .update(metaLeadEvents)
    .set({ status: "duplicate", processedAt: new Date(), updatedAt: new Date() })
    .where(eq(metaLeadEvents.id, id));
}

/**
 * RETRYING - THIS attempt failed, but it is not the end of the story:
 * QStash still has retry attempts left (see publishTenantLeadReceived's
 * `retries: 5`) and will re-invoke the worker with backoff. Renamed from
 * markMetaLeadEventFailed (Phase 2-13's name) specifically to stop
 * conflating "one attempt failed, more are coming" with the terminal,
 * retries-exhausted state below - which is what "FAILED" means in Phase
 * 14's vocabulary. retryCount is this row's own count of how many times
 * this has happened, independent of QStash's own attempt counter.
 */
export async function markMetaLeadEventRetrying(id: string, error: string) {
  const db = await getDb();
  await db
    .update(metaLeadEvents)
    .set({
      status: "retrying",
      errorMessage: error,
      retryCount: sql`${metaLeadEvents.retryCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(metaLeadEvents.id, id));
}

/**
 * FAILED (terminal) - QStash's failureCallback target for this pipeline,
 * called exactly once when every retry attempt is exhausted (see
 * publishTenantLeadReceived's `retries: 5` - "reasonable limits": five
 * attempts with QStash's own exponential backoff, then this). Recorded
 * here (never on a leads row, since one was never created for a lead that
 * never finished processing) so it stays visible on the event that
 * actually failed - "never silently discard an event" means this terminal
 * state must still be durably recorded, not just logged. Named
 * markMetaLeadEventFailed (not ...DeadLettered, its Phase 2-13 name) to
 * match Phase 14's status vocabulary directly - the function still fires
 * from the exact same place (the dead-letter callback).
 */
export async function markMetaLeadEventFailed(id: string, error: string) {
  const db = await getDb();
  await db
    .update(metaLeadEvents)
    .set({ status: "failed", errorMessage: error, updatedAt: new Date() })
    .where(eq(metaLeadEvents.id, id));
}

// ---- Lead write path (tenant-level automatic sync pipeline) --------------

export interface InsertMetaSyncLeadInput {
  companyId: string;
  branchId: string | null;
  crmCampaignId: string | null; // null when no synced CRM campaign matched yet (lead is still captured, just unmapped)
  metaLeadId: string;
  platform: string;
  pageId: string;
  formId: string;
  // Phase 12 - the form's own display name (resolveLeadFields.ts), not
  // returned by Meta's leadgen API itself - see that resolver's own
  // comment.
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
  // don't target a system column (see resolveLeadFields.ts).
  customFields?: Record<string, unknown>;
  formResponses: unknown;
  metaCreatedAt: Date;
}

/**
 * The tenant-level pipeline's own lead-write path - deliberately separate
 * from repositories.ts's insertLead rather than loosening that one's
 * required crmCampaignId/rawEventId, since those ARE required for the
 * legacy per-campaign pipeline and this is a genuinely different caller
 * (no raw_meta_events row behind this - meta_lead_events IS this
 * pipeline's durability record, referenced by id from the caller, not by
 * a column on `leads` itself). Same idempotency contract as insertLead:
 * the unique index on leads.meta_lead_id is authoritative, a violation
 * here is a normal duplicate outcome, never an error.
 */
export async function insertMetaSyncLead(input: InsertMetaSyncLeadInput): Promise<InsertLeadResult> {
  const db = await getDb();
  try {
    const rows = await db
      .insert(leads)
      .values({
        companyId: input.companyId,
        branchId: input.branchId,
        crmCampaignId: input.crmCampaignId,
        metaLeadId: input.metaLeadId,
        platform: input.platform,
        pageId: input.pageId,
        formId: input.formId,
        formName: input.formName,
        adId: input.adId,
        adName: input.adName,
        adSetId: input.adSetId,
        adSetName: input.adSetName,
        campaignId: input.campaignId,
        campaignName: input.campaignName,
        fullName: input.fullName,
        email: input.email,
        phoneNumber: input.phoneNumber,
        customFields: input.customFields ?? {},
        formResponses: input.formResponses as object,
        source: "meta_lead_ads",
        leadType: "digital_lead",
        metaCreatedAt: input.metaCreatedAt,
        rawEventId: null, // no raw_meta_events row behind this pipeline - see comment above
        status: "processed",
        processedAt: new Date(),
      })
      .returning();
    return { outcome: "inserted", id: firstOrThrow(rows).id };
  } catch (err) {
    if (isUniqueViolation(err)) return { outcome: "duplicate" };
    throw err;
  }
}
