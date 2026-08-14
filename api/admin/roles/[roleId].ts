import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import { deleteRole, getRoleById, roleInUse, updateRole } from "../../../src/infrastructure/db/repositories/tenancy";
import { ALL_PERMISSIONS, PERMISSIONS } from "../../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await requirePermission(req, res, PERMISSIONS.ROLES_MANAGE);
  if (!auth) return;

  const roleId = req.query.roleId as string;
  const role = await getRoleById(auth.companyId, roleId);
  if (!role) {
    res.status(404).json({ error: "Role not found." });
    return;
  }
  if (role.isSystem) {
    res.status(403).json({ error: "The Owner role cannot be edited or deleted." });
    return;
  }

  if (req.method === "PATCH") {
    const { name, description, permissions } = (req.body ?? {}) as {
      name?: string;
      description?: string;
      permissions?: string[];
    };
    if (permissions) {
      const invalid = permissions.filter((p) => !ALL_PERMISSIONS.includes(p as never));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Unknown permission code(s): ${invalid.join(", ")}` });
        return;
      }
    }
    await updateRole(auth.companyId, roleId, { name, description, permissions });
    res.status(200).json({ updated: true });
    return;
  }

  if (req.method === "DELETE") {
    if (await roleInUse(roleId)) {
      res.status(409).json({ error: "This role is still assigned to at least one user - reassign them first." });
      return;
    }
    await deleteRole(auth.companyId, roleId);
    res.status(200).json({ deleted: true });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
