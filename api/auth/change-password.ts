// Called right after login when the response's user.mustChangePassword is
// true (temporary password issued by an admin - see api/admin/users/index.ts).
// Also usable as a general "change my password" action from account settings.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth } from "../../src/infrastructure/auth/context";
import { getUserById } from "../../src/infrastructure/db/repositories/tenancy";
import { hashPassword, verifyPassword } from "../../src/infrastructure/auth/password";
import { setUserPassword, revokeAllSessionsForUser } from "../../src/infrastructure/db/repositories/tenancy";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
  if (!newPassword || newPassword.length < 10) {
    res.status(400).json({ error: "newPassword must be at least 10 characters." });
    return;
  }

  const user = await getUserById(auth.userId);
  if (!user) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }

  // A temp password flow (mustChangePassword) still requires knowing the
  // current password - it was relayed by the admin, not skippable.
  if (!currentPassword || !(await verifyPassword(currentPassword, user.passwordHash))) {
    res.status(401).json({ error: "Current password is incorrect." });
    return;
  }

  const newHash = await hashPassword(newPassword);
  await setUserPassword(user.id, newHash, false);
  // Force re-login everywhere else - a password change should invalidate
  // every other outstanding session.
  await revokeAllSessionsForUser(user.id);

  res.status(200).json({ changed: true });
}
