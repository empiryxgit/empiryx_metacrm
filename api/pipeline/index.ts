// Kanban board data: every lead for a campaign, grouped by pipeline stage.
// A campaign is required - the pipeline is always viewed one campaign at a
// time (see public/pipeline.html), matching "inside a campaign" from the
// product brief.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../src/infrastructure/db/client";
import { leads } from "../../src/infrastructure/db/schema";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { PERMISSIONS, PIPELINE_STAGE_KEYS, type PipelineStage } from "../../src/domain/permissions";
import { getCampaign } from "../../src/infrastructure/db/repositories/campaigns";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.PIPELINE_VIEW);
  if (!auth) return;

  const campaignId = req.query.campaignId as string;
  if (!campaignId) {
    res.status(400).json({ error: "campaignId is required." });
    return;
  }

  const campaign = await getCampaign(auth.companyId, campaignId);
  if (!campaign) {
    res.status(404).json({ error: "Campaign not found." });
    return;
  }

  const db = await getDb();
  const rows = await db
    .select()
    .from(leads)
    .where(and(eq(leads.companyId, auth.companyId), eq(leads.crmCampaignId, campaignId)))
    .orderBy(desc(leads.createdAt));

  const board = Object.fromEntries(PIPELINE_STAGE_KEYS.map((k) => [k, [] as typeof rows])) as Record<
    PipelineStage,
    typeof rows
  >;
  const stageKeySet = new Set<string>(PIPELINE_STAGE_KEYS);
  for (const row of rows) {
    const stage = stageKeySet.has(row.pipelineStage) ? (row.pipelineStage as PipelineStage) : "new";
    board[stage].push(row);
  }

  res.status(200).json({ campaign, stages: PIPELINE_STAGE_KEYS, board });
}
