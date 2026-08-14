import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import { getCampaign, updateCampaign } from "../../../src/infrastructure/db/repositories/campaigns";
import { PERMISSIONS } from "../../../src/domain/permissions";

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
    res.status(200).json({ campaign });
    return;
  }

  if (req.method === "PATCH") {
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
    if (!auth) return;
    const { name, platform, status } = (req.body ?? {}) as { name?: string; platform?: string; status?: string };
    await updateCampaign(auth.companyId, campaignId, { name, platform, status });
    res.status(200).json({ updated: true });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
