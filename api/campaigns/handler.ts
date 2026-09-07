// Combines list/create (/api/campaigns), read/update
// (/api/campaigns/{campaignId}), the "add webhook" screen
// (/api/campaigns/{campaignId}/webhook), and (Phase 9) the Meta Campaigns
// listing + map/unmap actions (/api/campaigns/meta, /api/campaigns/meta/
// {metaCampaignId}/map|unmap) into ONE Vercel Function - see
// api/auth/handler.ts for why. Public URLs unchanged - vercel.json rewrites
// them here with campaignId/sub (or resource/metaCampaignId/sub) injected
// as query params (Vercel's filesystem [[...x]].ts catch-all convention was
// found not to reliably populate req.query in this deployment, so every
// dynamic route now uses the same explicit-rewrite pattern api/system.ts
// already relied on).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth, requirePermission } from "../../src/infrastructure/auth/context";
import { withEffectiveCompanyContext } from "../../src/application/agencyClientContext";
import {
  createCampaign,
  getCampaign,
  getWebhookConfigForCampaign,
  listCampaigns,
  updateCampaign,
  upsertWebhookConfig,
} from "../../src/infrastructure/db/repositories/campaigns";
import { getLeadCountsByMetaCampaignId, getLeadCountsForCampaigns } from "../../src/infrastructure/db/repositories";
import {
  getMetaCampaignWithMappingByRowId,
  listMetaCampaignsWithMappingForAdAccount,
  mapMetaCampaignToCrmCampaign,
  unmapMetaCampaign,
} from "../../src/infrastructure/db/repositories/metaSync";
import { getSelectedMetaAdAccount } from "../../src/infrastructure/db/repositories/metaIntegration";
import { PERMISSIONS } from "../../src/domain/permissions";
import { assertBranchAccessible, canAccessBranch, resolveBranchAccess } from "../../src/application/branchAccess";
import { listBranches } from "../../src/infrastructure/db/repositories/branches";
import { evaluateLegacyWebhookMigration } from "../../src/application/metaSync/legacyMigration";
import { getConnectionForSync, flagConnectionIfAuthError, MetaSyncNotConnectedError } from "../../src/application/metaSync/metaConnectionService";
import { getCampaignInsights, MetaApiError } from "../../src/infrastructure/meta/graphClient";
import { getCachedCampaignInsights, setCachedCampaignInsights } from "../../src/infrastructure/cache/redis";
import { AuthError } from "../../src/application/auth";
import {
  assertCampaignLimitNotReached,
  createOverageOrder,
  getBillingStatus,
  LimitExceededError,
  verifyAndApplyOveragePayment,
} from "../../src/application/billing";
import { isBillingCycle } from "../../src/domain/billing";

function getQueryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function getBaseUrl(req: VercelRequest): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  return `${proto}://${req.headers.host}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = getQueryString(req, "resource");
  if (resource === "meta-campaigns") return handleMetaCampaigns(req, res);
  if (resource === "billing") return handleBilling(req, res);

  const campaignId = getQueryString(req, "campaignId");
  const subresource = getQueryString(req, "sub");

  if (!campaignId) return handleCollection(req, res);
  if (!subresource) return handleOne(req, res, campaignId);
  if (subresource === "webhook") return handleWebhook(req, res, campaignId);

  res.status(404).json({ error: "Not found" });
}

async function handleCollection(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
    if (!auth) return;
    auth = await withEffectiveCompanyContext(req, auth);

    const requestedBranchId = getQueryString(req, "branchId");
    let access;
    if (requestedBranchId !== undefined) {
      const assertion = await assertBranchAccessible(auth, requestedBranchId);
      if (!assertion.ok) {
        res.status(assertion.status).json({ error: assertion.error });
        return;
      }
      access = { scope: "restricted" as const, branchIds: assertion.branchId ? [assertion.branchId] : [] };
    } else {
      access = resolveBranchAccess(auth);
    }

    const [campaigns, branches] = await Promise.all([listCampaigns(auth.companyId, access), listBranches(auth.companyId)]);
    const branchNameById = new Map(branches.map((b) => [b.id, b.name]));
    // Powers the "Leads" column on the manual campaigns list (Campaigns
    // screen) - a single grouped query rather than one query per campaign.
    // Phase 9: the separate Meta Campaigns table gets its own lead counts
    // from handleMetaCampaignsCollection below, keyed by Meta's raw
    // campaign id rather than crmCampaignId.
    const leadCounts = await getLeadCountsForCampaigns(auth.companyId, campaigns.map((c) => c.id));
    res.status(200).json({
      campaigns: campaigns.map((c) => ({
        ...c,
        branchName: c.branchId ? branchNameById.get(c.branchId) ?? null : null,
        leadsCount: leadCounts[c.id] ?? 0,
      })),
    });
    return;
  }

  if (req.method === "POST") {
    let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
    if (!auth) return;
    auth = await withEffectiveCompanyContext(req, auth);

    const { name, platform, branchId } = (req.body ?? {}) as { name?: string; platform?: string; branchId?: string };
    if (!name) {
      res.status(400).json({ error: "name is required." });
      return;
    }

    const branchAssertion = await assertBranchAccessible(auth, branchId);
    if (!branchAssertion.ok) {
      res.status(branchAssertion.status).json({ error: branchAssertion.error });
      return;
    }

    // Hard block, not a warning - a tenant (or an agency's pooled book,
    // including a client acting on their own) at their plan's campaign
    // limit is refused here, server-side, before a row is ever inserted -
    // see assertCampaignLimitNotReached's own doc comment for exactly what
    // "at the limit" is computed against. The frontend (campaigns.html)
    // detects this 402 by its `code` and redirects straight to
    // /subscription.html rather than just showing an error banner.
    try {
      await assertCampaignLimitNotReached(auth.companyId);
    } catch (err) {
      if (err instanceof LimitExceededError) {
        res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
        return;
      }
      throw err;
    }

    const campaign = await createCampaign({
      companyId: auth.companyId,
      branchId: branchAssertion.branchId,
      name,
      platform: platform && ["facebook", "instagram", "both"].includes(platform) ? platform : "facebook",
      createdBy: auth.userId,
    });
    res.status(201).json({ campaign });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function handleOne(req: VercelRequest, res: VercelResponse, campaignId: string) {
  if (req.method === "GET") {
    let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
    if (!auth) return;
    auth = await withEffectiveCompanyContext(req, auth);
    const campaign = await getCampaign(auth.companyId, campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found." });
      return;
    }
    // Tenant isolation (companyId, above) is not enough on its own - a
    // branch-restricted viewer must never read a campaign scoped to a
    // branch outside their own access, same contract as every other
    // branch-scoped resource (see src/application/branchAccess.ts).
    if (!canAccessBranch(resolveBranchAccess(auth), campaign.branchId)) {
      res.status(403).json({ error: "You do not have access to this branch." });
      return;
    }
    res.status(200).json({ campaign });
    return;
  }

  if (req.method === "PATCH") {
    let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
    if (!auth) return;
    auth = await withEffectiveCompanyContext(req, auth);

    const existingCampaign = await getCampaign(auth.companyId, campaignId);
    if (!existingCampaign) {
      res.status(404).json({ error: "Campaign not found." });
      return;
    }
    // Guards the campaign's CURRENT branch - a branch-restricted manager can
    // never edit a campaign already scoped outside their access, regardless
    // of what's being changed (mirrors the same gate on GET above; the NEW
    // branchId, if one is being set, is separately validated below).
    if (!canAccessBranch(resolveBranchAccess(auth), existingCampaign.branchId)) {
      res.status(403).json({ error: "You do not have access to this branch." });
      return;
    }

    const { name, platform, status, branchId } = (req.body ?? {}) as {
      name?: string;
      platform?: string;
      status?: string;
      branchId?: string | null;
    };

    // Only checked when `name` is actually present in the body - PATCH is
    // partial-update, so omitting it entirely (e.g. the Branch-only save
    // this endpoint originally only ever saw) must stay a no-op on name,
    // never an accidental validation failure. Newly worth guarding now
    // that campaign.html exposes an actual rename field (previously
    // nothing in the UI ever sent `name` on this route at all).
    if (name !== undefined && !name.trim()) {
      res.status(400).json({ error: "Campaign name can't be empty." });
      return;
    }

    let branchIdPatch: string | null | undefined;
    if (branchId !== undefined) {
      const branchAssertion = await assertBranchAccessible(auth, branchId);
      if (!branchAssertion.ok) {
        res.status(branchAssertion.status).json({ error: branchAssertion.error });
        return;
      }
      branchIdPatch = branchAssertion.branchId;
    }

    await updateCampaign(auth.companyId, campaignId, { name, platform, status, branchId: branchIdPatch });
    res.status(200).json({ updated: true });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

// "Inside a campaign, add the webhook" - this is that screen's API. GET
// returns the (masked) current config plus the exact URL to paste into
// Meta's App Dashboard; POST creates or updates it. The webhook itself
// only starts accepting events once Meta completes the GET verification
// handshake against this URL (see api/webhooks/meta/[slug].ts), which
// flips status from "pending" to "verified".
async function handleWebhook(req: VercelRequest, res: VercelResponse, campaignId: string) {
  if (req.method === "GET") {
    let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
    if (!auth) return;
    auth = await withEffectiveCompanyContext(req, auth);
    const campaign = await getCampaign(auth.companyId, campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found." });
      return;
    }
    if (!canAccessBranch(resolveBranchAccess(auth), campaign.branchId)) {
      res.status(403).json({ error: "You do not have access to this branch." });
      return;
    }
    const config = await getWebhookConfigForCampaign(auth.companyId, campaignId, getBaseUrl(req));
    // Phase 18 - "safe migration strategy": when this campaign has a legacy
    // config, also report whether its Page has since shown up under the
    // tenant's own new-integration Meta connection - a pure read-side
    // comparison, never a write. null (not computed at all) when there's no
    // legacy config to migrate in the first place.
    const migration = config ? await evaluateLegacyWebhookMigration(auth.companyId, config.pageId) : null;
    res.status(200).json({ webhook: config, migration });
    return;
  }

  if (req.method === "POST") {
    let auth = await requirePermission(req, res, PERMISSIONS.WEBHOOKS_MANAGE);
    if (!auth) return;
    auth = await withEffectiveCompanyContext(req, auth);

    const campaign = await getCampaign(auth.companyId, campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found." });
      return;
    }
    // Without this, a branch-restricted user holding webhooks.manage could
    // rotate another branch's campaign's Meta secrets (appSecret/
    // accessToken) purely because it shares their company.
    if (!canAccessBranch(resolveBranchAccess(auth), campaign.branchId)) {
      res.status(403).json({ error: "You do not have access to this branch." });
      return;
    }

    const { appSecret, accessToken, pageId, formIds } = (req.body ?? {}) as {
      appSecret?: string;
      accessToken?: string;
      pageId?: string;
      formIds?: string[];
    };

    if (!appSecret || !accessToken) {
      res.status(400).json({ error: "appSecret and accessToken are required." });
      return;
    }

    const config = await upsertWebhookConfig(
      {
        companyId: auth.companyId,
        campaignId,
        appSecret,
        accessToken,
        pageId,
        formIds: Array.isArray(formIds) ? formIds : [],
      },
      getBaseUrl(req),
    );

    res.status(200).json({
      webhook: config,
      instructions:
        "In Meta App Dashboard -> Webhooks, subscribe the 'leadgen' field to this Callback URL using the Verify Token shown. Meta will call this URL once to confirm before any events start flowing.",
    });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

// ---------------------------------------------------------------------------
// Phase 9 - Meta Campaigns (the separate, first-class synced-from-Meta
// entity - see src/infrastructure/db/schema.ts's metaCampaigns table doc
// comment). GET lists every synced Meta campaign for the tenant joined with
// its mapping (null if unmapped) and lead count, powering the Campaigns
// screen's "Meta Campaigns" table. POST .../map and .../unmap are THE
// mapping action - the only way a Meta campaign's crmCampaignId ever
// changes (never the sync itself, see upsertMetaCampaign's own comment).
// ---------------------------------------------------------------------------
async function handleMetaCampaigns(req: VercelRequest, res: VercelResponse) {
  const metaCampaignId = getQueryString(req, "metaCampaignId");
  const subresource = getQueryString(req, "sub");

  if (!metaCampaignId) return handleMetaCampaignsCollection(req, res);
  if (subresource === "map") return handleMapMetaCampaign(req, res, metaCampaignId);
  if (subresource === "unmap") return handleUnmapMetaCampaign(req, res, metaCampaignId);
  if (subresource === "insights") return handleMetaCampaignInsights(req, res, metaCampaignId);
  if (!subresource) return handleGetOneMetaCampaign(req, res, metaCampaignId);

  res.status(404).json({ error: "Not found" });
}

// Powers the meta-campaign.html detail/mapping screen - one Meta campaign,
// joined with its mapping and lead count (same shape as one row of the
// collection listing below).
async function handleGetOneMetaCampaign(req: VercelRequest, res: VercelResponse, metaCampaignId: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const metaCampaign = await getMetaCampaignWithMappingByRowId(auth.companyId, metaCampaignId);
  if (!metaCampaign) {
    res.status(404).json({ error: "Meta campaign not found." });
    return;
  }

  const leadCounts = await getLeadCountsByMetaCampaignId(auth.companyId, [metaCampaign.metaCampaignId]);

  res.status(200).json({
    metaCampaign: {
      id: metaCampaign.id,
      metaCampaignId: metaCampaign.metaCampaignId,
      name: metaCampaign.name,
      status: metaCampaign.status,
      startTime: metaCampaign.startTime,
      stopTime: metaCampaign.stopTime,
      lastSyncAt: metaCampaign.lastSyncAt,
      crmCampaignId: metaCampaign.crmCampaignId,
      crmCampaignName: metaCampaign.crmCampaignName,
      branchId: metaCampaign.crmCampaignBranchId,
      leadsCount: leadCounts[metaCampaign.metaCampaignId] ?? 0,
    },
  });
}

async function handleMetaCampaignsCollection(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  // Scoped to the tenant's CURRENTLY SELECTED ad account only - a tenant
  // that disconnects Meta and reconnects with a different ad account must
  // not keep seeing the previous account's campaigns here (see
  // listMetaCampaignsWithMappingForAdAccount's own comment for why those
  // stale rows still exist in the DB at all). No ad account selected yet
  // (Meta not connected, or connected but Ad Account selection hasn't
  // happened) simply means nothing to show - same empty state the
  // Campaigns page's "Connect Meta" / "Finish setup" callouts already
  // cover before ever calling this endpoint.
  const selectedAdAccount = await getSelectedMetaAdAccount(auth.companyId);
  const metaCampaigns = selectedAdAccount
    ? await listMetaCampaignsWithMappingForAdAccount(auth.companyId, selectedAdAccount.id)
    : [];
  // Leads are attributed by Meta's OWN raw campaign id (leads.campaignId),
  // independent of whether the Meta campaign has been mapped to a CRM
  // campaign yet - see getLeadCountsByMetaCampaignId's own comment.
  const leadCounts = await getLeadCountsByMetaCampaignId(
    auth.companyId,
    metaCampaigns.map((c) => c.metaCampaignId),
  );

  res.status(200).json({
    metaCampaigns: metaCampaigns.map((c) => ({
      id: c.id,
      metaCampaignId: c.metaCampaignId,
      name: c.name,
      status: c.status,
      startTime: c.startTime,
      stopTime: c.stopTime,
      lastSyncAt: c.lastSyncAt,
      crmCampaignId: c.crmCampaignId,
      crmCampaignName: c.crmCampaignName,
      branchId: c.crmCampaignBranchId,
      leadsCount: leadCounts[c.metaCampaignId] ?? 0,
    })),
  });
}

async function handleMapMetaCampaign(req: VercelRequest, res: VercelResponse, metaCampaignId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const { crmCampaignId } = (req.body ?? {}) as { crmCampaignId?: string };
  if (!crmCampaignId) {
    res.status(400).json({ error: "crmCampaignId is required." });
    return;
  }

  // The target CRM campaign must exist, belong to this tenant, and be
  // within the acting user's branch access - same gate every other
  // campaign-mutating action in this file applies (see handleOne's PATCH).
  const crmCampaign = await getCampaign(auth.companyId, crmCampaignId);
  if (!crmCampaign) {
    res.status(404).json({ error: "CRM campaign not found." });
    return;
  }
  if (!canAccessBranch(resolveBranchAccess(auth), crmCampaign.branchId)) {
    res.status(403).json({ error: "You do not have access to this branch." });
    return;
  }

  const updated = await mapMetaCampaignToCrmCampaign(auth.companyId, metaCampaignId, crmCampaignId);
  if (!updated) {
    res.status(404).json({ error: "Meta campaign not found." });
    return;
  }

  res.status(200).json({ mapped: true });
}

async function handleUnmapMetaCampaign(req: VercelRequest, res: VercelResponse, metaCampaignId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const updated = await unmapMetaCampaign(auth.companyId, metaCampaignId);
  if (!updated) {
    res.status(404).json({ error: "Meta campaign not found." });
    return;
  }

  res.status(200).json({ unmapped: true });
}

// Day-by-day Reach/Impressions/Clicks/CTR for one Meta campaign - powers
// the performance modal on the Campaigns screen. Same CAMPAIGNS_VIEW gate
// as every other read in this file; deliberately no branch check, matching
// handleGetOneMetaCampaign above - a Meta campaign itself isn't
// branch-scoped (only its optional CRM mapping is), and this is read-only
// performance data, not lead PII.
//
// Two ways to ask for a window, both resolved to a concrete [since, until]
// range before ever touching Meta or the cache:
//   ?days=7|14|30|90   - a preset trailing window ending today.
//   ?since=&until=     - an arbitrary custom range (YYYY-MM-DD each) - "I
//     want to see the entire thing," not just the last 90 days. Capped at
//     MAX_CUSTOM_RANGE_DAYS so nobody (accidentally or otherwise) requests
//     a range large enough to be a real cost/latency problem; Meta's own
//     Insights data doesn't meaningfully go back further than that anyway,
//     so the cap costs nothing a tenant would actually notice.
// `since`/`until` win if both are present; an incomplete pair (only one of
// the two) is a 400, not a silent fallback to the days preset - half a
// custom range is a mistake worth surfacing, not guessing past.
const ALLOWED_INSIGHTS_DAYS = [7, 14, 30, 90];
const MAX_CUSTOM_RANGE_DAYS = 730; // ~2 years
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ResolvedInsightsRange {
  since: string;
  until: string;
  rangeKey: string; // cache key component - distinct per preset AND per distinct custom range
}

/** Returns null (after writing the appropriate error response itself) when
 * the request's range params are invalid - callers just need to bail out
 * on a null return, no separate error-shape handling. */
function resolveInsightsRange(req: VercelRequest, res: VercelResponse): ResolvedInsightsRange | null {
  const sinceParam = getQueryString(req, "since");
  const untilParam = getQueryString(req, "until");

  if (sinceParam || untilParam) {
    if (!sinceParam || !untilParam || !ISO_DATE_RE.test(sinceParam) || !ISO_DATE_RE.test(untilParam)) {
      res.status(400).json({ error: "Provide both 'since' and 'until' as YYYY-MM-DD for a custom range." });
      return null;
    }
    if (sinceParam > untilParam) {
      res.status(400).json({ error: "'since' must be on or before 'until'." });
      return null;
    }
    // Clamped, not rejected - a tenant picking "until" as today or later
    // (e.g. their date picker defaults to today and they never touched it)
    // is a completely normal request, not an error; there's just nothing
    // to chart past today.
    const until = untilParam > todayIsoDate() ? todayIsoDate() : untilParam;
    const spanDays = Math.round((new Date(`${until}T00:00:00Z`).getTime() - new Date(`${sinceParam}T00:00:00Z`).getTime()) / 86_400_000) + 1;
    if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
      res.status(400).json({ error: `That range is too large - pick ${MAX_CUSTOM_RANGE_DAYS} days or fewer.` });
      return null;
    }
    return { since: sinceParam, until, rangeKey: `custom:${sinceParam}:${until}` };
  }

  const requestedDays = Number(getQueryString(req, "days"));
  const days = ALLOWED_INSIGHTS_DAYS.includes(requestedDays) ? requestedDays : 30;
  const untilDate = new Date();
  const sinceDate = new Date(untilDate);
  sinceDate.setUTCDate(sinceDate.getUTCDate() - (days - 1));
  return { since: sinceDate.toISOString().slice(0, 10), until: untilDate.toISOString().slice(0, 10), rangeKey: String(days) };
}

async function handleMetaCampaignInsights(req: VercelRequest, res: VercelResponse, metaCampaignId: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const metaCampaign = await getMetaCampaignWithMappingByRowId(auth.companyId, metaCampaignId);
  if (!metaCampaign) {
    res.status(404).json({ error: "Meta campaign not found." });
    return;
  }

  const range = resolveInsightsRange(req, res);
  if (!range) return; // resolveInsightsRange already wrote the error response

  const cached = await getCachedCampaignInsights(auth.companyId, metaCampaign.metaCampaignId, range.rangeKey);
  if (cached) {
    res.status(200).json({ insights: cached, since: range.since, until: range.until });
    return;
  }

  let connection;
  try {
    connection = await getConnectionForSync(auth.companyId);
  } catch (err) {
    if (err instanceof MetaSyncNotConnectedError) {
      res.status(409).json({ error: "Meta is not connected for this tenant." });
      return;
    }
    throw err;
  }

  try {
    const insights = await getCampaignInsights(metaCampaign.metaCampaignId, connection.accessToken, range.since, range.until);
    await setCachedCampaignInsights(auth.companyId, metaCampaign.metaCampaignId, range.rangeKey, insights);
    res.status(200).json({ insights, since: range.since, until: range.until });
  } catch (err) {
    // Same Phase 16 posture as the sync pipeline (see runMetaSync.ts): an
    // auth-classified failure flags the connection so the tenant sees
    // "Needs Reauthorization" on Settings, rather than this screen alone
    // silently failing to load a chart.
    await flagConnectionIfAuthError(auth.companyId, err, "Campaign insights");
    const message = err instanceof MetaApiError ? err.message : "Failed to load campaign insights from Meta.";
    res.status(502).json({ error: message });
  }
}

// ---------------------------------------------------------------------------
// Billing - campaign/client capacity + Razorpay overage purchases
// (/api/billing/status, /api/billing/order, /api/billing/verify - see
// vercel.json's own rewrites and public/subscription.html, the frontend
// this powers). Folded into this same Vercel Function rather than getting
// its own - see this file's header comment for why every route here
// already shares one function, and README.md's "12-function" constraint.
// ---------------------------------------------------------------------------

async function handleBilling(req: VercelRequest, res: VercelResponse) {
  const action = getQueryString(req, "action");
  if (action === "status") return handleBillingStatus(req, res);
  if (action === "create-order") return handleBillingCreateOrder(req, res);
  if (action === "verify") return handleBillingVerify(req, res);
  res.status(404).json({ error: "Not found" });
}

// Read-only - gated on plain requireAuth (not a specific permission) since
// this is the same status a user gets redirected here to see right after
// hitting a 402 creating a campaign, and CAMPAIGNS_MANAGE holders are not
// necessarily COMPANY_MANAGE holders too. Deliberately does NOT run
// through withEffectiveCompanyContext - billing/capacity is an
// organization-level concern, same "always the caller's own real company"
// posture agencyClientContext.ts documents for admin/company-settings
// endpoints, not something that should ever be swapped by an agency's
// active client context.
async function handleBillingStatus(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const status = await getBillingStatus(auth.companyId);
    res.status(200).json(status);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[billing/status] Failed:", err);
    res.status(500).json({ error: "Failed to load billing status." });
  }
}

// Gated on COMPANY_MANAGE (not CAMPAIGNS_MANAGE) - initiating a real charge
// against the company is an admin-tier action, same tier as company
// profile/settings, not something every campaign-manager-level user should
// be able to trigger on their own.
async function handleBillingCreateOrder(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  const { quantity, cycle } = (req.body ?? {}) as { quantity?: number; cycle?: string };
  if (!quantity || !Number.isInteger(quantity) || quantity < 1) {
    res.status(400).json({ error: "quantity must be a positive whole number." });
    return;
  }
  if (!isBillingCycle(cycle)) {
    res.status(400).json({ error: "Unknown billing cycle." });
    return;
  }

  try {
    const order = await createOverageOrder({ companyId: auth.companyId, createdBy: auth.userId, quantity, cycle });
    res.status(201).json(order);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[billing/create-order] Failed:", err);
    res.status(500).json({ error: "Failed to start payment. Please try again." });
  }
}

// The BROWSER round-trip confirmation - Checkout.js's own success handler
// (see public/subscription.html) POSTs the completed payment's id+
// signature here immediately; the Razorpay webhook (api/webhooks/meta/
// handler.ts's razorpay-webhook branch) is the authoritative fallback if
// this call never happens (tab closed mid-payment, network blip, etc.).
async function handleBillingVerify(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = (req.body ?? {}) as {
    razorpayOrderId?: string;
    razorpayPaymentId?: string;
    razorpaySignature?: string;
  };
  if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
    res.status(400).json({ error: "Missing payment details." });
    return;
  }

  try {
    const result = await verifyAndApplyOveragePayment({ companyId: auth.companyId, razorpayOrderId, razorpayPaymentId, razorpaySignature });
    res.status(200).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[billing/verify] Failed:", err);
    res.status(500).json({ error: "Failed to verify payment." });
  }
}
