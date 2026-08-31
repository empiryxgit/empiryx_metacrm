// Combines register/login/refresh/logout/me/change-password into ONE Vercel
// Function, dispatching on ?action= - see vercel.json's rewrites, which map
// each public path (/api/auth/register, /api/auth/login, ...) to this file
// with the action injected as a query param. Purely a deployment-footprint
// optimization (Vercel's Hobby plan caps a deployment at 12 Functions
// total) - every handler below is byte-for-byte the same logic as when
// each lived in its own file; the public URLs are unchanged, so no
// frontend code needed to move.
//
// This used to be a filesystem [[...action]].ts optional catch-all, but
// that convention was found not to reliably populate req.query in this
// deployment (path segments never reached the handler), so it was
// converted to this fixed filename + explicit rewrite pattern instead,
// matching api/system.ts which already worked this way.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AuthError, login, logout, refresh, registerCompanyAndOwner, type AuthTokens } from "../../src/application/auth";
import {
  ACCESS_COOKIE_NAME,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
  SESSION_REFRESH_TOKEN_TTL_SECONDS,
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
import { ALL_PERMISSIONS } from "../../src/domain/permissions";
import { checkRateLimit } from "../../src/infrastructure/cache/redis";

function getAction(req: VercelRequest): string {
  const segments = req.query.action;
  if (Array.isArray(segments)) return segments[0] ?? "";
  return typeof segments === "string" ? segments : "";
}

function getClientIp(req: VercelRequest): string {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (first?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown").toLowerCase();
}

// Security hardening: brute-force / credential-stuffing protection on the
// auth endpoints, via the same Upstash Redis this deployment already uses
// for idempotency (src/infrastructure/cache/redis.ts's checkRateLimit) -
// fixed-window counters, fail OPEN on a Redis outage (see that file's own
// comment on why). Two layers on login specifically: a tight per-IP+email
// limit (catches someone hammering one target account) and a looser
// per-IP-only limit (catches spraying many different emails from one
// source, which the first limit alone would never trip). Sends 429 with a
// generic message either way - never reveals which layer tripped, since
// that alone would leak whether the email exists.
async function enforceRateLimit(res: VercelResponse, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const allowed = await checkRateLimit(key, limit, windowSeconds);
  if (!allowed) {
    res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again." });
    return false;
  }
  return true;
}

// THE single place both auth cookies get set, from register/login/refresh
// alike, so "remember me" is honored identically everywhere rather than
// re-implemented per handler (a prior version of this file hardcoded a
// separate hardcoded TTL literal per handler for the access cookie alone -
// see tokens.ts's own comment on that bug - this exists so that class of
// drift can't happen again for the remember-me persistence flag either).
//
// tokens.rememberMe (set once at login, then carried forward unchanged by
// every subsequent refresh() rotation - see src/application/auth.ts) drives
// TWO independent things, and both matter for this to actually be secure:
//   1. The cookie's OWN persistence - Max-Age set (survives a browser
//      restart) when remembered, a plain session cookie (gone the moment
//      the browser closes) when not.
//   2. The refresh cookie's Max-Age, when set, is capped at the SAME TTL
//      the underlying session row was actually issued with server-side
//      (REFRESH_TOKEN_TTL_SECONDS vs SESSION_REFRESH_TOKEN_TTL_SECONDS) -
//      never a client-controlled duration. A tampered/oversized Max-Age in
//      a replayed cookie buys nothing: the session row's own expiresAt
//      (checked in getActiveSessionByHash) is what's actually authoritative,
//      the cookie is just how long the browser bothers holding onto it.
function setAuthCookies(res: VercelResponse, tokens: AuthTokens): void {
  const refreshTtl = tokens.rememberMe ? REFRESH_TOKEN_TTL_SECONDS : SESSION_REFRESH_TOKEN_TTL_SECONDS;
  res.setHeader("Set-Cookie", [
    `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(tokens.rememberMe ? ACCESS_TOKEN_TTL_SECONDS : null)}`,
    `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(tokens.rememberMe ? refreshTtl : null)}`,
  ]);
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
  // Optional, never sent by public/register.html - kept only for backward
  // compatibility with any existing direct API caller. See RegisterInput's
  // own comment in src/application/auth.ts.
  industry?: string;
  // "individual" | "agency" - collected by public/register.html's second
  // step. See RegisterInput's own comment in src/application/auth.ts.
  accountType?: string;
  // Required when accountType is "agency" (validated in
  // registerCompanyAndOwner, not here) - the Agency form's "Mobile" field.
  phoneNumber?: string;
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

  // Per-IP only (there's no existing account yet to key a tighter limit
  // off of) - bounds automated mass account creation / spam signups.
  if (!(await enforceRateLimit(res, `register:${getClientIp(req)}`, 8, 60 * 60))) return;

  try {
    await registerCompanyAndOwner(body);

    // Log the new owner in immediately - registration and first login are
    // the same moment from the user's perspective. There's no "remember me"
    // checkbox on this screen, so this always remembers - a tenant who just
    // created their account shouldn't be signed out the moment they close
    // the tab, and there's no shared/public-computer risk yet since no
    // meaningful data exists on the account until they've done something
    // with it.
    const tokens = await login({
      email: body.email,
      password: body.password,
      userAgent: req.headers["user-agent"],
      ipAddress: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
      rememberMe: true,
    });

    setAuthCookies(res, tokens);
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

  const { email, password, rememberMe } = (req.body ?? {}) as { email?: string; password?: string; rememberMe?: unknown };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required." });
    return;
  }

  const ip = getClientIp(req);
  const normalizedEmail = email.trim().toLowerCase();
  // Tight limit per (ip, email) pair - a few genuine typos are fine, this
  // is meant to stop repeated guessing against ONE target account.
  if (!(await enforceRateLimit(res, `login:${ip}:${normalizedEmail}`, 8, 15 * 60))) return;
  // Looser limit per IP alone - catches one source spraying guesses across
  // MANY different email addresses, which the per-account limit above
  // would never trip since no single email gets hit often enough.
  if (!(await enforceRateLimit(res, `login-ip:${ip}`, 30, 15 * 60))) return;

  try {
    const tokens = await login({
      email,
      password,
      userAgent: req.headers["user-agent"],
      ipAddress: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
      // Strict `=== true` on purpose - anything other than the literal
      // boolean true (missing, false, "true" the string, 1, ...) is treated
      // as "not remembered," the safer default per src/application/auth.ts's
      // own LoginInput.rememberMe comment. Whatever a client sends here only
      // ever selects between the two SERVER-defined TTLs (login() itself
      // decides REFRESH_TOKEN_TTL_SECONDS vs SESSION_REFRESH_TOKEN_TTL_SECONDS)
      // - there is no value a caller could put in this field that grants a
      // session longer than what login() would issue for a genuine "yes".
      rememberMe: rememberMe === true,
    });

    setAuthCookies(res, tokens);
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

  // Refresh tokens are 256 bits of random data - brute-forcing one
  // directly is not a realistic threat. This limit exists as defense in
  // depth against a compromised/scripted client hammering this endpoint
  // (each legitimate browser fires it at most a couple of times an hour,
  // driven by the 60-minute access-token TTL), not against guessing.
  if (!(await enforceRateLimit(res, `refresh:${getClientIp(req)}`, 30, 15 * 60))) return;

  try {
    const tokens = await refresh(refreshToken);
    // tokens.rememberMe here is whatever the ORIGINAL login chose, carried
    // forward by refresh() itself (see its own comment) - never
    // re-evaluated from this request, so a not-remembered session can't
    // accidentally upgrade itself to persistent just by staying active
    // long enough to hit a silent refresh.
    setAuthCookies(res, tokens);
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
      industry: company.industryTemplate,
      accountType: company.accountType,
      onboardingCompleted: Boolean(company.onboardingCompletedAt),
    },
    // Owner (isSystem) always reflects the full, current permission catalog
    // rather than whatever snapshot was stored when the role was created -
    // see effectivePermissions() in src/application/auth.ts for why.
    role: role ? { id: role.id, name: role.name, permissions: role.isSystem ? ALL_PERMISSIONS : role.permissions } : null,
    // Branch ids this user is a member of, straight from the access token
    // (see AccessTokenClaims.branchIds) - empty means "not assigned to a
    // specific branch," which src/application/branchAccess.ts treats as
    // unrestricted, not as "no access."
    branchIds: auth.branchIds ?? [],
  });
}

async function handleChangePassword(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  // Keyed on the authenticated user, not the IP - this endpoint requires a
  // valid session already, so the thing worth bounding is someone with a
  // stolen/idle session trying to brute-force the CURRENT password (e.g.
  // to lock the real owner out by changing it, or because they don't know
  // it but rode along on a hijacked cookie).
  if (!(await enforceRateLimit(res, `change-password:${auth.userId}`, 8, 15 * 60))) return;

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
