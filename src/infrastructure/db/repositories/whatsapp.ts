// WhatsApp Lead Capture feature - persistence for discovered WhatsApp
// assets (meta_whatsapp_accounts), resolved lead-approach routing
// (meta_lead_routes), and inbound message durability/idempotency
// (whatsapp_message_events). Mirrors the exact conventions
// src/infrastructure/db/repositories/metaIntegration.ts and metaSync.ts
// already established for their Meta-Instant-Form counterparts - see each
// function's own comment for which one it mirrors.

import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../client";
import { campaigns, leads, metaAdSets, metaAds, metaCampaigns, metaLeadRoutes, metaWhatsappAccounts, whatsappMessageEvents } from "../schema";
import { firstOrThrow } from "../util";
import { isUniqueViolation, scoreLeadSafely, type InsertLeadResult } from "../repositories";

// ---- WhatsApp accounts (mirrors replaceMetaPages/selectMetaPage in metaIntegration.ts) ----

export interface ReplaceMetaWhatsappAccountInput {
  wabaId: string;
  wabaName?: string | null;
  phoneNumberId: string;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
}

/** Upsert every WhatsApp phone number discovered for the tenant's connected
 * Business Manager account(s), keyed on (tenantId, phoneNumberId) - never
 * touches isSelected on a re-sync, same rule replaceMetaPages already
 * follows for Pages. */
