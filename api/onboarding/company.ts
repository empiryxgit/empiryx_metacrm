// Step 2 of onboarding: collects company profile details. Requires
// company.manage, which the auto-created Owner role always holds, so the
// user who just registered can always complete this step.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { updateCompanyProfile } from "../../src/infrastructure/db/repositories/tenancy";
import { PERMISSIONS } from "../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
