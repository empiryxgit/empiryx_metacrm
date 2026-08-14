import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import { createRole, listRoles } from "../../../src/infrastructure/db/repositories/tenancy";
import { ALL_PERMISSIONS, PERMISSIONS } from "../../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
    if (!auth) return;
    const roles = await listRoles(auth.companyId);
    res.status(200).json({ roles });
    return;
  }

  if (req.method === "POST") {
    const auth = await requirePermission(req, res, PERMISSIONS.ROLES_MANAGE);
    if (!auth) return;

    const { name, description, permissions } = (req.body ?? {}) as {
      name?: string;
      description?: string;
      permissions?: string[];
    };

    if (!name || !Array.isArray(permissions) || permissions.length === 0) {
      res.status(400).json({ error: "name and at least one permission are required." });
      return;
    }

    const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p as never));
    if (invalid.length > 0) {
      res.status(400).json({ error: `Unknown permission code(s): ${invalid.join(", ")}` });
      return;
    }

    const role = await createRole({ companyId: auth.companyId, name, description, permissions });
    res.status(201).json({ role });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
