// Final onboarding step. Deliberately separate from creating the first
// campaign - the frontend wizard calls POST /api/campaigns first (see
// public/onboarding.html), then this, so "onboarding complete" always means
// "this company has at least reached the campaign step," which is what
// /api/auth/me's `company.onboardingCompleted` flag gates navigation on.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { completeOnboarding } from "../../src/infrastructure/db/repositories/tenancy";
import { PERMISSIONS } from "../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  await completeOnboarding(auth.companyId);
  res.status(200).json({ completed: true });
}
