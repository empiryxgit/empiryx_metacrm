// Combines list/create (/api/admin/users) and update
// (/api/admin/users/{userId}) into ONE Vercel Function - see
// api/auth/handler.ts for why. Public URLs unchanged - vercel.json rewrites
// /api/admin/users/:userId here with userId injected as a query param
// (Vercel's filesystem [[...x]].ts catch-all convention was found not to
// reliably populate req.query in this deployment, so every dynamic route
// now uses the same explicit-rewrite pattern api/system.ts already relied
// on).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import {
  countOtherActiveUsersWithRole,
  createUser,
  emailExists,
  getRoleById,
  getUserById,
  listUsers,
  updateUser,
} from "../../../src/infrastructure/db/repositories/tenancy";
import { generateTempPassword, hashPassword } from "../../../src/infrastructure/auth/password";
import { PERMISSIONS } from "../../../src/domain/permissions";

function getUserId(req: VercelRequest): string | undefined {
  const value = req.query.userId;
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const userId = getUserId(req);
  if (userId) {
    return handleOne(req, res, userId);
  }
  return handleCollection(req, res);
}

// Admin "create user" form: the admin sets name/email/role, the system
// generates a temporary password and returns it ONCE in this response body
// (never stored in plaintext, never emailed - see the architecture doc for
// why: no transactional-email dependency needed to stay free-tier-only).
// The admin relays it to the new user, who must change it on first login
// (see mustChangePassword on the users table + api/auth/[[...action]].ts).
async function handleCollection(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
    if (!auth) return;
    const users = await listUsers(auth.companyId);
    res.status(200).json({ users });
    return;
  }

  if (req.method === "POST") {
    const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
    if (!auth) return;

    const { fullName, email, roleId } = (req.body ?? {}) as { fullName?: string; email?: string; roleId?: string };
    if (!fullName || !email || !roleId) {
      res.status(400).json({ error: "fullName, email and roleId are all required." });
      return;
    }

    const role = await getRoleById(auth.companyId, roleId);
    if (!role) {
      res.status(400).json({ error: "That role does not belong to this company." });
      return;
    }
    if (await emailExists(email)) {
      res.status(409).json({ error: "A user with this email already exists." });
      return;
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const user = await createUser({
      companyId: auth.companyId,
      roleId,
      email,
      passwordHash,
      fullName,
      mustChangePassword: true,
    });

    res.status(201).json({
      user: { id: user.id, email: user.email, fullName: user.fullName },
      // Shown exactly once - the client must display this to the admin
      // immediately and cannot retrieve it again.
      temporaryPassword: tempPassword,
    });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function handleOne(req: VercelRequest, res: VercelResponse, userId: string) {
  const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
  if (!auth) return;

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
