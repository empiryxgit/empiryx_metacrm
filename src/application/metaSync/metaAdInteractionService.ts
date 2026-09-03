// "Meta Campaign Destination Detection + Lead/Interaction Capture"
// reframing, Phase 17 - the "Advertising Interaction" side of the
// Lead-vs-Interaction split the user's spec requires:
//
//   Leads      = identifiable people, actually captured into the CRM
//                (source of truth: leads.lead_approach = "whatsapp" rows -
//                 see metaWhatsappEventService.ts / processWhatsAppMessageEvent.ts,
//                 unchanged by this file).
//   Interactions = Meta's own AGGREGATE ad-level metrics (link clicks,
//                messaging conversations started) for the tenant's
//                WhatsApp-destination ads - never a list of people, never
//                turned into a Lead by this file or anything downstream of
//                it.
//
// Verified against Meta's current Marketing API docs (not assumed from
// training data): there is no per-click, per-user identifiable event for a
// WhatsApp-destination ad before the actual WhatsApp message arrives - see
// graphClient.ts's getAdInsights for the citations. This service exists
// specifically so that gap is shown to the tenant honestly ("150 ad clicks,
// only 32 became identifiable leads") rather than silently absent, and so
// that number is never conflated with an actual Lead count anywhere in the
// UI - the two fields returned here are named distinctly on purpose.
//
// Deliberately on-demand and best-effort, mirroring getCampaignInsights'
// own "fetched live, never persisted" posture:
//   - One Graph API call per WhatsApp-routed ad, run in parallel
//     (Promise.allSettled) - a single ad's insights failing (deleted ad,
//     revoked permission, transient error) never fails the whole summary,
//     it's just excluded and counted in `adsFailed`.
//   - Capped at MAX_ADS ads per call so a tenant with an unusually large
//     WhatsApp ad catalog can never turn one dashboard load into an
//     unbounded number of Graph API calls within Vercel's function
//     duration limit - `truncated: true` tells the caller this happened.
//   - Callers decide WHEN to invoke this (see api/dashboard/index.ts's
//     opt-in ?includeAdInteractions=true) rather than it running on every
//     dashboard load unconditionally, so a tenant with zero/few WhatsApp
//     ads never pays for one with many, and the main dashboard response
//     stays fast for everyone.

import { getAdInsights } from "../../infrastructure/meta/graphClient";
import { getActiveMetaConnectionInternal } from "../../infrastructure/db/repositories/metaIntegration";
import { listWhatsappRoutedAds } from "../../infrastructure/db/repositories/whatsapp";

const MAX_ADS = 25;

export interface WhatsappAdInteractionSummary {
  available: boolean; // false when there is no active Meta connection at all
  linkClicks: number;
  conversationsStarted: number;
  adsConsidered: number;
  adsFailed: number;
  truncated: boolean; // true when more WhatsApp-routed ads exist than MAX_ADS
  byAd: Array<{ adName: string; campaignName: string | null; linkClicks: number; conversationsStarted: number }>;
}

const EMPTY_UNAVAILABLE: WhatsappAdInteractionSummary = {
  available: false,
  linkClicks: 0,
  conversationsStarted: 0,
  adsConsidered: 0,
  adsFailed: 0,
  truncated: false,
  byAd: [],
};

/**
 * Aggregate WhatsApp-destination ad interaction metrics for `tenantId` over
 * [since, until] (both "YYYY-MM-DD"). Returns a zeroed, `available: false`
 * summary (never throws) when the tenant has no active Meta connection or
 * no WhatsApp-routed ads at all - the common case for most tenants, and
 * indistinguishable in the response from "Meta call failed for everything",
 * which is intentional: either way there is nothing reliable to show.
 */
export async function getWhatsappAdInteractionSummary(tenantId: string, since: string, until: string): Promise<WhatsappAdInteractionSummary> {
  const connection = await getActiveMetaConnectionInternal(tenantId);
  if (!connection) return EMPTY_UNAVAILABLE;

  const routedAds = await listWhatsappRoutedAds(tenantId);
  if (routedAds.length === 0) return EMPTY_UNAVAILABLE;

  const truncated = routedAds.length > MAX_ADS;
  const adsToQuery = routedAds.slice(0, MAX_ADS);

  const results = await Promise.allSettled(
    adsToQuery.map(async (ad) => ({ ad, insight: await getAdInsights(ad.metaAdId, connection.accessToken, since, until) })),
  );

  let linkClicks = 0;
  let conversationsStarted = 0;
  let adsFailed = 0;
  const byAd: WhatsappAdInteractionSummary["byAd"] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      adsFailed++;
      console.warn(`[whatsapp-ad-interactions] Failed to load ad insights for tenant ${tenantId}:`, result.reason);
      continue;
    }
    const { ad, insight } = result.value;
    linkClicks += insight.linkClicks;
    conversationsStarted += insight.messagingConversationsStarted;
    byAd.push({ adName: ad.adName, campaignName: ad.campaignName, linkClicks: insight.linkClicks, conversationsStarted: insight.messagingConversationsStarted });
  }

  return { available: true, linkClicks, conversationsStarted, adsConsidered: adsToQuery.length, adsFailed, truncated, byAd };
}
