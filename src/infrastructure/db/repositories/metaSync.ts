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
}

/**
 * Upsert one synced Meta campaign, keyed on the (tenantId, metaCampaignId)
 * unique index (`ux_meta_campaigns_tenant_meta_campaign`). A re-sync only
 * ever refreshes name/status/metaAdAccountId/lastSyncAt - crmCampaignId is
 * NEVER touched here, on insert (defaults to null/"unmapped") or on
 * conflict, since the CRM mapping is owned entirely by an explicit user
 * action (see mapMetaCampaignToCrmCampaign), not by the sync.
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
      lastSyncAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [metaCampaigns.tenantId, metaCampaigns.metaCampaignId],
      set: {
        name: sql`excluded.name`,
        status: sql`excluded.status`,
        metaAdAccountId: sql`excluded.meta_ad_account_id`,
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
 * CRM campaign's name/branch (null if unmapped) and lead count. Powers the
 * Campaigns screen's "Meta Campaigns" table - deliberately NOT scoped to
 * one ad account, since the screen shows everything synced regardless of
 * which ad account it came from.
 */
export async function listMetaCampaignsWithMapping(tenantId: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: metaCampaigns.id,
      metaCampaignId: metaCampaigns.metaCampaignId,
      name: metaCampaigns.name,
      status: metaCampaigns.status,
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
 * never cross-tenant-link. Idempotent: mapping an already-mapped Meta
 * campaign simply repoints it (last call wins) rather than erroring, since
 * "change which CRM campaign this maps to" is a normal correction, not a
 * conflict.
 */
export async function mapMetaCampaignToCrmCampaign(tenantId: string, metaCampaignRowId: string, crmCampaignId: string) {
  const db = await getDb();
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
