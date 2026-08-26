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
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

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
    const { payload } = await jwtVerify(token, getSecret());
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

export const ACCESS_COOKIE_NAME = "mla_access";
export const REFRESH_COOKIE_NAME = "mla_refresh";

export function cookieOptions(maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV !== "development";
  return [
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${maxAgeSeconds}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookieOptions(): string {
  const secure = process.env.NODE_ENV !== "development";
  return ["Path=/", "HttpOnly", "SameSite=Lax", secure ? "Secure" : "", "Max-Age=0"].filter(Boolean).join("; ");
}
