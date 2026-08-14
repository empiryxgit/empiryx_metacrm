import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { createCampaign, listCampaigns } from "../../src/infrastructure/db/repositories/campaigns";
import { PERMISSIONS } from "../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_VIEW);
    if (!auth) return;
    const campaigns = await listCampaigns(auth.companyId);
    res.status(200).json({ campaigns });
    return;
  }

  if (req.method === "POST") {
    const auth = await requirePermission(req, res, PERMISSIONS.CAMPAIGNS_MANAGE);
    if (!auth) return;

    const { name, platform } = (req.body ?? {}) as { name?: string; platform?: string };
    if (!name) {
      res.status(400).json({ error: "name is required." });
      return;
    }

    const campaign = await createCampaign({
      companyId: auth.companyId,
      name,
      platform: platform && ["facebook", "instagram", "both"].includes(platform) ? platform : "facebook",
      createdBy: auth.userId,
    });
    res.status(201).json({ campaign });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
