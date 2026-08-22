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
import { requirePermission } from "../../src/infrastructure/auth/context";
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
  listMetaCampaignsWithMapping,
  mapMetaCampaignToCrmCampaign,
  unmapMetaCampaign,
} from "../../src/infrastructure/db/repositories/metaSync";
import { PERMISSIONS } from "../../src/domain/permissions";
import { assertBranchAccessible, canAccessBranch, resolveBranchAccess } from "../../src/application/branchAccess";
import { listBranches } from "../../src/infrastructure/db/repositories/branches";
import { evaluateLegacyWebhookMigration } from "../../src/application/metaSync/legacyMigration";

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

  const campaignId = getQueryString(req, "campaignId");
  const subresource = getQueryString(req, "sub");

  if (!campaignId) return handleCollection(req, res);
  if (!subresource) return handleOne(req, res, campaignId);
  if (subresource === "webhook") return handleWebhook(req, res, campaignId);

  res.status(404).json({ error: "Not found" });
}

async function handleCollection(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
    if (!auth) return;

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
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
    if (!auth) return;

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
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
    if (!auth) return;
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
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
    if (!auth) return;

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
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
    if (!auth) return;
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
    const auth = await requirePermission(req, res, PERMISSIONS.WEBHOOKS_MANAGE);
    if (!auth) return;

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

  const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
  if (!auth) return;

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

  const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
  if (!auth) return;

  const metaCampaigns = await listMetaCampaignsWithMapping(auth.companyId);
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

  const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
  if (!auth) return;

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

  const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
  if (!auth) return;

  const updated = await unmapMetaCampaign(auth.companyId, metaCampaignId);
  if (!updated) {
    res.status(404).json({ error: "Meta campaign not found." });
    return;
  }

  res.status(200).json({ unmapped: true });
}
