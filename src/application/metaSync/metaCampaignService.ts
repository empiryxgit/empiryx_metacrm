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
import { upsertMetaCampaign, replaceMetaAdSets, replaceMetaAds } from "../../infrastructure/db/repositories/metaSync";

export interface SyncCampaignsResult {
  skipped: boolean;
  reason?: string;
  campaignsCount: number;
  adSetsCount: number;
  adsCount: number;
}

export async function syncCampaignsForSelectedAdAccount(tenantId: string, userAccessToken: string): Promise<SyncCampaignsResult> {
  const selectedAdAccount = await getSelectedMetaAdAccount(tenantId);
  if (!selectedAdAccount) {
    return { skipped: true, reason: "No ad account selected yet.", campaignsCount: 0, adSetsCount: 0, adsCount: 0 };
  }

  const campaigns = await getAdAccountCampaigns(selectedAdAccount.adAccountId, userAccessToken);

  let adSetsCount = 0;
  let adsCount = 0;

  for (const campaign of campaigns) {
    const metaCampaignRow = await upsertMetaCampaign(tenantId, selectedAdAccount.id, {
      metaCampaignId: campaign.id,
      name: campaign.name,
      metaStatus: campaign.status,
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

  return { skipped: false, campaignsCount: campaigns.length, adSetsCount, adsCount };
}
