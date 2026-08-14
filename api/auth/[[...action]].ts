// Combines register/login/refresh/logout/me/change-password into ONE Vercel
// Function via an optional catch-all route, dispatching on the path segment
// after /api/auth/. Purely a deployment-footprint optimization (Vercel's
// Hobby plan caps a deployment at 12 Functions total) - every handler below
// is byte-for-byte the same logic as when each lived in its own file; the
// public URLs (/api/auth/register, /api/auth/login, ...) are unchanged, so
// no frontend code needed to move.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AuthError, login, logout, refresh, registerCompanyAndOwner } from "../../src/application/auth";
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
  cookieOptions,
  clearCookieOptions,
} from "../../src/infrastructure/auth/tokens";
import { getAuthContext, parseCookies, requireAuth } from "../../src/infrastructure/auth/context";
import {
  getCompanyById,
  getRoleById,
  getUserById,
  revokeAllSessionsForUser,
  setUserPassword,
} from "../../src/infrastructure/db/repositories/tenancy";
import { hashPassword, verifyPassword } from "../../src/infrastructure/auth/password";

function getAction(req: VercelRequest): string {
  const segments = req.query.action;
  if (Array.isArray(segments)) return segments[0] ?? "";
  return typeof segments === "string" ? segments : "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  switch (getAction(req)) {
    case "register":
      return handleRegister(req, res);
    case "login":
      return handleLogin(req, res);
    case "refresh":
      return handleRefresh(req, res);
    case "logout":
      return handleLogout(req, res);
    case "me":
      return handleMe(req, res);
    case "change-password":
      return handleChangePassword(req, res);
    default:
      res.status(404).json({ error: "Not found" });
  }
}

interface RegisterBody {
  companyName: string;
  fullName: string;
  email: string;
  password: string;
}

async function handleRegister(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as RegisterBody;
  if (!body?.companyName || !body?.fullName || !body?.email || !body?.password) {
    res.status(400).json({ error: "companyName, fullName, email and password are all required." });
    return;
  }

  try {
    await registerCompanyAndOwner(body);

    // Log the new owner in immediately - registration and first login are
    // the same moment from the user's perspective.
    const tokens = await login({
      email: body.email,
      password: body.password,
      userAgent: req.headers["user-agent"],
      ipAddress: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
    });

    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(15 * 60)}`,
      `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(REFRESH_TOKEN_TTL_SECONDS)}`,
    ]);
    res.status(201).json({ user: tokens.user });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[auth/register] Failed:", err);
    res.status(500).json({ error: "Registration failed." });
  }
}

async function handleLogin(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required." });
    return;
  }

  try {
    const tokens = await login({
      email,
      password,
      userAgent: req.headers["user-agent"],
      ipAddress: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
    });

    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(15 * 60)}`,
      `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(REFRESH_TOKEN_TTL_SECONDS)}`,
    ]);
    res.status(200).json({ user: tokens.user });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[auth/login] Failed:", err);
    res.status(500).json({ error: "Login failed." });
  }
}

async function handleRefresh(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cookies = parseCookies(req);
  const refreshToken = cookies[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    res.status(401).json({ error: "No refresh token." });
    return;
  }

  try {
    const tokens = await refresh(refreshToken);
    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(15 * 60)}`,
      `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(REFRESH_TOKEN_TTL_SECONDS)}`,
    ]);
    res.status(200).json({ user: tokens.user });
  } catch (err) {
    // A rejected refresh always clears cookies - forces a clean re-login
    // rather than leaving a half-valid session hanging around client-side.
    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=; ${clearCookieOptions()}`,
      `${REFRESH_COOKIE_NAME}=; ${clearCookieOptions()}`,
    ]);
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[auth/refresh] Failed:", err);
    res.status(500).json({ error: "Refresh failed." });
  }
}

async function handleLogout(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cookies = parseCookies(req);
  const refreshToken = cookies[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    await logout(refreshToken);
  }

  res.setHeader("Set-Cookie", [
    `${ACCESS_COOKIE_NAME}=; ${clearCookieOptions()}`,
    `${REFRESH_COOKIE_NAME}=; ${clearCookieOptions()}`,
  ]);
  res.status(200).json({ loggedOut: true });
}

async function handleMe(req: VercelRequest, res: VercelResponse) {
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

async function handleChangePassword(req: VercelRequest, res: VercelResponse) {
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
