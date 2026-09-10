// Phase 6 (persistence), reworked in Phase 9 - the Meta asset hierarchy
// synced under a tenant's SELECTED ad account/Page now hangs off its own
// first-class `metaCampaigns` table (see src/infrastructure/db/schema.ts)
// instead of the CRM `campaigns` table. A Meta campaign is only ever
// CONNECTED to a CRM campaign via metaCampaigns.crmCampaignId, an explicit,
// independent mapping - never created/renamed/deleted by the sync. Ad Sets
// and Ads hang off metaCampaigns; Lead Forms reuse metaForms (already
// Page-scoped since Phase 2). Everything Meta-sync-shaped still lives in
// this one file.

import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../client";
import { campaigns, metaAdSets, metaAds, metaCampaigns, metaForms } from "../schema";

/** Meta's own campaign/ad-set/ad status strings (ACTIVE/PAUSED/ARCHIVED/
 * DELETED/...) normalized to lowercase for storage - no DB enum, same
 * "not a fixed catalog" convention as every other status column in this
 * schema, so a status value Meta adds later doesn't need a migration. */
function normalizeMetaStatus(status: string): string {
  return status.toLowerCase();
}

// ---- Meta Campaigns (first-class, Phase 9) ---------------------------------

export interface UpsertMetaCampaignInput {
  metaCampaignId: string;
  name: string;
  metaStatus: string;
  // Meta's own campaign schedule (Graph API start_time/stop_time, ISO
  // strings) - null/undefined stopTime means Meta itself reports no end
  // date configured, not a missing fetch.
  startTime?: string | null;
  stopTime?: string | null;
}

/**
 * Upsert one synced Meta campaign, keyed on the (tenantId, metaCampaignId)
 * unique index (`ux_meta_campaigns_tenant_meta_campaign`). A re-sync only
 * ever refreshes name/status/metaAdAccountId/lastSyncAt - crmCampaignId is
 * NEVER touched here, on insert (defaults to null/"unmapped") or on
 * conflict, since the CRM mapping is owned entirely by an explicit action
 * (see mapMetaCampaignToCrmCampaign), never implicitly by this upsert.
 * That explicit action is usually a person (meta-campaign.html), but as of
 * the sync's own auto-map-on-first-sync step (see
 * syncCampaignsForSelectedAdAccount in metaCampaignService.ts, which calls
 * this function then separately checks "was this row brand new?" before
 * ever calling mapMetaCampaignToCrmCampaign itself) it can also be the
 * sync bootstrapping a brand-new campaign - the contract this comment
 * describes ("never implicitly, only via an explicit call") still holds
 * either way; only WHO calls that explicit function has widened.
 */
export async function upsertMetaCampaign(tenantId: string, adAccountRowId: string, input: UpsertMetaCampaignInput) {
  const db = await getDb();
  const rows = await db
    .insert(metaCampaigns)
    .values({
      tenantId,
      metaAdAccountId: adAccountRowId,
      metaCampaignId: input.metaCampaignId,
      name: input.name,
      status: normalizeMetaStatus(input.metaStatus),
      startTime: input.startTime ? new Date(input.startTime) : null,
      stopTime: input.stopTime ? new Date(input.stopTime) : null,
      lastSyncAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [metaCampaigns.tenantId, metaCampaigns.metaCampaignId],
      set: {
        name: sql`excluded.name`,
        status: sql`excluded.status`,
        metaAdAccountId: sql`excluded.meta_ad_account_id`,
        startTime: sql`excluded.start_time`,
        stopTime: sql`excluded.stop_time`,
        lastSyncAt: sql`excluded.last_sync_at`,
        updatedAt: new Date(),
      },
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Expected upsertMetaCampaign to return a row");
  return row;
}

/**
 * Resolves a synced Meta campaign by Meta's OWN campaign id, joined with
 * its mapped CRM campaign's branchId (if mapped) - how the tenant-level
 * lead-ingestion pipeline maps an incoming lead's `details.campaignId`
 * (from the Graph API) back to both the metaCampaigns row itself
 * (crmCampaignId) and, if mapped, which branch the lead belongs to.
 * Returns null if this Meta campaign hasn't been synced for this tenant
 * yet - callers treat that as "capture the lead anyway, just unmapped"
 * rather than a hard failure. crmCampaignBranchId is null both when the
 * Meta campaign is unmapped AND when its mapped CRM campaign is itself
 * company-wide (branchId null) - either way, no branch to attribute.
 */
export async function getMetaCampaignByMetaCampaignId(tenantId: string, metaCampaignId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: metaCampaigns.id,
      crmCampaignId: metaCampaigns.crmCampaignId,
      crmCampaignBranchId: campaigns.branchId,
    })
    .from(metaCampaigns)
    .leftJoin(campaigns, eq(metaCampaigns.crmCampaignId, campaigns.id))
    .where(and(eq(metaCampaigns.tenantId, tenantId), eq(metaCampaigns.metaCampaignId, metaCampaignId)))
    .limit(1);
  return row ?? null;
}

