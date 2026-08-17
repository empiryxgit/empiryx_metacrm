// Combines list/create (/api/admin/roles) and update/delete
// (/api/admin/roles/{roleId}) into ONE Vercel Function - see
// api/auth/handler.ts for why. Public URLs unchanged - vercel.json rewrites
// /api/admin/roles/:roleId here with roleId injected as a query param
// (Vercel's filesystem [[...x]].ts catch-all convention was found not to
// reliably populate req.query in this deployment, so every dynamic route
// now uses the same explicit-rewrite pattern api/system.ts already relied
// on).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import {
  createRole,
  deleteRole,
  getRoleById,
  listRoles,
  roleInUse,
  updateRole,
} from "../../../src/infrastructure/db/repositories/tenancy";
import { ALL_PERMISSIONS, PERMISSIONS } from "../../../src/domain/permissions";

function getRoleId(req: VercelRequest): string | undefined {
  const value = req.query.roleId;
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const roleId = getRoleId(req);
  if (roleId) {
    return handleOne(req, res, roleId);
  }
  return handleCollection(req, res);
}

async function handleCollection(req: VercelRequest, res: VercelResponse) {
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

async function handleOne(req: VercelRequest, res: VercelResponse, roleId: string) {
  const auth = await requirePermission(req, res, PERMISSIONS.ROLES_MANAGE);
  if (!auth) return;

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
