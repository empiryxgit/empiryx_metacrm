// Read-only lead listing for the dashboard, the pipeline board, and for
// downstream consumers (e.g. an internal tool, or n8n polling) - company-
// scoped so one tenant never sees another's leads. NOT the integration
// point for n8n's writes; n8n consumes CRM events separately and
// asynchronously (see README "n8n integration"), it never calls into this
// ingestion service directly, so a slow or failing n8n workflow can never
// block or lose a Meta lead.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../src/infrastructure/db/client";
import { leads } from "../../src/infrastructure/db/schema";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { PERMISSIONS } from "../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.LEADS_VIEW);
  if (!auth) return;

  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;

  try {
    const db = await getDb();
    const conditions = [eq(leads.companyId, auth.companyId)];
    if (status) conditions.push(eq(leads.status, status));
    if (campaignId) conditions.push(eq(leads.crmCampaignId, campaignId));

    const rows = await db
      .select()
      .from(leads)
      .where(and(...conditions))
      .orderBy(desc(leads.createdAt))
      .limit(limit);

    res.status(200).json({ leads: rows });
  } catch (err) {
    console.error("[leads] Failed to list leads:", err);
    res.status(500).json({ error: "Failed to list leads" });
  }
}