export async function listSyncedCampaignsForAdAccount(tenantId: string, adAccountRowId: string) {
  const db = await getDb();
  return db
    .select()
    .from(metaCampaigns)
    .where(and(eq(metaCampaigns.tenantId, tenantId), eq(metaCampaigns.metaAdAccountId, adAccountRowId)));
}

/**
 * Lists every synced Meta campaign for the tenant, joined with its mapped
 * CRM campaign's name/branch (null if unmapped) and lead count. Unscoped by
 * ad account - includes campaigns synced under an ad account the tenant is
 * no longer connected to. That makes this the wrong function for anything
 * tenant-facing (see listMetaCampaignsWithMappingForAdAccount below, which
 * is what the Campaigns screen and the Meta status screen actually use) -
 * this one is now kept for callers that genuinely want the full synced
 * history regardless of which ad account it came from (currently just this
 * file's own tests).
 */
export async function listMetaCampaignsWithMapping(tenantId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: metaCampaigns.id,
      metaCampaignId: metaCampaigns.metaCampaignId,
      name: metaCampaigns.name,
      status: metaCampaigns.status,
      startTime: metaCampaigns.startTime,
      stopTime: metaCampaigns.stopTime,
      lastSyncAt: metaCampaigns.lastSyncAt,
      crmCampaignId: metaCampaigns.crmCampaignId,
      crmCampaignName: campaigns.name,
      crmCampaignBranchId: campaigns.branchId,
    })
    .from(metaCampaigns)
    .leftJoin(campaigns, eq(metaCampaigns.crmCampaignId, campaigns.id))
    .where(eq(metaCampaigns.tenantId, tenantId));
  return rows;
}

/**
 * Same joined shape as listMetaCampaignsWithMapping above, narrowed to
 * campaigns synced under ONE ad account (metaCampaigns.metaAdAccountId) -
 * what the Campaigns screen's "Meta Campaigns" table and the Meta status
 * screen's campaign count actually want. Pass the tenant's CURRENTLY
 * SELECTED ad account's row id (see getSelectedMetaAdAccount in
 * metaIntegration.ts).
 *
 * Why this exists: disconnecting Meta and reconnecting with a DIFFERENT ad
 * account never deletes the previously synced campaigns
 * (disconnectActiveMetaConnection only revokes the connection row; synced
 * Pages/ad accounts/campaigns are left as history) - without this scoping
 * those stale rows from the no-longer-selected ad account would keep
 * showing up forever, right alongside the new account's campaigns, which
 * is exactly the "why am I seeing all this data" bug this function fixes.
 * Reconnecting to the SAME Meta ad account resolves back to the same row
 * id (upserted by the (tenantId, adAccountId) unique index - see
 * replaceMetaAdAccounts), so that account's own synced history is
 * preserved across a disconnect/reconnect; only a genuinely different ad
 * account's old campaigns are excluded.
 */
export async function listMetaCampaignsWithMappingForAdAccount(tenantId: string, adAccountRowId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: metaCampaigns.id,
      metaCampaignId: metaCampaigns.metaCampaignId,
      name: metaCampaigns.name,
      status: metaCampaigns.status,
      startTime: metaCampaigns.startTime,
      stopTime: metaCampaigns.stopTime,
      lastSyncAt: metaCampaigns.lastSyncAt,
      crmCampaignId: metaCampaigns.crmCampaignId,
      crmCampaignName: campaigns.name,
      crmCampaignBranchId: campaigns.branchId,
    })
    .from(metaCampaigns)
    .leftJoin(campaigns, eq(metaCampaigns.crmCampaignId, campaigns.id))
    .where(and(eq(metaCampaigns.tenantId, tenantId), eq(metaCampaigns.metaAdAccountId, adAccountRowId)));
  return rows;
}

