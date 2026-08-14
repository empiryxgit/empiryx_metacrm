// Admin "create user" form: the admin sets name/email/role, the system
// generates a temporary password and returns it ONCE in this response body
// (never stored in plaintext, never emailed - see the architecture doc for
// why: no transactional-email dependency needed to stay free-tier-only).
// The admin relays it to the new user, who must change it on first login
// (see mustChangePassword on the users table + api/auth/change-password.ts).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../../src/infrastructure/auth/context";
import { createUser, emailExists, getRoleById, listUsers } from "../../../src/infrastructure/db/repositories/tenancy";
import { generateTempPassword, hashPassword } from "../../../src/infrastructure/auth/password";
import { PERMISSIONS } from "../../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
