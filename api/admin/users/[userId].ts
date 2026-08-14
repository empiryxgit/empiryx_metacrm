import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import {
  countOtherActiveUsersWithRole,
  getRoleById,
  getUserById,
  updateUser,
} from "../../../src/infrastructure/db/repositories/tenancy";
import { PERMISSIONS } from "../../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
  if (!auth) return;

  const userId = req.query.userId as string;

  if (req.method === "PATCH") {
    const { roleId, status, fullName } = (req.body ?? {}) as {
      roleId?: string;
      status?: string;
      fullName?: string;
    };

    if (roleId) {
      const role = await getRoleById(auth.companyId, roleId);
      if (!role) {
        res.status(400).json({ error: "That role does not belong to this company." });
        return;
      }
    }

    // Guard rail: don't allow disabling or re-roling the last active user
    // who holds a role capable of managing users - that would permanently
    // lock the company out of its own admin panel.
    if (status === "disabled" || roleId) {
      const target = await getUserById(userId);
      if (target) {
        const others = await countOtherActiveUsersWithRole(auth.companyId, target.roleId, userId);
        const targetRole = await getRoleById(auth.companyId, target.roleId);
        const targetManagesUsers = ((targetRole?.permissions as string[]) ?? []).includes(PERMISSIONS.USERS_MANAGE);
        if (targetManagesUsers && others === 0) {
          res.status(409).json({ error: "Cannot disable or re-role the last admin who can manage users." });
          return;
        }
      }
    }

    await updateUser(auth.companyId, userId, { roleId, status, fullName });
    res.status(200).json({ updated: true });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}
