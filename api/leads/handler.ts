// Combines lead listing (/api/leads) and the pipeline drag-and-drop stage
// update (/api/leads/{leadId}/stage) into ONE Vercel Function - see
// api/auth/handler.ts for why. Public URLs unchanged - vercel.json rewrites
// them here with leadId/sub injected as query params (Vercel's filesystem
// [[...x]].ts catch-all convention was found not to reliably populate
// req.query in this deployment, so every dynamic route now uses the same
// explicit-rewrite pattern api/system.ts already relied on).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../../src/infrastructure/db/client";
import { leads } from "../../src/infrastructure/db/schema";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { insertManualLead, updateLeadCrmFields, updateLeadPipelineStage } from "../../src/infrastructure/db/repositories";
import { PERMISSIONS } from "../../src/domain/permissions";
import { getCompanyById } from "../../src/infrastructure/db/repositories/tenancy";
import { assertBranchAccessible, resolveBranchAccess } from "../../src/application/branchAccess";
import { branchAccessCondition } from "../../src/infrastructure/db/branchFilter";
import {
  getIndustryTemplate,
  getInitialStageKey,
  isValidStageKey,
  MANUAL_LEAD_SOURCE_KEYS,
  type IndustryTemplate,
} from "../../src/domain/industryTemplates";

/** Keeps custom-field storage limited to whatever the active template
 * actually defines - an old/edited template can never leave orphaned keys
 * behind, and a client can't smuggle arbitrary keys into the jsonb blob. */
function sanitizeCustomFields(template: IndustryTemplate, raw: unknown): Record<string, unknown> {
  const input = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of template.fields) {
    const value = input[field.key];
    if (value === undefined || value === null || value === "") continue;
    out[field.key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

function getQueryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const leadId = getQueryString(req, "leadId");
  const subresource = getQueryString(req, "sub");

  if (!leadId) {
    if (req.method === "GET") return handleList(req, res);
    if (req.method === "POST") return handleCreate(req, res);
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (subresource === "stage") return handleStage(req, res, leadId);
  if (!subresource) return handleUpdate(req, res, leadId);

  res.status(404).json({ error: "Not found" });
}

// Read-only lead listing for the dashboard, the pipeline board, and for
// downstream consumers (e.g. an internal tool, or n8n polling) - company-
// scoped so one tenant never sees another's leads. NOT the integration
// point for n8n's writes; n8n consumes CRM events separately and
// asynchronously (see README "n8n integration"), it never calls into this
// ingestion service directly, so a slow or failing n8n workflow can never
// block or lose a Meta lead.
async function handleList(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.LEADS_VIEW);
  if (!auth) return;

  const limit = Math.min(Number(req.query.limit ?? 50), 200);
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const campaignId = typeof req.query.campaignId === "string" ? req.query.campaignId : undefined;
  const requestedBranchId = typeof req.query.branchId === "string" ? req.query.branchId : undefined;

  // An explicit ?branchId= narrows to that one branch, still combined with
  // company-wide rows the same way every other branch filter is (validated
  // against both tenant isolation and the caller's own branch access via
  // assertBranchAccessible); omitted, it falls back to the caller's full
  // branch access (every branch they're allowed to see, plus company-wide
  // rows) - never unfiltered across branches the caller doesn't belong to.
  let branchCondition;
  if (requestedBranchId !== undefined) {
    const assertion = await assertBranchAccessible(auth, requestedBranchId);
    if (!assertion.ok) {
      res.status(assertion.status).json({ error: assertion.error });
      return;
    }
    branchCondition = branchAccessCondition(
      leads.branchId,
      { scope: "restricted", branchIds: assertion.branchId ? [assertion.branchId] : [] },
    );
  } else {
    branchCondition = branchAccessCondition(leads.branchId, resolveBranchAccess(auth));
  }

  try {
    const db = await getDb();
    const conditions = [eq(leads.companyId, auth.companyId)];
    if (status) conditions.push(eq(leads.status, status));
    if (campaignId) conditions.push(eq(leads.crmCampaignId, campaignId));
    if (branchCondition) conditions.push(branchCondition);

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

// Drag-and-drop target for the pipeline board (public/pipeline.html).
async function handleStage(req: VercelRequest, res: VercelResponse, leadId: string) {
  if (req.method !== "PATCH") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.PIPELINE_MANAGE);
  if (!auth) return;

  const { stage } = (req.body ?? {}) as { stage?: string };

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);

  if (!stage || !isValidStageKey(template, stage)) {
    res.status(400).json({ error: `stage must be one of: ${template.stages.map((s) => s.key).join(", ")}` });
    return;
  }

  // A branch-restricted user must never be able to move a card belonging to
  // a lead outside their own branch access, even though it shares their
  // company - folded into the UPDATE's own WHERE clause (see
  // updateLeadPipelineStage), same "company_id + branch_id enforced on the
  // backend" contract as every other branch-scoped write in this codebase.
  const branchCondition = branchAccessCondition(leads.branchId, resolveBranchAccess(auth));
  const updated = await updateLeadPipelineStage(auth.companyId, leadId, stage, branchCondition);
  if (!updated) {
    res.status(404).json({ error: "Lead not found." });
    return;
  }
  res.status(200).json({ updated: true });
}

interface ManualCreateBody {
  fullName?: string;
  phoneNumber?: string;
  email?: string;
  source?: string;
  ownerId?: string;
  branchId?: string;
  pipelineStage?: string;
  nextFollowUpAt?: string;
  notes?: string;
  customFields?: Record<string, unknown>;
}

// "+ Add Customer" - a brand-new, manually-entered customer with no
// originating Meta lead. See insertManualLead() for why this never touches
// the ingestion path.
async function handleCreate(req: VercelRequest, res: VercelResponse) {
  const auth = await requirePermission(req, res, PERMISSIONS.LEADS_MANAGE);
  if (!auth) return;

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);

  const body = (req.body ?? {}) as ManualCreateBody;
  const fullName = body.fullName?.trim();
  const phoneNumber = body.phoneNumber?.trim();
  if (!fullName || !phoneNumber) {
    res.status(400).json({ error: "fullName and phoneNumber are required." });
    return;
  }

  const source = body.source && MANUAL_LEAD_SOURCE_KEYS.includes(body.source) ? body.source : "other";
  const stage = body.pipelineStage && isValidStageKey(template, body.pipelineStage)
    ? body.pipelineStage
    : getInitialStageKey(template);
  const nextFollowUpAt = body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : undefined;

  const branchAssertion = await assertBranchAccessible(auth, body.branchId);
  if (!branchAssertion.ok) {
    res.status(branchAssertion.status).json({ error: branchAssertion.error });
    return;
  }

  try {
    const lead = await insertManualLead({
      companyId: auth.companyId,
      branchId: branchAssertion.branchId,
      fullName,
      phoneNumber,
      email: body.email?.trim() || undefined,
      source,
      ownerId: body.ownerId || undefined,
      pipelineStage: stage,
      nextFollowUpAt: Number.isNaN(nextFollowUpAt?.getTime()) ? undefined : nextFollowUpAt,
      notes: body.notes?.trim() || undefined,
      customFields: sanitizeCustomFields(template, body.customFields),
    });
    res.status(201).json({ lead });
  } catch (err) {
    console.error("[leads] Failed to create manual customer:", err);
    res.status(500).json({ error: "Failed to create customer." });
  }
}

