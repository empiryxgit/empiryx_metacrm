// Drag-and-drop target for the pipeline board (public/pipeline.html).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import { updateLeadPipelineStage } from "../../../src/infrastructure/db/repositories";
import { PERMISSIONS, PIPELINE_STAGE_KEYS } from "../../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "PATCH") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.PIPELINE_MANAGE);
  if (!auth) return;

  const leadId = req.query.leadId as string;
  const { stage } = (req.body ?? {}) as { stage?: string };

  if (!stage || !PIPELINE_STAGE_KEYS.includes(stage as never)) {
    res.status(400).json({ error: `stage must be one of: ${PIPELINE_STAGE_KEYS.join(", ")}` });
    return;
  }

  await updateLeadPipelineStage(auth.companyId, leadId, stage);
  res.status(200).json({ updated: true });
}
