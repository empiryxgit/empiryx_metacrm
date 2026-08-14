// Returns the current user + company + permissions, and whether onboarding
// is complete - the frontend's single source of truth for "am I logged in,
// and where should I land" on every page load.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getAuthContext } from "../../src/infrastructure/auth/context";
import { getUserById, getCompanyById, getRoleById } from "../../src/infrastructure/db/repositories/tenancy";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await getAuthContext(req);
  if (!auth) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const [user, company, role] = await Promise.all([
    getUserById(auth.userId),
    getCompanyById(auth.companyId),
    getRoleById(auth.companyId, auth.roleId),
  ]);

  if (!user || !company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }

  res.status(200).json({
    user: { id: user.id, email: user.email, fullName: user.fullName, mustChangePassword: user.mustChangePassword },
    company: {
      id: company.id,
      name: company.name,
      slug: company.slug,
      onboardingCompleted: Boolean(company.onboardingCompletedAt),
    },
    role: role ? { id: role.id, name: role.name, permissions: role.permissions } : null,
  });
}
