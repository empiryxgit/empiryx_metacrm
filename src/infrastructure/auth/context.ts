// Shared by every protected API handler. Vercel's Node runtime does not
// give every handler pre-parsed cookies in all configurations, so parsing
// is done explicitly here rather than relying on req.cookies.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { ACCESS_COOKIE_NAME, verifyAccessToken, type AccessTokenClaims } from "./tokens";
import type { PermissionCode } from "../../domain/permissions";
import { isAccountLockedOut } from "../../application/billing";

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

/** Combines requireAuth + a permission check; sends 401/403 and returns null on failure.
 *
 * Phase 11 - also enforces the trial/subscription lockout: any request
 * that reaches this function with a non-GET method is, by definition, a
 * permission-gated WRITE (create/update/delete something), so once the
 * caller's account is trial_expired/subscription_expired
 * (isAccountLockedOut - src/application/billing.ts) it is refused with a
 * 402 + machine-readable `code: "account_locked"` the frontend's shared
 * apiJson wrapper (public/assets/app.js) redirects on, mirroring the
 * existing 402 campaign_limit_reached/client_limit_reached pattern. Every
 * GET call site is completely unaffected - "view/export your existing
 * data" stays open regardless of entitlement state, only writes are
 * gated. Pass `{ allowWhenBlocked: true }` from a specific call site to
 * exempt it - used ONLY by the billing/subscribe endpoints themselves
 * (handleBillingCreateOrder, handleBillingVerify in
 * api/campaigns/handler.ts), since a locked-out account must still be
 * able to pay its way out; every other permission-gated write in the app
 * is locked by default with no per-resource special-casing needed here. */
export async function requirePermission(
  req: VercelRequest,
  res: VercelResponse,
  code: PermissionCode,
  opts?: { allowWhenBlocked?: boolean },
): Promise<AuthContext | null> {
  const auth = await requireAuth(req, res);
  if (!auth) return null;
  if (!hasPermission(auth, code)) {
    res.status(403).json({ error: `Missing permission: ${code}` });
    return null;
  }
  if (req.method !== "GET" && !opts?.allowWhenBlocked) {
    if (await isAccountLockedOut(auth.companyId)) {
      res.status(402).json({
        error: "Your trial or subscription has expired. Subscribe to continue making changes.",
        code: "account_locked",
      });
      return null;
    }
  }
  return auth;
}

/** Explicit escape hatch for the small number of write actions that
 * authorize via requireAuth (or a custom check) rather than
 * requirePermission - e.g. handleAgencyResource's account-type-gated
 * agency actions in api/admin/users/handler.ts, which mix GET reads and
 * POST writes behind one shared requireAuth call with no single
 * PermissionCode to hang the automatic check in requirePermission off of.
 * Sends the same 402 + `code: "account_locked"` body and returns false;
 * callers follow the same `if (!(await assertNotLockedOut(...))) return;`
 * convention as every other guard in this file. Only call this for an
 * action that is genuinely a WRITE (req.method !== "GET") - it does not
 * check the method itself, so a caller mixing GET and POST/PUT/PATCH/
 * DELETE branches in one dispatch function must only call it from the
 * non-GET branch(es), exactly like requirePermission does automatically. */
export async function assertNotLockedOut(req: VercelRequest, res: VercelResponse, companyId: string): Promise<boolean> {
  if (await isAccountLockedOut(companyId)) {
    res.status(402).json({
      error: "Your trial or subscription has expired. Subscribe to continue making changes.",
      code: "account_locked",
    });
    return false;
  }
  return true;
}
