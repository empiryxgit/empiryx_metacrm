// Company-wide pipeline board data: every lead/customer for the company,
// grouped by pipeline stage according to the company's active industry
// template (see src/domain/industryTemplates.ts). A campaign is an OPTIONAL
// filter now, not a required scope - the pipeline is one CRM workspace that
// blends digital leads (from any/all connected campaigns) and manually
// added customers, matching the "two sources of customer relationships"
// product concept. Passing ?campaignId= narrows to a single campaign, same
// as the previous behaviour, for callers that still want that.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../src/infrastructure/db/client";
import { leads } from "../../src/infrastructure/db/schema";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { PERMISSIONS } from "../../src/domain/permissions";
import { getCampaign } from "../../src/infrastructure/db/repositories/campaigns";
import { getCompanyById, listUsers } from "../../src/infrastructure/db/repositories/tenancy";
import { getIndustryTemplate, resolveStageKey, LEAD_SOURCES } from "../../src/domain/industryTemplates";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.PIPELINE_VIEW);
  if (!auth) return;

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);

  const campaignId = typeof req.query.campaignId === "string" && req.query.campaignId ? req.query.campaignId : null;
  let campaign = null;
  if (campaignId) {
    campaign = await getCampaign(auth.companyId, campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found." });
      return;
    }
  }

  const db = await getDb();
  const conditions = [eq(leads.companyId, auth.companyId)];
  if (campaignId) conditions.push(eq(leads.crmCampaignId, campaignId));

  const [rows, users] = await Promise.all([
    db
      .select()
      .from(leads)
      .where(and(...conditions))
      .orderBy(desc(leads.createdAt)),
    listUsers(auth.companyId),
  ]);

  const stageKeys = template.stages.map((s) => s.key);
  const board: Record<string, typeof rows> = Object.fromEntries(stageKeys.map((k) => [k, []]));
  for (const row of rows) {
    const stage = resolveStageKey(template, row.pipelineStage);
    (board[stage] ??= []).push(row);
  }

  res.status(200).json({
    template: {
      key: template.key,
      name: template.name,
      pipelineName: template.pipelineName,
      stages: template.stages,
      fields: template.fields,
    },
    sources: LEAD_SOURCES,
    owners: users.map((u) => ({ id: u.id, fullName: u.fullName })),
    campaign,
    stages: stageKeys,
    board,
  });
}
