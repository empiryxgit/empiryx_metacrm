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

/** Internal lookup for the webhook-subscribe pipeline - tenant-scoped, same
 * "ensure all records belong to the current tenant" posture as
 * getMetaPageInternal (metaIntegration.ts). Returns the row as-is (unlike
 * getMetaPageInternal, there's no per-account access token to decrypt - see
 * subscribeWabaToApp's own comment on graphClient.ts for why). */
export async function getMetaWhatsappAccountInternal(tenantId: string, whatsappAccountDbId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaWhatsappAccounts)
    .where(and(eq(metaWhatsappAccounts.tenantId, tenantId), eq(metaWhatsappAccounts.id, whatsappAccountDbId)))
    .limit(1);
  return row ?? null;
}

/** Records a successful WhatsApp webhook subscribe - mirrors
 * markPageWebhookActive (metaIntegration.ts) exactly. */
export async function markWhatsappAccountWebhookActive(id: string) {
  const db = await getDb();
  await db
    .update(metaWhatsappAccounts)
    .set({ webhookSubscribed: true, webhookStatus: "active", webhookLastVerifiedAt: new Date(), webhookLastError: null, updatedAt: new Date() })
    .where(eq(metaWhatsappAccounts.id, id));
}

/** Records a failed WhatsApp webhook subscribe attempt - mirrors
 * markPageWebhookFailed (metaIntegration.ts) exactly. Never thrown further -
 * a subscribe failure is recorded and surfaced (Settings, Retry), never
 * left silent, but also never breaks the Meta connection itself. */
export async function markWhatsappAccountWebhookFailed(id: string, error: string) {
  const db = await getDb();
  await db
    .update(metaWhatsappAccounts)
    .set({ webhookSubscribed: false, webhookStatus: "failed", webhookLastError: error, updatedAt: new Date() })
    .where(eq(metaWhatsappAccounts.id, id));
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

/** "Meta Campaign Destination Detection" reframing, Phase 17 - every
 * currently-active ad this tenant's own resolver classified as
 * approach="whatsapp" (see metaLeadApproachResolver.ts - never a name
 * match, always destination_type="WHATSAPP" or an already-known number),
 * with Meta's own raw ad id (needed to call graphClient.getAdInsights) and
 * enough display context for a report row. Feeds
 * metaAdInteractionService.ts's aggregate-interaction summary - this list
 * is exactly "every ad Meta itself says is a WhatsApp destination", the
 * same set metaLeadRoutes already tracks for real Lead attribution, reused
 * here for the separate aggregate-metric side of the picture. */
export async function listWhatsappRoutedAds(tenantId: string) {
  const db = await getDb();
  return db
    .select({
      metaAdId: metaAds.adId,
      adName: metaAds.adName,
      campaignName: metaCampaigns.name,
    })
    .from(metaLeadRoutes)
    .innerJoin(metaAds, eq(metaLeadRoutes.metaAdId, metaAds.id))
    .leftJoin(metaCampaigns, eq(metaLeadRoutes.metaCampaignId, metaCampaigns.id))
    .where(and(eq(metaLeadRoutes.tenantId, tenantId), eq(metaLeadRoutes.approach, "whatsapp"), eq(metaLeadRoutes.status, "active")));
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

/** BLOCKED - same Phase 16 entitlement rule as markMetaLeadEventBlocked in
 * metaLeadEvents.ts: a legitimate, non-failure terminal outcome for a
 * message that arrived while the tenant's account was
 * trial_expired/subscription_expired. Never retried. */
export async function markWhatsappMessageEventBlocked(id: string) {
  const db = await getDb();
  await db
    .update(whatsappMessageEvents)
    .set({ status: "blocked", processedAt: new Date(), updatedAt: new Date() })
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

// ---- Internal WhatsApp Query Bot -------------------------------------------
// Persistence for whatsapp_link_codes + user_whatsapp_links. See
// claude/whatsapp-internal-query-bot-flow.md (CRM Automation project) for
// the full design; src/application/metaSync/whatsappQueryBot.ts is the only
// caller of everything below.

import { desc, gt, isNull } from "drizzle-orm";
import { roles, userWhatsappLinks, users, whatsappLinkCodes } from "../schema";

const LINK_CODE_TTL_MINUTES = 10;
const LINK_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I - avoids misread-over-WhatsApp codes
const PENDING_QUERY_CONTEXT_TTL_MINUTES = 3;

function generateLinkCode(length = 6): string {
  let code = "";
  for (let i = 0; i < length; i++) code += LINK_CODE_ALPHABET[Math.floor(Math.random() * LINK_CODE_ALPHABET.length)];
  return code;
}

/** Settings -> "Generate linking code". A user may only ever have one live
 * (unconsumed, unexpired) code at a time - generating a new one supersedes
 * any prior one rather than accumulating them. */
export async function createWhatsappLinkCode(tenantId: string, userId: string): Promise<{ code: string; expiresAt: Date }> {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60_000);
  // Best-effort cleanup of this user's prior unconsumed codes - not load-
  // bearing (consumeWhatsappLinkCode always filters expiresAt/consumedAt
  // itself), just keeps the table from accumulating dead rows per user.
  await db
    .update(whatsappLinkCodes)
    .set({ consumedAt: new Date() })
    .where(and(eq(whatsappLinkCodes.tenantId, tenantId), eq(whatsappLinkCodes.userId, userId), isNull(whatsappLinkCodes.consumedAt)));

  // Collision retry - astronomically unlikely (33^6 codespace) but a
  // unique-constraint-free `code` column means a collision would otherwise
  // silently let two users share one code, so guard it anyway.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateLinkCode();
    const existing = await db
      .select({ id: whatsappLinkCodes.id })
      .from(whatsappLinkCodes)
      .where(and(eq(whatsappLinkCodes.code, code), gt(whatsappLinkCodes.expiresAt, new Date())))
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(whatsappLinkCodes).values({ tenantId, userId, code, expiresAt });
    return { code, expiresAt };
  }
  throw new Error("Could not generate a unique WhatsApp link code after 5 attempts.");
}

export interface ConsumeLinkCodeResult {
  ok: boolean;
  userId?: string;
  reason?: "not_found" | "expired" | "phone_taken";
}

/** Redeems a "LINK <code>" message. Scoped to the tenant the inbound
 * message itself was already resolved against (never trusts the payload
 * for tenant identity - same rule the rest of this file follows) - a code
 * from tenant A can never be redeemed against tenant B's WhatsApp number.
 * Binds phoneNumber -> userId via upsertUserWhatsappLink; "phone_taken"
 * means a DIFFERENT user in this tenant already has that number linked. */
export async function consumeWhatsappLinkCode(tenantId: string, code: string, phoneNumber: string): Promise<ConsumeLinkCodeResult> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(whatsappLinkCodes)
    .where(and(eq(whatsappLinkCodes.tenantId, tenantId), eq(whatsappLinkCodes.code, code.toUpperCase()), isNull(whatsappLinkCodes.consumedAt)))
    .orderBy(desc(whatsappLinkCodes.createdAt))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.expiresAt.getTime() < Date.now()) return { ok: false, reason: "expired" };

  const bind = await upsertUserWhatsappLink(tenantId, row.userId, phoneNumber);
  if (!bind.ok) return { ok: false, reason: "phone_taken" };

  await db.update(whatsappLinkCodes).set({ consumedAt: new Date() }).where(eq(whatsappLinkCodes.id, row.id));
  return { ok: true, userId: row.userId };
}

