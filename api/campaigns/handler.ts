// Combines list/create (/api/campaigns), read/update
// (/api/campaigns/{campaignId}), and the "add webhook" screen
// (/api/campaigns/{campaignId}/webhook) into ONE Vercel Function - see
// api/auth/handler.ts for why. Public URLs unchanged - vercel.json rewrites
// them here with campaignId/sub injected as query params (Vercel's
// filesystem [[...x]].ts catch-all convention was found not to reliably
// populate req.query in this deployment, so every dynamic route now uses
// the same explicit-rewrite pattern api/system.ts already relied on).

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
import { PERMISSIONS } from "../../src/domain/permissions";
import { assertBranchAccessible, resolveBranchAccess } from "../../src/application/branchAccess";

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
    const campaigns = await listCampaigns(auth.companyId, resolveBranchAccess(auth));
    res.status(200).json({ campaigns });
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
    res.status(200).json({ campaign });
    return;
  }

  if (req.method === "PATCH") {
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
    if (!auth) return;
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
    const config = await getWebhookConfigForCampaign(auth.companyId, campaignId, getBaseUrl(req));
    res.status(200).json({ webhook: config });
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