export async function replaceMetaWhatsappAccounts(
  tenantId: string,
  connectionId: string,
  accounts: ReplaceMetaWhatsappAccountInput[],
) {
  if (accounts.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .insert(metaWhatsappAccounts)
    .values(
      accounts.map((a) => ({
        tenantId,
        metaConnectionId: connectionId,
        wabaId: a.wabaId,
        wabaName: a.wabaName ?? null,
        phoneNumberId: a.phoneNumberId,
        displayPhoneNumber: a.displayPhoneNumber ?? null,
        verifiedName: a.verifiedName ?? null,
        lastSyncAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [metaWhatsappAccounts.tenantId, metaWhatsappAccounts.phoneNumberId],
      set: {
        wabaId: sql`excluded.waba_id`,
        wabaName: sql`excluded.waba_name`,
        displayPhoneNumber: sql`excluded.display_phone_number`,
        verifiedName: sql`excluded.verified_name`,
        lastSyncAt: sql`excluded.last_sync_at`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows;
}

export async function listMetaWhatsappAccounts(tenantId: string) {
  const db = await getDb();
  return db.select().from(metaWhatsappAccounts).where(eq(metaWhatsappAccounts.tenantId, tenantId));
}

export async function getSelectedMetaWhatsappAccount(tenantId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaWhatsappAccounts)
    .where(and(eq(metaWhatsappAccounts.tenantId, tenantId), eq(metaWhatsappAccounts.isSelected, true)))
    .limit(1);
  return row ?? null;
}

/** Phase 5 selection - single-select per tenant, same sequential
 * "unselect all, then select one" pattern (and the same reasoning for why
 * it's two statements, not one transaction) as selectMetaPage. Auto-selects
 * the tenant's ONLY discovered number automatically the moment discovery
 * finds exactly one - "the user selects a business asset only when a
 * selection is genuinely required" (Phase 5) - so a single-number tenant
 * never has to click anything; see whatsappDiscoveryService.ts. */
export async function selectMetaWhatsappAccount(tenantId: string, whatsappAccountDbId: string) {
  const db = await getDb();
  const [target] = await db
    .select({ id: metaWhatsappAccounts.id })
    .from(metaWhatsappAccounts)
    .where(and(eq(metaWhatsappAccounts.tenantId, tenantId), eq(metaWhatsappAccounts.id, whatsappAccountDbId)))
    .limit(1);
  if (!target) return null;

  await db
    .update(metaWhatsappAccounts)
    .set({ isSelected: false, updatedAt: new Date() })
    .where(eq(metaWhatsappAccounts.tenantId, tenantId));
  const rows = await db
    .update(metaWhatsappAccounts)
    .set({ isSelected: true, updatedAt: new Date() })
    .where(eq(metaWhatsappAccounts.id, target.id))
    .returning();
  return firstOrThrow(rows);
}

/** Resolves an inbound webhook's `metadata.phone_number_id` back to the
 * owning tenant - the SAME "never trust the payload's own claim of who it
 * belongs to, always look up what this system recorded" posture
 * getSubscribedMetaPagesByPageId already uses for the leadgen webhook (see
 * metaLeadEventService.ts). Returns at most the tenants who have this exact
 * phone number SELECTED (isSelected = true) - a discovered-but-unselected
 * number receives no inbound processing, same as an unselected Page never
 * gets subscribed to the leadgen webhook in the first place. */
export async function getTenantsBySelectedWhatsappPhoneNumberId(phoneNumberId: string) {
  const db = await getDb();
  return db
    .select({ tenantId: metaWhatsappAccounts.tenantId, whatsappAccountId: metaWhatsappAccounts.id })
    .from(metaWhatsappAccounts)
    .where(and(eq(metaWhatsappAccounts.phoneNumberId, phoneNumberId), eq(metaWhatsappAccounts.isSelected, true)));
}

// ---- Meta lead routes (Phase 4) --------------------------------------------

export interface UpsertMetaLeadRouteInput {
  metaConnectionId: string | null;
  metaAdAccountId: string | null;
  metaCampaignId: string | null;
  metaAdSetId: string | null;
  metaAdId: string; // metaAds.id (our row id, not Meta's own ad id)
  approach: string; // src/domain/leadApproach.ts LEAD_APPROACHES key
  confidence: string; // src/domain/leadApproach.ts LEAD_APPROACH_CONFIDENCE
  formId?: string | null;
  whatsappAccountId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Upsert one ad's resolved lead-approach route, keyed on (tenantId,
 * metaAdId) - re-resolving an ad (every campaign sync) always refreshes the
 * route in place rather than accumulating history, same "re-sync refreshes,
 * never accumulates" rule metaCampaigns/metaAdSets/metaAds already follow. */
export async function upsertMetaLeadRoute(tenantId: string, input: UpsertMetaLeadRouteInput) {
  const db = await getDb();
  const rows = await db
    .insert(metaLeadRoutes)
    .values({
      tenantId,
      metaConnectionId: input.metaConnectionId,
      metaAdAccountId: input.metaAdAccountId,
      metaCampaignId: input.metaCampaignId,
      metaAdSetId: input.metaAdSetId,
      metaAdId: input.metaAdId,
      approach: input.approach,
      confidence: input.confidence,
      formId: input.formId ?? null,
      whatsappAccountId: input.whatsappAccountId ?? null,
      metadata: input.metadata ?? {},
      resolvedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [metaLeadRoutes.tenantId, metaLeadRoutes.metaAdId],
      set: {
        metaConnectionId: sql`excluded.meta_connection_id`,
        metaAdAccountId: sql`excluded.meta_ad_account_id`,
        metaCampaignId: sql`excluded.meta_campaign_id`,
        metaAdSetId: sql`excluded.meta_ad_set_id`,
        approach: sql`excluded.approach`,
        confidence: sql`excluded.confidence`,
        formId: sql`excluded.form_id`,
        whatsappAccountId: sql`excluded.whatsapp_account_id`,
        metadata: sql`excluded.metadata`,
        resolvedAt: sql`excluded.resolved_at`,
        status: sql`'active'`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return firstOrThrow(rows);
}

/** Looks up an ad's resolved route by Meta's OWN ad id (as an incoming
 * WhatsApp referral.source_id carries it) - how
 * processWhatsAppMessageEvent.ts recovers campaign/ad-set/campaign
 * attribution for an inbound message without re-calling the Graph API on
 * every event (Phase 4's whole point). Joins all the way out to the ad set,
 * Meta campaign, and (if mapped) CRM campaign/branch in one query - the same
 * "resolved once at sync time, never re-derived" data
 * metaCampaignService.ts already persisted when it first resolved this ad's
 * lead approach, so this pipeline needs no Graph API call of its own. */
export async function getMetaLeadRouteByMetaAdId(tenantId: string, metaAdId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      route: metaLeadRoutes,
      adId: metaAds.adId,
      adName: metaAds.adName,
      adSetId: metaAdSets.adSetId,
      adSetName: metaAdSets.adSetName,
      campaignId: metaCampaigns.metaCampaignId,
      campaignName: metaCampaigns.name,
      crmCampaignId: metaCampaigns.crmCampaignId,
      crmCampaignBranchId: campaigns.branchId,
    })
    .from(metaLeadRoutes)
    .innerJoin(metaAds, eq(metaLeadRoutes.metaAdId, metaAds.id))
    .leftJoin(metaAdSets, eq(metaLeadRoutes.metaAdSetId, metaAdSets.id))
    .leftJoin(metaCampaigns, eq(metaLeadRoutes.metaCampaignId, metaCampaigns.id))
    .leftJoin(campaigns, eq(metaCampaigns.crmCampaignId, campaigns.id))
    .where(and(eq(metaLeadRoutes.tenantId, tenantId), eq(metaAds.adId, metaAdId)))
    .limit(1);
  return row ?? null;
}

/** Aggregate counts for the Settings "Lead approaches detected" summary
 * (Phase 19/20) - "12 Instant Form ads, 5 WhatsApp ads". */
export async function countMetaLeadRoutesByApproach(tenantId: string) {
  const db = await getDb();
  const rows = await db
    .select({ approach: metaLeadRoutes.approach, count: sql<number>`count(*)::int` })
    .from(metaLeadRoutes)
    .where(eq(metaLeadRoutes.tenantId, tenantId))
    .groupBy(metaLeadRoutes.approach);
  return rows;
}

// ---- WhatsApp message events (Phase 6/7 - webhook durability + idempotency) ----

export interface RecordWhatsappMessageEventInput {
  tenantId: string;
  waMessageId: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  fromPhoneNumber: string | null;
  contactName: string | null;
  messageType: string | null;
  messageText: string | null;
  referral: Record<string, unknown> | null;
  rawPayload: unknown;
}

/** Persist ONE inbound WhatsApp message event BEFORE acking the webhook -
 * mirrors recordMetaLeadEvent's onConflictDoNothing exactly: a redelivered
 * webhook (same tenantId + waMessageId) is silently absorbed here, never
 * inserted twice, which is the actual idempotency backstop (Phase 7) - the
 * later Lead insert is guarded independently too (see insertWhatsappLead),
 * defense in depth the same way meta_lead_events + leads.metaLeadId both
 * guard the Instant Form pipeline. Returns null when this exact event was
 * already recorded (the conflict path), so the caller can distinguish
 * "brand new, enqueue it" from "already seen, nothing more to do" without a
 * second query. */
export async function recordWhatsappMessageEvent(input: RecordWhatsappMessageEventInput) {
  const db = await getDb();
  const rows = await db
    .insert(whatsappMessageEvents)
    .values({
      tenantId: input.tenantId,
      waMessageId: input.waMessageId,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      fromPhoneNumber: input.fromPhoneNumber,
      contactName: input.contactName,
      messageType: input.messageType,
      messageText: input.messageText,
      referral: input.referral,
      rawPayload: input.rawPayload,
      status: "received",
    })
    .onConflictDoNothing({ target: [whatsappMessageEvents.tenantId, whatsappMessageEvents.waMessageId] })
    .returning();
  return rows[0] ?? null;
}

export async function markWhatsappMessageEventEnqueued(id: string) {
  const db = await getDb();
  await db.update(whatsappMessageEvents).set({ status: "enqueued", updatedAt: new Date() }).where(eq(whatsappMessageEvents.id, id));
}

export async function markWhatsappMessageEventProcessing(id: string) {
  const db = await getDb();
  await db.update(whatsappMessageEvents).set({ status: "processing", updatedAt: new Date() }).where(eq(whatsappMessageEvents.id, id));
}

export async function markWhatsappMessageEventDuplicate(id: string) {
  const db = await getDb();
  await db
    .update(whatsappMessageEvents)
    .set({ status: "duplicate", processedAt: new Date(), updatedAt: new Date() })
    .where(eq(whatsappMessageEvents.id, id));
}

export async function markWhatsappMessageEventCompleted(id: string) {
  const db = await getDb();
  await db
    .update(whatsappMessageEvents)
    .set({ status: "completed", processedAt: new Date(), updatedAt: new Date() })
    .where(eq(whatsappMessageEvents.id, id));
}

export async function markWhatsappMessageEventRetrying(id: string, error: string) {
  const db = await getDb();
  await db
    .update(whatsappMessageEvents)
    .set({ status: "retrying", errorMessage: error, retryCount: sql`${whatsappMessageEvents.retryCount} + 1`, updatedAt: new Date() })
    .where(eq(whatsappMessageEvents.id, id));
}

export async function markWhatsappMessageEventFailed(id: string, error: string) {
  const db = await getDb();
  await db
    .update(whatsappMessageEvents)
    .set({ status: "failed", errorMessage: error, updatedAt: new Date() })
    .where(eq(whatsappMessageEvents.id, id));
}

export async function getWhatsappMessageEventById(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(whatsappMessageEvents).where(eq(whatsappMessageEvents.id, id)).limit(1);
  return row ?? null;
}

/**
 * Phase 13 (Background Synchronization) - the WhatsApp counterpart to
 * getUnenqueuedMetaLeadEvents: events durably stored by the webhook
 * receiver but never confirmed enqueued for processing (the QStash publish
 * call itself failed, or the process was cut off between the durability
 * write and the publish call). Reused by reconcile.ts's runReconciliation
 * on the same 15-minute sweep. Deliberately does NOT attempt a
 * "missing WhatsApp messages" scan the way the Instant Form pipeline scans
 * Meta's /leads endpoint for leads the webhook never delivered at all -
 * the WhatsApp Cloud API has no equivalent "list recent messages" endpoint
 * to page through (messages exist ONLY as webhook deliveries, there is
 * nothing else to reconcile against), so retrying a captured-but-unenqueued
 * event is the full extent of what this pipeline can self-heal.
 */
export async function getUnenqueuedWhatsappMessageEvents(olderThanMinutes: number) {
  const db = await getDb();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
  return db
    .select()
    .from(whatsappMessageEvents)
    .where(and(eq(whatsappMessageEvents.status, "received"), lt(whatsappMessageEvents.receivedAt, cutoff)))
    .limit(500);
}

// ---- Lead creation (Phase 8) ------------------------------------------------

export interface InsertWhatsappLeadInput {
  tenantId: string;
  waMessageId: string; // becomes leads.metaLeadId as `whatsapp:<waMessageId>` - see this function's own comment
  fromPhoneNumber: string;
  contactName: string | null;
  messageText: string | null;
  // Attribution, resolved (if at all) from the message's referral.source_id
  // against meta_lead_routes/meta_ads/meta_ad_sets/meta_campaigns - see
  // processWhatsAppMessageEvent.ts. All null = "Unknown / Organic WhatsApp"
  // (Phase 9) - never guessed.
  adId: string | null;
  adName: string | null;
  adSetId: string | null;
  adSetName: string | null;
  campaignId: string | null;
  campaignName: string | null;
  crmCampaignId: string | null;
  branchId: string | null;
}

/**
 * Inserts a WhatsApp-originated lead into the SAME `leads` table every
 * other channel uses - "Do not create a separate WhatsAppLead entity"
 * (NON-NEGOTIABLE requirement #1/#2/#8). `source` is set to "whatsapp"
 * (already an existing, valid entry in LEAD_SOURCES - "extend the existing
 * source field rather than creating redundant fields" is satisfied by
 * reusing it, not by inventing a new "META" source bucket the current
 * catalog doesn't have); `leadApproach` is set to "whatsapp" (Phase 1's new
 * orthogonal axis). `platform`/`pageId`/`formId`/`formName` are left null -
 * those are Meta-Instant-Form-specific concepts a WhatsApp lead has no
 * equivalent for.
 *
 * Idempotency key: `whatsapp:<waMessageId>` - Meta's OWN message id, a
 * REAL stable external identifier (unlike insertManualLead/insertFormLead's
 * synthetic `manual:<uuid>`/`form:<uuid>`, which the Phase 0 audit flagged
 * as giving those paths no genuine redelivery protection). This means a
 * WhatsApp lead gets the exact same "a duplicate insert is silently a
 * duplicate, never an error" guarantee the Instant Form pipeline already
 * has, via the identical `ux_leads_meta_lead_id` unique index - caught here
 * as isUniqueViolation, exactly like insertMetaSyncLead does.
 *
 * "Do not require email. Do not invent missing customer information" -
 * email is simply never set; fullName falls back to the phone number only
 * if WhatsApp genuinely returned no profile name, never a placeholder like
 * "Unknown".
 *
 * Quality-scored via the SAME scoreLeadSafely every other digital-lead
 * insert path uses (insertLead, insertMetaSyncLead) - a WhatsApp lead
 * arrived automatically, exactly like a Meta Instant Form lead, so it gets
 * the same treatment; only insertManualLead (a human already vetted the
 * record) skips this. Returns the same InsertLeadResult shape as
 * insertMetaSyncLead so callers (processWhatsAppMessageEvent.ts) handle
 * both pipelines' outcomes identically.
 */
export async function insertWhatsappLead(input: InsertWhatsappLeadInput): Promise<InsertLeadResult> {
  const db = await getDb();
  const fullName = input.contactName ?? input.fromPhoneNumber;
  const quality = await scoreLeadSafely(input.tenantId, fullName, null, input.fromPhoneNumber, []);
  try {
    const rows = await db
      .insert(leads)
      .values({
        companyId: input.tenantId,
        branchId: input.branchId,
        crmCampaignId: input.crmCampaignId,
        metaLeadId: `whatsapp:${input.waMessageId}`,
        platform: null,
        pageId: null,
        formId: null,
        formName: null,
        adId: input.adId,
        adName: input.adName,
        adSetId: input.adSetId,
        adSetName: input.adSetName,
        campaignId: input.campaignId,
        campaignName: input.campaignName,
        fullName,
        email: null,
        phoneNumber: input.fromPhoneNumber,
        formResponses: [],
        source: "whatsapp",
        leadApproach: "whatsapp",
        leadType: "digital_lead",
        notes: input.messageText ? `First message: ${input.messageText}` : null,
        customFields: input.messageText ? { firstMessage: input.messageText } : {},
        metaCreatedAt: new Date(),
        status: "processed",
        processedAt: new Date(),
        pipelineStage: "new",
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
