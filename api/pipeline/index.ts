// Company-wide pipeline BOARD data: leads/customers grouped by pipeline
// stage according to the company's active industry template (see
// src/domain/industryTemplates.ts). A campaign is an OPTIONAL filter now,
// not a required scope - the pipeline is one CRM workspace that blends
// digital leads (from any/all connected campaigns) and manually added
// customers, matching the "two sources of customer relationships" product
// concept. Passing ?campaignId= narrows to a single campaign, same as the
// previous behaviour, for callers that still want that.
//
// This endpoint now powers ONLY the Kanban board view (public/pipeline.html
// switched its List view to GET /api/leads, which has real page/pageSize
// pagination - see that handler). A Kanban column can't map onto numbered
// pages the way a flat list can, so instead each stage is capped at
// `stageLimit` (default 100, most-recent-first) rather than paginated -
// see STAGE_LIMIT_DEFAULT below. The company's full lead set is still
// queried once (resolveStageKey's fallback mapping for legacy/unmapped
// `pipelineStage` values can't safely be replicated as a per-stage SQL
// WHERE clause), but each column's response - and therefore what actually
// reaches the browser and gets rendered into the DOM - is capped; a
// `stageMeta` entry per stage reports the true total and whether it was
// truncated, so the UI can say "100 of 340" instead of silently dropping
// rows.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../src/infrastructure/db/client";
import { leads } from "../../src/infrastructure/db/schema";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { withEffectiveCompanyContext } from "../../src/application/agencyClientContext";
import { PERMISSIONS } from "../../src/domain/permissions";
import { getCampaign } from "../../src/infrastructure/db/repositories/campaigns";
import { getCompanyById, listUsers } from "../../src/infrastructure/db/repositories/tenancy";
import { resolveEffectiveIndustryTemplate, resolveStageKey, LEAD_SOURCES } from "../../src/domain/industryTemplates";

const STAGE_LIMIT_DEFAULT = 100;
const STAGE_LIMIT_MAX = 500;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let auth = await requirePermission(req, res, PERMISSIONS.PIPELINE_VIEW);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = resolveEffectiveIndustryTemplate(company.industryTemplate, company.customTemplateConfig);

  const campaignId = typeof req.query.campaignId === "string" && req.query.campaignId ? req.query.campaignId : null;
  let campaign = null;
  if (campaignId) {
    campaign = await getCampaign(auth.companyId, campaignId);
    if (!campaign) {
      res.status(404).json({ error: "Campaign not found." });
      return;
    }
  }

  const stageKeys = template.stages.map((s) => s.key);
  const templatePayload = {
    key: template.key,
    name: template.name,
    pipelineName: template.pipelineName,
    stages: template.stages,
    fields: template.fields,
  };

  // ?meta=1 - template/sources/owners/campaign only, no leads query at all.
  // public/pipeline.html's List view uses this to get everything it needs
  // to render its filter dropdowns WITHOUT paying for the full
  // company-wide leads scan below - it fetches actual rows, paginated and
  // filtered server-side, from GET /api/leads instead (see that handler).
  // This endpoint's own leads query only runs for the Kanban board view,
  // which stays company-wide (per-stage grouping needs the whole set) but
  // is capped per-stage below.
  if (req.query.meta === "1" || req.query.meta === "true") {
    const users = await listUsers(auth.companyId);
    res.status(200).json({
      template: templatePayload,
      sources: LEAD_SOURCES,
      owners: users.map((u) => ({ id: u.id, fullName: u.fullName })),
      campaign,
      stages: stageKeys,
      board: {},
      stageMeta: {},
      stageLimit: STAGE_LIMIT_DEFAULT,
    });
    return;
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

  const rawStageLimit = Number(req.query.stageLimit);
  const stageLimit = Number.isFinite(rawStageLimit) && rawStageLimit > 0 ? Math.min(Math.floor(rawStageLimit), STAGE_LIMIT_MAX) : STAGE_LIMIT_DEFAULT;

  const board: Record<string, typeof rows> = Object.fromEntries(stageKeys.map((k) => [k, []]));
  for (const row of rows) {
    const stage = resolveStageKey(template, row.pipelineStage);
    (board[stage] ??= []).push(row);
  }

  // Cap each column AFTER stage resolution (rows are already
  // most-recent-first from the query above) - see this file's header
  // comment for why this is capped rather than paginated or queried
  // per-stage.
  const stageMeta: Record<string, { total: number; truncated: boolean }> = {};
  for (const key of stageKeys) {
    const full = board[key] ?? [];
    stageMeta[key] = { total: full.length, truncated: full.length > stageLimit };
    board[key] = full.slice(0, stageLimit);
  }

  res.status(200).json({
    template: templatePayload,
    sources: LEAD_SOURCES,
    owners: users.map((u) => ({ id: u.id, fullName: u.fullName })),
    campaign,
    stages: stageKeys,
    board,
    stageMeta,
    stageLimit,
  });
}
