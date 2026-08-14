// "Inside a campaign, add the webhook" - this is that screen's API. GET
// returns the (masked) current config plus the exact URL to paste into
// Meta's App Dashboard; POST creates or updates it. The webhook itself
// only starts accepting events once Meta completes the GET verification
// handshake against this URL (see api/webhooks/meta/[slug].ts), which
// flips status from "pending" to "verified".

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import { getCampaign } from "../../../src/infrastructure/db/repositories/campaigns";
import { getWebhookConfigForCampaign, upsertWebhookConfig } from "../../../src/infrastructure/db/repositories/campaigns";
import { PERMISSIONS } from "../../../src/domain/permissions";

function getBaseUrl(req: VercelRequest): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  return `${proto}://${req.headers.host}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const campaignId = req.query.campaignId as string;

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
