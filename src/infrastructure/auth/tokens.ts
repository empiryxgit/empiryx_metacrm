// Access tokens are short-lived signed JWTs (jose - pure-JS, works on any
// Vercel runtime) carrying just enough claims to authorize a request without
// a database round trip. Refresh tokens are opaque random strings; only
// their SHA-256 hash is persisted (src/infrastructure/db/schema.ts#sessions),
// so a leaked database dump alone can never be replayed as a live session.

import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "node:crypto";

// Was 15 minutes - too tight for the Meta "Connect" round trip specifically:
// a first-time Facebook Login consent screen (plus any Business
// Verification/2FA prompts Meta shows) can easily take longer than that, so
// a tenant who declines (or even completes) the dialog could come back to
// find their RUTA session had expired mid-flow and land on /login.html
// instead of straight back on meta-status.html. 60 minutes gives real-world
// OAuth flows enough room without meaningfully weakening session security -
// the refresh token (below) is still what actually bounds how long a
// browser can stay signed in unattended.
// Exported so api/auth/handler.ts can set the ACCESS cookie's own Max-Age
// to match - it used to hardcode its own separate "15 * 60" literal here,
// which meant bumping the JWT's expiration claim alone wouldn't actually
// have fixed anything: the cookie itself would still have been deleted by
// the browser after the old 15 minutes regardless of the token still being
// valid inside it.
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 60 minutes
// "Remember me" checked (login.html) - a session that should survive the
// browser closing and reopening days later. Also what registration and
// password-reset flows use, since there's no checkbox on those screens and
// "just created/reset the account" is the friendliest default.
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
// "Remember me" left unchecked - the DEFAULT for a plain login. Deliberately
// short: this is what actually stops an unchecked login on a shared/public
// computer from quietly staying signed in for a month. Long enough to cover
// one real sitting (survives the access token's own 60-minute silent
// refreshes without re-prompting for a password mid-task); short enough
// that walking away and coming back the next day requires signing in again.
// Server-side, not just client-side: the paired cookie is ALSO issued as a
// non-persistent session cookie (see cookieOptions below), but this TTL is
// what actually bounds the session even if a browser is configured to
// restore cookies across a restart (e.g. "continue where you left off").
export const SESSION_REFRESH_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours

export interface AccessTokenClaims {
  sub: string; // user id
  companyId: string;
  roleId: string;
  permissions: string[];
  // Every branch this user is a member of (branch_users rows), carried in
  // the token the same way permissions already are, to authorize
  // branch-scoped requests without a DB round trip. Empty array means
  // "not assigned to any specific branch" - see resolveBranchAccess() in
  // src/application/branchAccess.ts for what that implies. Optional so a
  // token issued before this field existed still verifies (jose/JWT just
  // omits it; branchIds is treated as [] when absent, never as a crash).
  branchIds?: string[];
  // Every client company this AGENCY user has been explicitly assigned to
  // (agency_client_assignments rows), same "carry it in the token, avoid a
  // DB round trip per request" shape as branchIds above. Unlike branchIds,
  // an empty array here does NOT mean "unrestricted" - see
  // resolveAgencyClientAccess() in src/application/agencyClientAccess.ts.
  // Meaningless (and always empty/unused) for a user of a non-agency
  // company. Optional for the same "token issued before this field
  // existed still verifies" reason branchIds is.
  assignedClientIds?: string[];
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_JWT_SECRET is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\"",
    );
  }
  return new TextEncoder().encode(secret);
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(getSecret());
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    // Security hardening: pin the accepted algorithm explicitly rather than
    // trusting whatever `alg` the token itself claims. jose already refuses
    // to verify an asymmetric-alg token against this symmetric secret, but
    // being explicit here is cheap defense-in-depth against any future
    // change to how the secret is provisioned (e.g. if it were ever swapped
    // for a key type jose would otherwise accept a wider algorithm family
    // for) - a tampered/forged token can never satisfy this by picking a
    // different, weaker algorithm.
    const { payload } = await jwtVerify(token, getSecret(), { algorithms: ["HS256"] });
    return payload as unknown as AccessTokenClaims;
  } catch {
    return null;
  }
}

