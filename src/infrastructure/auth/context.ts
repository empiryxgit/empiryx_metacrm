// Shared by every protected API handler. Vercel's Node runtime does not
// give every handler pre-parsed cookies in all configurations, so parsing
// is done explicitly here rather than relying on req.cookies.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ACCESS_COOKIE_NAME, verifyAccessToken, type AccessTokenClaims } from "./tokens";
import type { PermissionCode } from "../../domain/permissions";

export interface AuthContext extends AccessTokenClaims {
  userId: string;
}

export function parseCookies(req: VercelRequest): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((pair) => {
      const idx = pair.indexOf("=");
      const key = decodeURIComponent(pair.slice(0, idx).trim());
      const value = decodeURIComponent(pair.slice(idx + 1).trim());
      return [key, value];
    }),
  );
}

export async function getAuthContext(req: VercelRequest): Promise<AuthContext | null> {
  const cookies = parseCookies(req);
  const token = cookies[ACCESS_COOKIE_NAME];
  if (!token) return null;
  const claims = await verifyAccessToken(token);
  if (!claims) return null;
  return { ...claims, userId: claims.sub };
}

/** Sends 401 and returns null if there is no valid session - callers should
 * `return` immediately when this resolves to null. */
export async function requireAuth(req: VercelRequest, res: VercelResponse): Promise<AuthContext | null> {
  const auth = await getAuthContext(req);
  if (!auth) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return auth;
}

export function hasPermission(auth: AuthContext, code: PermissionCode): boolean {
  return auth.permissions.includes(code);
}

/** Combines requireAuth + a permission check; sends 401/403 and returns null on failure. */
export async function requirePermission(
  req: VercelRequest,
  res: VercelResponse,
  code: PermissionCode,
): Promise<AuthContext | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (!hasPermission(auth, code)) {
    res.status(403).json({ error: `Missing permission: ${code}` });
    return null;
  }
  return auth;
}