interface UpdateBody {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  ownerId?: string | null;
  branchId?: string | null;
  pipelineStage?: string;
  nextFollowUpAt?: string | null;
  notes?: string;
  customFields?: Record<string, unknown>;
}

// General CRM-field update, including "Not interested -> Add to CRM"
// (enriching an existing Meta lead with owner/stage/notes/custom fields
// without touching its source/campaign attribution).
async function handleUpdate(req: VercelRequest, res: VercelResponse, leadId: string) {
  if (req.method !== "PATCH") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.LEADS_MANAGE);
  if (!auth) return;

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);

  const body = (req.body ?? {}) as UpdateBody;
  const patch: Record<string, unknown> = {};

  if (body.fullName !== undefined) patch.fullName = body.fullName.trim();
  if (body.email !== undefined) patch.email = body.email.trim() || null;
  if (body.phoneNumber !== undefined) patch.phoneNumber = body.phoneNumber.trim() || null;
  if (body.ownerId !== undefined) patch.ownerId = body.ownerId || null;
  if (body.notes !== undefined) patch.notes = body.notes.trim() || null;
  if (body.customFields !== undefined) patch.customFields = sanitizeCustomFields(template, body.customFields);
  if (body.nextFollowUpAt !== undefined) {
    const d = body.nextFollowUpAt ? new Date(body.nextFollowUpAt) : null;
    patch.nextFollowUpAt = d && !Number.isNaN(d.getTime()) ? d : null;
  }
  if (body.pipelineStage !== undefined) {
    if (!isValidStageKey(template, body.pipelineStage)) {
      res.status(400).json({ error: `pipelineStage must be one of: ${template.stages.map((s) => s.key).join(", ")}` });
      return;
    }
    patch.pipelineStage = body.pipelineStage;
  }
  if (body.branchId !== undefined) {
    const branchAssertion = await assertBranchAccessible(auth, body.branchId);
    if (!branchAssertion.ok) {
      res.status(branchAssertion.status).json({ error: branchAssertion.error });
      return;
    }
    patch.branchId = branchAssertion.branchId;
  }

  try {
    // Same branch-authorization gate as handleStage above - a lead the
    // caller doesn't have branch access to matches zero rows regardless of
    // what's in `patch`, including an attempted branchId reassignment (the
    // NEW branchId is separately validated above via assertBranchAccessible;
    // this guards the row's CURRENT branch instead).
    const branchCondition = branchAccessCondition(leads.branchId, resolveBranchAccess(auth));
    const lead = await updateLeadCrmFields(auth.companyId, leadId, patch, branchCondition);
    if (!lead) {
      res.status(404).json({ error: "Lead not found." });
      return;
    }
    res.status(200).json({ lead });
  } catch (err) {
    console.error("[leads] Failed to update lead:", err);
    res.status(500).json({ error: "Failed to update lead." });
  }
}