export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// How long a "Generate Onboarding Link" invite (Clients -> Add Client ->
// Generate Onboarding Link) stays redeemable before it must be regenerated -
// see agencyOnboardingTokens.expiresAt in schema.ts. A week, not the 24h a
// login-adjacent token would get: this link is typically handed to someone
// outside the product entirely (an email, a text, a sales call follow-up),
// so it needs enough slack to actually get opened, not just enough to
// survive one browser session.
export const ONBOARDING_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

/** Same opaque-random-value + SHA-256-hash shape as generateRefreshToken
 * above, reused here for the "Generate Onboarding Link" invite rather than
 * a login session - see agencyOnboardingTokens' own doc comment in
 * schema.ts for why a session-grade token is exactly the right primitive
 * for this. The raw `token` is what goes in the link
 * (/onboarding/agency/{token}) and is returned to the caller exactly once;
 * only `hash` is ever persisted. */
export function generateOnboardingToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashOnboardingToken(token) };
}

export function hashOnboardingToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const ACCESS_COOKIE_NAME = "mla_access";
export const REFRESH_COOKIE_NAME = "mla_refresh";
// Which client company an AGENCY user is currently "managing" (the client
// switcher - see src/application/agencyClientContext.ts). Deliberately a
// SEPARATE plain cookie, not a JWT claim: it is pure UI-session state (which
// hat is this agency user wearing right now), re-validated in full against
// live DB state on every request that honors it (never trusted on its own
// for authorization) - see resolveActiveClientContext's own comment for why
// that split is what keeps this safe. Session-lifetime only (no Max-Age),
// same as browser-restart-clears-it "remember me" unchecked semantics - a
// working context like this shouldn't quietly outlive the browser session.
export const CLIENT_CONTEXT_COOKIE_NAME = "mla_client_ctx";

// maxAgeSeconds: null means "browser SESSION cookie" - no Max-Age/Expires
// directive at all, so the browser itself drops it on close (the "Remember
// me" unchecked case). The token inside the cookie still carries its own
// real, server-checked expiry regardless (the JWT's exp claim, or the
// session row's expiresAt) - this only controls whether the cookie ALSO
// survives a browser restart, never how long the token is actually valid.
export function cookieOptions(maxAgeSeconds: number | null): string {
  const secure = process.env.NODE_ENV !== "development";
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    maxAgeSeconds === null ? "" : `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookieOptions(): string {
  const secure = process.env.NODE_ENV !== "development";
  return ["Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : "", "Max-Age=0"].filter(Boolean).join("; ");
}

// THE single place both auth cookies get set, from EVERY handler that ever
// needs to log someone in - register/login/refresh in api/auth/handler.ts,
// plus completeAgencyOnboarding's caller in api/admin/users/handler.ts (the
// "Generate Onboarding Link" flow - see that file's own comment) - so
// "remember me" and both TTLs stay honored identically everywhere rather
// than reimplemented per handler file. Originally lived as a private
// function inside api/auth/handler.ts (see git history) until a second
// handler file needed it too; moved here rather than duplicated, which is
// exactly the class of drift this function's own existence was meant to
// prevent in the first place (see its own comment history - a prior
// version hardcoded a separate TTL literal per handler for the access
// cookie alone).
//
// Takes a structural subset of application/auth.ts's AuthTokens rather than
// importing that type directly - src/application/auth.ts already imports
// FROM this file (ACCESS_TOKEN_TTL_SECONDS etc.), so importing its
// AuthTokens type back here would create a circular module dependency.
export function setAuthCookies(
  res: { setHeader(name: string, value: string[]): void },
  tokens: { accessToken: string; refreshToken: string; rememberMe: boolean },
): void {
  const refreshTtl = tokens.rememberMe ? REFRESH_TOKEN_TTL_SECONDS : SESSION_REFRESH_TOKEN_TTL_SECONDS;
  res.setHeader("Set-Cookie", [
    `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(tokens.rememberMe ? ACCESS_TOKEN_TTL_SECONDS : null)}`,
    `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(tokens.rememberMe ? refreshTtl : null)}`,
  ]);
}