/** Same joined shape as listMetaCampaignsWithMapping, narrowed to one Meta
 * campaign by its own row id - powers the meta-campaign.html detail/mapping
 * screen. Returns null if the row doesn't exist or belongs to another
 * tenant. */
export async function getMetaCampaignWithMappingByRowId(tenantId: string, metaCampaignRowId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      id: metaCampaigns.id,
      metaCampaignId: metaCampaigns.metaCampaignId,
      name: metaCampaigns.name,
      status: metaCampaigns.status,
      startTime: metaCampaigns.startTime,
      stopTime: metaCampaigns.stopTime,
      lastSyncAt: metaCampaigns.lastSyncAt,
      crmCampaignId: metaCampaigns.crmCampaignId,
      crmCampaignName: campaigns.name,
      crmCampaignBranchId: campaigns.branchId,
    })
    .from(metaCampaigns)
    .leftJoin(campaigns, eq(metaCampaigns.crmCampaignId, campaigns.id))
    .where(and(eq(metaCampaigns.tenantId, tenantId), eq(metaCampaigns.id, metaCampaignRowId)))
    .limit(1);
  return row ?? null;
}

/**
 * THE mapping action - link one synced Meta campaign to an existing CRM
 * campaign. Both rows are re-checked against tenantId so a request can
 * never cross-tenant-link - this is the ONE place a Meta campaign's
 * ownership could otherwise get "merged" with another tenant's CRM
 * campaign ("Campaigns must remain organization/client scoped"), so this
 * function enforces it itself rather than trusting a caller's own
 * pre-check (api/campaigns/handler.ts's handleMapMetaCampaign already
 * validates crmCampaignId belongs to auth.companyId before ever calling
 * this - the check below is deliberate defense in depth for this one
 * specifically security-sensitive write, same "repository fails closed
 * instead of trusting the caller" posture as
 * getWebhookConfigByCampaignIdInternal's own Phase 19 comment). Idempotent:
 * mapping an already-mapped Meta campaign simply repoints it (last call
 * wins) rather than erroring, since "change which CRM campaign this maps
 * to" is a normal correction, not a conflict.
 */
export async function mapMetaCampaignToCrmCampaign(tenantId: string, metaCampaignRowId: string, crmCampaignId: string) {
  const db = await getDb();

  // The target CRM campaign must itself belong to this same tenant - never
  // trust crmCampaignId's ownership as already-established just because the
  // caller is asking. Checked here, not just at the HTTP layer, so this
  // invariant holds regardless of what ever calls this function in the
  // future.
  const [crmCampaign] = await db
    .select({ id: campaigns.id })
    .from(campaigns)
    .where(and(eq(campaigns.companyId, tenantId), eq(campaigns.id, crmCampaignId)))
    .limit(1);
  if (!crmCampaign) return null;

  const rows = await db
    .update(metaCampaigns)
    .set({ crmCampaignId, updatedAt: new Date() })
    .where(and(eq(metaCampaigns.tenantId, tenantId), eq(metaCampaigns.id, metaCampaignRowId)))
    .returning();
  return rows[0] ?? null;
}

/** Clears the mapping - the Meta campaign keeps syncing, its leads simply
 * go back to being captured unmapped (crmCampaignId/branchId both null on
 * new leads) until it's mapped again. */
export async function unmapMetaCampaign(tenantId: string, metaCampaignRowId: string) {
  const db = await getDb();
  const rows = await db
    .update(metaCampaigns)
    .set({ crmCampaignId: null, updatedAt: new Date() })
    .where(and(eq(metaCampaigns.tenantId, tenantId), eq(metaCampaigns.id, metaCampaignRowId)))
    .returning();
  return rows[0] ?? null;
}

// ---- Ad sets ----------------------------------------------------------------

export interface ReplaceMetaAdSetInput {
  adSetId: string;
  adSetName: string;
  status: string; // Meta's own status string
}

/** Upsert every ad set under one Meta campaign, keyed on (tenantId,
 * adSetId). metaCampaignRowId is the metaCampaigns.id (Phase 9: never a
 * CRM campaigns.id). */
