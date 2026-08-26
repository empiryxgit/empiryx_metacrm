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
  mapMetaCampaignToCrmCampaign,
} from "../../infrastructure/db/repositories/metaSync";
import { createCampaign } from "../../infrastructure/db/repositories/campaigns";

export interface SyncCampaignsResult {
  skipped: boolean;
  reason?: string;
  campaignsCount: number;
  adSetsCount: number;
  adsCount: number;
  autoMappedCount: number; // brand-new Meta campaigns this run auto-created + mapped a CRM campaign for
}

export async function syncCampaignsForSelectedAdAccount(tenantId: string, userAccessToken: string): Promise<SyncCampaignsResult> {
  const selectedAdAccount = await getSelectedMetaAdAccount(tenantId);
  if (!selectedAdAccount) {
    return { skipped: true, reason: "No ad account selected yet.", campaignsCount: 0, adSetsCount: 0, adsCount: 0, autoMappedCount: 0 };
  }

  const campaigns = await getAdAccountCampaigns(selectedAdAccount.adAccountId, userAccessToken);

  let adSetsCount = 0;
  let adsCount = 0;
  let autoMappedCount = 0;

  for (const campaign of campaigns) {
    // Looked up BEFORE the upsert below, specifically so this only ever
    // fires for a Meta campaign this tenant has never synced before - a
    // Meta campaign RUTA has already seen, even one currently unmapped
    // because a person explicitly unmapped it, is left exactly as it is.
    // upsertMetaCampaign itself still never touches crmCampaignId (its own
    // contract, unchanged); auto-mapping only ever happens here, as this
    // one explicit, one-time bootstrap step for a brand-new campaign.
    const alreadySynced = await getMetaCampaignByMetaCampaignId(tenantId, campaign.id);

    const metaCampaignRow = await upsertMetaCampaign(tenantId, selectedAdAccount.id, {
      metaCampaignId: campaign.id,
      name: campaign.name,
      metaStatus: campaign.status,
    });

    if (!alreadySynced) {
      // First time this tenant has ever synced this Meta campaign - create
      // and map a same-named CRM campaign automatically so leads land
      // somewhere useful without a manual "create a CRM campaign, then map
      // it" round trip. Company-wide (branchId null) by default, same as a
      // manually created campaign left on "All branches"; the tenant can
      // reassign a branch (campaign.html) or rename it (also
      // campaign.html) any time afterward - this is only ever a starting
      // point, never a lock-in.
      const crmCampaign = await createCampaign({
        companyId: tenantId,
        branchId: null,
        name: campaign.name,
        platform: "facebook",
        createdBy: null, // system-created, not a person - see createCampaign's own comment
        source: "meta_sync",
      });
      await mapMetaCampaignToCrmCampaign(tenantId, metaCampaignRow.id, crmCampaign.id);
      autoMappedCount++;
    }

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
    }
  }

  return { skipped: false, campaignsCount: campaigns.length, adSetsCount, adsCount, autoMappedCount };
}
