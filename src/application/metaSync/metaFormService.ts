// MetaFormService (Phase 6 naming) - owns the "Loading Forms" sync step.
// Scoped to the tenant's SELECTED Page only, using that Page's own
// page-scoped access token (Meta's Leadgen Forms API requires a page
// token with leads_retrieval, not the connection's user token - see
// graphClient.getPageLeadForms).
//
// Phase 10: each form's own questions (see graphClient.MetaLeadFormSummary
// .questions) are now part of what this sync persists, and every question
// gets a starting field-mapping row seeded right after - see
// ensureDefaultFieldMappings's own comment for why a re-sync never touches
// a mapping that already exists.
//
// Review finding (Meta integration architecture review) - "historical lead
// sync": Meta only pushes NEW leads to RUTA going forward, via the leadgen
// webhook. A Page connected to RUTA for the first time may already have
// leads sitting in Meta from BEFORE the connection existed - those were
// silently lost forever with no backfill path. syncHistoricalLeadsForForm
// below closes that gap: the first time (and only the first time - see
// getMetaFormByFormId's own comment) a given form is synced, it pages
// through that form's recent Meta-side lead history and captures anything
// not already in Postgres, using the exact same field-resolution/
// campaign-attribution/insert building blocks the real-time webhook
// pipeline uses (resolveLeadFields, getMetaCampaignByMetaCampaignId,
// insertMetaSyncLead) - so a backfilled lead is indistinguishable in shape
// from one that arrived live.

import { getPageLeadForms, getRecentLeadsForForm, MetaApiError } from "../../infrastructure/meta/graphClient";
import { getMetaPageInternal, getSelectedMetaPage } from "../../infrastructure/db/repositories/metaIntegration";
import { getMetaFormByFormId, getMetaCampaignByMetaCampaignId, replaceMetaForms } from "../../infrastructure/db/repositories/metaSync";
import { ensureDefaultFieldMappings } from "../../infrastructure/db/repositories/metaFormMappings";
import { insertMetaSyncLead } from "../../infrastructure/db/repositories/metaLeadEvents";
import { resolveLeadFields } from "./resolveLeadFields";
import { flagConnectionIfAuthError } from "./metaConnectionService";
import { LeadPlatform } from "../../domain/types";

// How far back to look for historical leads the first time a form is
// synced. Meta's own /{form-id}/leads endpoint doesn't reliably return
// data indefinitely far back in practice, so this is bounded rather than
// "everything" - configurable per deployment, same convention as
// RECONCILIATION_LOOKBACK_HOURS in reconcile.ts.
const HISTORICAL_LEAD_SYNC_LOOKBACK_DAYS = Number(process.env.META_HISTORICAL_LEAD_SYNC_LOOKBACK_DAYS) || 90;

export interface SyncFormsResult {
  skipped: boolean;
  reason?: string;
  formsCount: number;
  // Historical backfill counts, always 0 when no BRAND-NEW form was found
  // this run (the common case after the first sync).
  historicalLeadsFound: number;
  historicalLeadsCreated: number;
}

export async function syncFormsForSelectedPage(tenantId: string): Promise<SyncFormsResult> {
  const selectedPage = await getSelectedMetaPage(tenantId);
  if (!selectedPage) {
    return { skipped: true, reason: "No Page selected yet.", formsCount: 0, historicalLeadsFound: 0, historicalLeadsCreated: 0 };
  }

  // Re-fetch with the decrypted page token - getSelectedMetaPage's row
  // still carries the encrypted column, never decrypted for a bare
  // "which page is selected" lookup.
  const pageInternal = await getMetaPageInternal(tenantId, selectedPage.id);
  if (!pageInternal) {
    return { skipped: true, reason: "Selected Page could not be loaded.", formsCount: 0, historicalLeadsFound: 0, historicalLeadsCreated: 0 };
  }

  const forms = await getPageLeadForms(selectedPage.pageId, pageInternal.pageAccessToken);

  // Looked up BEFORE the upsert below, specifically so the historical
  // backfill only ever fires for a form this tenant has never synced
  // before - the exact same "check existence before upsert" pattern
  // metaCampaignService.ts uses to gate its own "auto-map on first sync"
  // step. Sequential (a handful of local existence checks, not Graph API
  // calls - no rate-limit concern).
  const brandNewFormIds: string[] = [];
  for (const form of forms) {
    const alreadySynced = await getMetaFormByFormId(tenantId, form.id);
    if (!alreadySynced) brandNewFormIds.push(form.id);
  }

  const formRows = await replaceMetaForms(
    tenantId,
    selectedPage.pageId,
    forms.map((f) => ({ formId: f.id, formName: f.name, status: f.status, questions: f.questions })),
  );

  // Seed a default field mapping for every question on every form just
  // synced - sequential (mirrors metaCampaignService.ts's own "simplest
  // and kindest to rate limits" reasoning, and this is a handful of local
  // DB writes, not Graph API calls, so there's no rate-limit concern -
  // just consistency with the pattern already established here).
  for (const formRow of formRows) {
    await ensureDefaultFieldMappings(tenantId, formRow.id, formRow.questions as { key: string; label: string; type: string }[]);
  }

  let historicalLeadsFound = 0;
  let historicalLeadsCreated = 0;

  // One-time historical backfill, only for forms this tenant has never
  // seen before. Sequential per form - the same "simplest and kindest to
  // Meta's rate limits" posture metaCampaignService.ts already accepts for
  // its own campaign/ad-set/ad walk, and this endpoint's maxDuration (60s,
  // see vercel.json) comfortably covers the handful of forms a typical
  // tenant has.
  for (const formId of brandNewFormIds) {
    try {
      const result = await syncHistoricalLeadsForForm(tenantId, selectedPage.pageId, formId, pageInternal.pageAccessToken);
      historicalLeadsFound += result.found;
      historicalLeadsCreated += result.created;
    } catch (err) {
      // A whole form's backfill failing (rate limit, permission error,
      // Graph outage) must never fail the "forms" sync step itself - the
      // forms/mappings above are already durably saved. Auth-classified
      // failures still flag the connection (same funnel every other
      // Meta-API-calling path uses) so the tenant sees "needs
      // reauthorization" rather than a silent gap; anything else is just
      // logged - the form will simply be retried in full (including this
      // backfill) on the tenant's next "Sync now" if it never actually
      // got upserted, or left as a one-time miss if it did (the ongoing
      // reconciliation sweep - see reconcile.ts - covers gaps going
      // forward regardless).
      console.error(`[meta-forms] Historical lead backfill failed for tenant ${tenantId}, form ${formId}:`, err);
      if (err instanceof MetaApiError) {
        await flagConnectionIfAuthError(tenantId, err, "Historical lead sync (getRecentLeadsForForm)");
      }
    }
  }

  return { skipped: false, formsCount: forms.length, historicalLeadsFound, historicalLeadsCreated };
}

