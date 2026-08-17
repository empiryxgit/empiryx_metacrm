// Combines the two onboarding steps (company profile + complete) into ONE
// Vercel Function - see api/auth/handler.ts for why. URLs unchanged:
// /api/onboarding/company, /api/onboarding/complete - vercel.json rewrites
// them here with ?action= injected.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { completeOnboarding, updateCompanyProfile } from "../../src/infrastructure/db/repositories/tenancy";
import { PERMISSIONS } from "../../src/domain/permissions";

function getAction(req: VercelRequest): string {
  const segments = req.query.action;
  if (Array.isArray(segments)) return segments[0] ?? "";
  return typeof segments === "string" ? segments : "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  switch (getAction(req)) {
    case "company":
      return handleCompany(req, res);
    case "complete":
      return handleComplete(req, res);
    default:
      res.status(404).json({ error: "Not found" });
  }
}

// Step 2 of onboarding: collects company profile details. Requires
// company.manage, which the auto-created Owner role always holds, so the
// user who just registered can always complete this step.
async function handleCompany(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  const { industry, companySize, timezone } = (req.body ?? {}) as {
    industry?: string;
    companySize?: string;
    timezone?: string;
  };

  await updateCompanyProfile(auth.companyId, { industry, companySize, timezone });
  res.status(200).json({ updated: true });
}

// Final onboarding step. Deliberately separate from creating the first
// campaign - the frontend wizard calls POST /api/campaigns first (see
// public/onboarding.html), then this, so "onboarding complete" always means
// "this company has at least reached the campaign step," which is what
// /api/auth/me's `company.onboardingCompleted` flag gates navigation on.
async function handleComplete(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  await completeOnboarding(auth.companyId);
  res.status(200).json({ completed: true });
}
