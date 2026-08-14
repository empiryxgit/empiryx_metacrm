// Powers the role editor UI (public/admin/roles.html) - the fixed catalog
// of permission codes an admin can assign to a custom role.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth } from "../src/infrastructure/auth/context";
import { PERMISSION_CATALOG } from "../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  res.status(200).json({ permissions: PERMISSION_CATALOG });
}