/**
 * Backfills one form's historical leads - everything Meta returns for
 * `formId` created within the last HISTORICAL_LEAD_SYNC_LOOKBACK_DAYS days,
 * captured via the exact same field-resolution/attribution/insert path the
 * real-time webhook pipeline uses (see processMetaLeadEvent.ts, which this
 * mirrors). Not wrapped in the Redis fast-path claim
 * (tryClaimLeadId/releaseLeadIdClaim) that pipeline uses - this runs
 * strictly sequentially within one request, so there is no concurrent-race
 * window to defend against; the same Postgres unique index on
 * leads.meta_lead_id (surfaced here as insertMetaSyncLead's "duplicate"
 * outcome) is still the authoritative backstop, exactly as it is
 * everywhere else in this codebase.
 *
 * One lead failing to resolve/insert (a malformed field_data shape, a
 * transient DB error) is caught and skipped rather than aborting the rest
 * of the form's backfill - "the lead should still be stored successfully
 * even if enrichment fails" for every OTHER lead in the same form, and a
 * single miss here is exactly the kind of gap the recurring reconciliation
 * sweep (reconcile.ts) exists to catch going forward.
 */
async function syncHistoricalLeadsForForm(
  tenantId: string,
  pageId: string,
  formId: string,
  pageAccessToken: string,
): Promise<{ found: number; created: number }> {
  const sinceUnixSeconds = Math.floor(Date.now() / 1000) - HISTORICAL_LEAD_SYNC_LOOKBACK_DAYS * 24 * 60 * 60;

  let found = 0;
  let created = 0;

  for await (const lead of getRecentLeadsForForm(formId, sinceUnixSeconds, pageAccessToken)) {
    found++;
    try {
      const contact = await resolveLeadFields(tenantId, lead.formId, lead.fieldData);
      const metaCampaign = lead.campaignId ? await getMetaCampaignByMetaCampaignId(tenantId, lead.campaignId) : null;

      const result = await insertMetaSyncLead({
        companyId: tenantId,
        branchId: metaCampaign?.crmCampaignBranchId ?? null,
        crmCampaignId: metaCampaign?.crmCampaignId ?? null,
        metaLeadId: lead.id,
        // Same "no reliable per-lead signal" default the real-time
        // pipeline uses - see processMetaLeadEvent.ts's own comment.
        platform: LeadPlatform.Facebook,
        // getRecentLeadsForForm's underlying Graph fields never include
        // page_id either (same LEAD_FIELDS as getLeadDetails) - use the
        // Page we're already scanning, same fallback processMetaLeadEvent
        // .ts applies.
        pageId: lead.pageId ?? pageId,
        formId: lead.formId,
        formName: contact.formName,
        adId: lead.adId,
        adName: lead.adName,
        adSetId: lead.adSetId,
        adSetName: lead.adSetName,
        campaignId: lead.campaignId,
        campaignName: lead.campaignName,
        fullName: contact.fullName,
        email: contact.email,
        phoneNumber: contact.phoneNumber,
        customFields: contact.customFields,
        formResponses: lead.fieldData,
        metaCreatedAt: new Date(lead.createdTime),
      });

      if (result.outcome === "inserted") created++;
    } catch (err) {
      console.error(`[meta-forms] Failed to backfill historical lead ${lead.id} (form ${formId}, tenant ${tenantId}):`, err);
    }
  }

  return { found, created };
}
