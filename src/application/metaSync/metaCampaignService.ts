// MetaCampaignService (Phase 6 naming) - owns the "Loading Campaigns" sync
// step. Scoped to the tenant's SELECTED ad account only (Phase 6: "Once the
// user selects the Page and Ad Account, automatically retrieve Meta
// assets" - never every ad account the connection can see, and the user
// never types an id to make that happen). Walks the full Campaign -> Ad Set
// -> Ad hierarchy for that one ad account; UI-wise this is still a single
// "Loading Campaigns" checklist item (see the Phase 6 example), even though
// it covers three Graph calls / two of our tables under the hood.
//
// Sequential, not parallel, per campaign/ad set - simplest and kindest to
// Meta's rate limits for an initial implementation; a tenant with an
// unusually large number of campaigns will see a proportionally longer
// sync, a known/accepted limit for this phase rather than something this
// phase builds a job queue to solve.

import { getAdAccountCampaigns, getCampaignAdSets, getAdSetAds } from "../../infrastructure/meta/graphClient";
import { getSelectedMetaAdAccount } from "../../infrastructure/db/repositories/metaIntegration";
import {
  upsertMetaCampaign,
  replaceMetaAdSets,
  replaceMetaAds,
  getMetaCampaignByMetaCampaignId,
} from "../../infrastructure/db/repositories/metaSync";
import { resolveLeadApproachForAd } from "./metaLeadApproachResolver";
import { upsertMetaLeadRoute } from "../../infrastructure/db/repositories/whatsapp";

export interface SyncCampaignsResult {
  skipped: boolean;
  reason?: string;
  campaignsCount: number;
  adSetsCount: number;
  adsCount: number;
  newCampaignsCount: number; // brand-new Meta campaigns this run discovered (upserted into metaCampaigns) but did NOT auto-map - see this function's own comment
  // WhatsApp Lead Capture feature (Phase 3/4) - how many of this run's ads
  // resolved to each lead approach. UNDETERMINED ads are the "Action
  // required" signal the Settings screen surfaces (Phase 19).
  leadApproachCounts: { metaInstantForm: number; whatsapp: number; unknown: number };
}

export async function syncCampaignsForSelectedAdAccount(tenantId: string, userAccessToken: string): Promise<SyncCampaignsResult> {
  const selectedAdAccount = await getSelectedMetaAdAccount(tenantId);
  if (!selectedAdAccount) {
    return {
      skipped: true,
      reason: "No ad account selected yet.",
      campaignsCount: 0,
      adSetsCount: 0,
      adsCount: 0,
      newCampaignsCount: 0,
      leadApproachCounts: { metaInstantForm: 0, whatsapp: 0, unknown: 0 },
    };
  }

  const campaigns = await getAdAccountCampaigns(selectedAdAccount.adAccountId, userAccessToken);

  let adSetsCount = 0;
  let adsCount = 0;
  let newCampaignsCount = 0;
  const leadApproachCounts = { metaInstantForm: 0, whatsapp: 0, unknown: 0 };

  for (const campaign of campaigns) {
    // Looked up BEFORE the upsert below, purely to count how many of this
    // run's campaigns are brand-new discoveries (never seen before) for the
    // "Loading Campaigns" step's summary note - has no effect on behavior.
    //
    // Campaign-limit fix: sync used to auto-create a CRM campaign and
    // auto-map it for every brand-new Meta campaign found here, with NO
    // regard for the tenant's plan/trial campaign limit - the root cause of
    // "all campaigns load regardless of plan." Sync's job is now ONLY
    // discovery: upsert the raw Meta campaign into metaCampaigns (below) so
    // it's visible for selection. Turning a discovered Meta campaign into a
    // tracked CRM campaign (and thus something that can receive leads) is
    // now always an explicit "Activate" action the user takes on the Meta
    // Campaigns screen (api/campaigns/handler.ts's handleMapMetaCampaign),
    // which enforces the plan's remaining slot count at that one action
    // point - see that handler's own comment.
    const alreadySynced = await getMetaCampaignByMetaCampaignId(tenantId, campaign.id);
    if (!alreadySynced) newCampaignsCount++;

    const metaCampaignRow = await upsertMetaCampaign(tenantId, selectedAdAccount.id, {
      metaCampaignId: campaign.id,
      name: campaign.name,
      metaStatus: campaign.status,
      startTime: campaign.startTime,
      stopTime: campaign.stopTime,
    });

    const adSets = await getCampaignAdSets(campaign.id, userAccessToken);
    if (adSets.length === 0) continue;

    const adSetRows = await replaceMetaAdSets(
      tenantId,
      metaCampaignRow.id,
      selectedAdAccount.id,
      adSets.map((s) => ({ adSetId: s.id, adSetName: s.name, status: s.status })),
    );
    adSetsCount += adSetRows.length;

    // Map Meta's ad-set id -> our row id so ads land under the right one
    // (replaceMetaAdSets returns rows in insert order for the upserted
    // set, but matching by adSetId is more robust than assuming order).
    const adSetRowById = new Map(adSetRows.map((row) => [row.adSetId, row]));
    // Same for destination_type - resolveLeadApproachForAd needs it per ad
    // set, without re-fetching ad sets a second time.
    const destinationTypeByAdSetId = new Map(adSets.map((s) => [s.id, s.destinationType]));

    for (const adSet of adSets) {
      const adSetRow = adSetRowById.get(adSet.id);
      if (!adSetRow) continue; // should not happen - defensive only
      const ads = await getAdSetAds(adSet.id, userAccessToken);
      if (ads.length === 0) continue;
      const adRows = await replaceMetaAds(
        tenantId,
        adSetRow.id,
        ads.map((a) => ({ adId: a.id, adName: a.name, status: a.status })),
      );
      adsCount += adRows.length;

      // WhatsApp Lead Capture feature (Phase 3/4) - resolve and persist
      // each ad's lead approach right after it's synced, so
      // webhook/reporting code never has to re-derive it from the Graph
      // API later (Phase 4's whole point). Sequential per ad, same
      // "simplest and kindest to Meta's rate limits" posture this whole
      // function already takes for campaigns/ad sets/ads.
      const adRowByAdId = new Map(adRows.map((row) => [row.adId, row]));
      for (const ad of ads) {
        const adRow = adRowByAdId.get(ad.id);
        if (!adRow) continue; // should not happen - defensive only
        const resolved = await resolveLeadApproachForAd(
          { metaAdId: ad.id, adSetDestinationType: destinationTypeByAdSetId.get(adSet.id) ?? null },
          userAccessToken,
        );
        await upsertMetaLeadRoute(tenantId, {
          metaConnectionId: selectedAdAccount.metaConnectionId,
          metaAdAccountId: selectedAdAccount.id,
          metaCampaignId: metaCampaignRow.id,
          metaAdSetId: adSetRow.id,
          metaAdId: adRow.id,
          approach: resolved.approach,
          confidence: resolved.confidence,
          formId: resolved.formId,
          metadata: resolved.reason ? { reason: resolved.reason } : {},
        });
        if (resolved.approach === "meta_instant_form") leadApproachCounts.metaInstantForm++;
        else if (resolved.approach === "whatsapp") leadApproachCounts.whatsapp++;
        else leadApproachCounts.unknown++;
      }
    }
  }

  return { skipped: false, campaignsCount: campaigns.length, adSetsCount, adsCount, newCampaignsCount, leadApproachCounts };
}