export async function replaceMetaAdSets(
  tenantId: string,
  metaCampaignRowId: string,
  adAccountRowId: string,
  adSets: ReplaceMetaAdSetInput[],
) {
  if (adSets.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .insert(metaAdSets)
    .values(
      adSets.map((a) => ({
        tenantId,
        metaCampaignId: metaCampaignRowId,
        metaAdAccountId: adAccountRowId,
        adSetId: a.adSetId,
        adSetName: a.adSetName,
        status: normalizeMetaStatus(a.status),
        lastSyncAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [metaAdSets.tenantId, metaAdSets.adSetId],
      set: {
        metaCampaignId: sql`excluded.meta_campaign_id`,
        adSetName: sql`excluded.ad_set_name`,
        status: sql`excluded.status`,
        lastSyncAt: sql`excluded.last_sync_at`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows;
}

export async function listAdSetsForCampaigns(tenantId: string, metaCampaignRowIds: string[]) {
  if (metaCampaignRowIds.length === 0) return [];
  const db = await getDb();
  return db
    .select()
    .from(metaAdSets)
    .where(and(eq(metaAdSets.tenantId, tenantId), inArray(metaAdSets.metaCampaignId, metaCampaignRowIds)));
}

// ---- Ads ----------------------------------------------------------------------

export interface ReplaceMetaAdInput {
  adId: string;
  adName: string;
  status: string;
}

/** Upsert every ad under one ad set, keyed on (tenantId, adId). */
export async function replaceMetaAds(tenantId: string, adSetRowId: string, ads: ReplaceMetaAdInput[]) {
  if (ads.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .insert(metaAds)
    .values(
      ads.map((a) => ({
        tenantId,
        adSetId: adSetRowId,
        adId: a.adId,
        adName: a.adName,
        status: normalizeMetaStatus(a.status),
        lastSyncAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [metaAds.tenantId, metaAds.adId],
      set: {
        adSetId: sql`excluded.ad_set_id`,
        adName: sql`excluded.ad_name`,
        status: sql`excluded.status`,
        lastSyncAt: sql`excluded.last_sync_at`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows;
}

// ---- Lead forms (reuses the existing meta_forms table from Phase 2) -------

/** Existence check by Meta's OWN form id, BEFORE the upsert - lets
 * metaFormService.ts tell a brand-new form (never synced for this tenant
 * before) from a re-sync of one it's already seen, the same
 * check-before-upsert pattern metaCampaignService.ts uses to gate
 * "auto-map on first sync". Used to gate the one-time historical lead
 * backfill (see syncHistoricalLeadsForForm) so it only ever runs once per
 * form, not on every regular "Sync now". */
export async function getMetaFormByFormId(tenantId: string, formId: string) {
  const db = await getDb();
  const [row] = await db
    .select({ id: metaForms.id })
    .from(metaForms)
    .where(and(eq(metaForms.tenantId, tenantId), eq(metaForms.formId, formId)))
    .limit(1);
  return row ?? null;
}

export interface ReplaceMetaFormInput {
  formId: string;
  formName: string;
  status: string;
  // Phase 10 - this form's own questions, exactly as Meta returns them
  // (see graphClient.MetaLeadFormSummary.questions). Refreshed on every
  // re-sync the same as name/status - what changes per-question mapping
  // (mappingType/systemField/customFieldKey) lives entirely in
  // meta_form_field_mappings, never here.
  questions: { key: string; label: string; type: string }[];
}

/** Upsert every lead-gen form under one Page, keyed on the (tenantId,
 * formId) unique index from Phase 2. Returns the full upserted rows so the
 * caller (metaFormService.ts) can seed/refresh each form's field mappings
 * immediately after, without a second read. */
export async function replaceMetaForms(tenantId: string, pageId: string, forms: ReplaceMetaFormInput[]) {
  if (forms.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .insert(metaForms)
    .values(
      forms.map((f) => ({
        tenantId,
        pageId,
        formId: f.formId,
        formName: f.formName,
        status: normalizeMetaStatus(f.status),
        questions: f.questions,
        lastSyncedAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [metaForms.tenantId, metaForms.formId],
      set: {
        pageId: sql`excluded.page_id`,
        formName: sql`excluded.form_name`,
        status: sql`excluded.status`,
        questions: sql`excluded.questions`,
        lastSyncedAt: sql`excluded.last_synced_at`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows;
}