export interface UpsertLinkResult {
  ok: boolean;
  reason?: "phone_taken";
}

/** Binds phoneNumber -> userId, superseding any number this SAME user had
 * previously linked (re-linking from a new phone just moves the binding).
 * Fails with "phone_taken" if that number is already bound to a DIFFERENT
 * user in this tenant - never silently reassigns another person's number. */
export async function upsertUserWhatsappLink(tenantId: string, userId: string, phoneNumber: string): Promise<UpsertLinkResult> {
  const db = await getDb();
  try {
    await db
      .insert(userWhatsappLinks)
      .values({ tenantId, userId, phoneNumber, linkedAt: new Date() })
      .onConflictDoUpdate({
        target: [userWhatsappLinks.tenantId, userWhatsappLinks.userId],
        set: { phoneNumber, linkedAt: new Date(), updatedAt: new Date(), pendingQueryContext: null, pendingQueryContextExpiresAt: null },
      });
    return { ok: true };
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "phone_taken" };
    throw err;
  }
}

export async function deleteUserWhatsappLink(tenantId: string, userId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .delete(userWhatsappLinks)
    .where(and(eq(userWhatsappLinks.tenantId, tenantId), eq(userWhatsappLinks.userId, userId)))
    .returning();
  return rows.length > 0;
}

/** THE identity check every inbound WhatsApp message runs first (see
 * metaWhatsappEventService.ts's captureWhatsappEvents) - a verified match
 * here is what routes a message to the query bot instead of lead-capture. */
export async function getUserWhatsappLinkByPhone(tenantId: string, phoneNumber: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(userWhatsappLinks)
    .where(and(eq(userWhatsappLinks.tenantId, tenantId), eq(userWhatsappLinks.phoneNumber, phoneNumber)))
    .limit(1);
  return row ?? null;
}

export async function getUserWhatsappLinkByUserId(tenantId: string, userId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(userWhatsappLinks)
    .where(and(eq(userWhatsappLinks.tenantId, tenantId), eq(userWhatsappLinks.userId, userId)))
    .limit(1);
  return row ?? null;
}

/** Sets/overwrites the numbered-list disambiguation state for this SAME
 * user's own thread only (scoped by the tenantId+userId primary lookup key
 * already on the row) - a fresh question always simply overwrites whatever
 * was pending, never accumulates. */
export async function setPendingQueryContext(tenantId: string, userId: string, context: unknown): Promise<void> {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + PENDING_QUERY_CONTEXT_TTL_MINUTES * 60_000);
  await db
    .update(userWhatsappLinks)
    .set({ pendingQueryContext: context, pendingQueryContextExpiresAt: expiresAt, updatedAt: new Date() })
    .where(and(eq(userWhatsappLinks.tenantId, tenantId), eq(userWhatsappLinks.userId, userId)));
}

export async function clearPendingQueryContext(tenantId: string, userId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(userWhatsappLinks)
    .set({ pendingQueryContext: null, pendingQueryContextExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(userWhatsappLinks.tenantId, tenantId), eq(userWhatsappLinks.userId, userId)));
}

/** For the query bot's authorization check (§4) - the user's role
 * permissions, fetched fresh from the DB rather than a JWT (the bot has no
 * session token, only the verified phone->userId binding). Tenant-scoped
 * defensively, same "never trust an id in isolation" posture as the rest
 * of this file. */
export async function getUserRoleAndPermissions(tenantId: string, userId: string): Promise<{ fullName: string; permissions: string[] } | null> {
  const db = await getDb();
  const [row] = await db
    .select({ fullName: users.fullName, permissions: roles.permissions })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.companyId, tenantId), eq(users.id, userId), eq(users.status, "active")))
    .limit(1);
  if (!row) return null;
  return { fullName: row.fullName, permissions: (row.permissions as string[] | null) ?? [] };
}
