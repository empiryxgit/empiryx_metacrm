// The "client switcher" (Agency Context -> Client Context -> CRM Dashboard):
// lets an agency user pick one of their own agency's clients and, for the
// rest of that browser session, have the ordinary operational CRM pages
// (Dashboard/Pipeline/Leads/Campaigns/Forms+Submissions/Meta Integration -
// see each of api/dashboard, api/pipeline, api/leads/handler,
// api/campaigns/handler, api/forms/handler, api/webhooks/meta/handler for
// where withEffectiveCompanyContext is actually applied) show and act on
// THAT CLIENT's data instead of the agency's own. Meta Integration is
// included deliberately, not as an afterthought: "Meta authentication
// belongs to the client organization" is a CRITICAL requirement of its own
// (see api/webhooks/meta/handler.ts's own header comment) - an agency may
// assist a client through the connect flow, but the resulting connection
// must be attributed to that client's own company, never the agency's.
//
// Deliberately NOT baked into the access-token JWT the way permissions/
// branchIds/assignedClientIds are: this is ephemeral UI-session state (which
// hat is this agency user wearing right now), tracked in its own cookie
// (CLIENT_CONTEXT_COOKIE_NAME) and RE-VALIDATED IN FULL against live DB
// state on every single request that honors it - never trusted on its own.
// That is a stronger property than most of this codebase's JWT-baked claims
// (which are only as fresh as the last login/refresh) and is exactly right
// here: if an agency loses a client (removed/suspended) or a user's
// assignment is revoked mid-session, the very next request drops back to
// the agency's own view automatically, without waiting for a token refresh.
//
// Deliberately narrow in scope: only the six operational CRM handler files
// above ever call withEffectiveCompanyContext. Company/team administration
// (admin/users, admin/roles, admin/branches, company settings, the agency's
// own /api/agency/* endpoints) NEVER does - those always operate on the
// caller's own real company regardless of any active client context, so an
// agency user "managing ABC Realty" can never accidentally rename their own
// agency's company profile as ABC Realty, or vice versa. Widening this to
// let an agency user manage a CLIENT's own users/roles/branches while
// "inside" it would be a deliberate, separate decision - not something this
// switch does today.

import type { VercelRequest } from "@vercel/node";
import { parseCookies, type AuthContext } from "../infrastructure/auth/context";
import { CLIENT_CONTEXT_COOKIE_NAME } from "../infrastructure/auth/tokens";
import { getCompanyById } from "../infrastructure/db/repositories/tenancy";
import { getClaimingAgencyForClient } from "../infrastructure/db/repositories/organizations";
import { resolveAgencyClientAccess, canAccessClient } from "./agencyClientAccess";

export interface ActiveClientContext {
  clientCompanyId: string;
  clientName: string;
  agencyCompanyId: string;
  agencyName: string;
}

/**
 * Full validation of "may THIS caller currently manage THIS client", shared
 * by both the enter-context endpoint (api/admin/users/handler.ts's
 * handleAgencyEnterClientContext) and resolveActiveClientContext below (an
 * already-set cookie is re-checked against exactly the same rules on every
 * request, never grandfathered in). All the same rules getClientDetail
 * already enforces for the read-only Client Detail view: caller's own
 * company must actually BE an agency, the client must still be
 * actively/suspended-claimed by THIS agency (not another agency's, not
 * merely invited/pending, not removed), and the caller's own
 * resolveAgencyClientAccess must cover this specific client (Owner: always;
 * Admin/Manager/User: only if assigned - see src/domain/fixedRoles.ts's
 * explicit access rules).
 */
export async function checkAgencyCanManageClient(
  auth: AuthContext,
  clientCompanyId: string,
): Promise<{ ok: true; clientName: string; agencyName: string } | { ok: false }> {
  const [agencyCompany, clientCompany, claim] = await Promise.all([
    getCompanyById(auth.companyId),
    getCompanyById(clientCompanyId),
    getClaimingAgencyForClient(clientCompanyId),
  ]);

  if (agencyCompany?.accountType !== "agency") return { ok: false };
  if (!clientCompany) return { ok: false };
  if (!claim || claim.agencyCompanyId !== auth.companyId || !["active", "suspended"].includes(claim.relationshipStatus)) {
    return { ok: false };
  }
  if (!canAccessClient(resolveAgencyClientAccess(auth), clientCompanyId)) return { ok: false };

  return { ok: true, clientName: clientCompany.name, agencyName: agencyCompany.name };
}

/**
 * Reads the client-context cookie (if any) and fully re-validates it via
 * checkAgencyCanManageClient. Returns null - never throws, never sends a
 * response itself - for "no cookie", "cookie names a client this caller can
 * no longer manage", or "caller isn't even an agency user any more"; every
 * one of those cases means the same thing to a caller of this function:
 * silently fall back to the caller's own real company, exactly as if no
 * context were ever set. Used by both withEffectiveCompanyContext (to
 * decide the effective companyId for a CRM data request) and
 * api/auth/handler.ts's handleMe (to tell the frontend what to display) -
 * ONE place decides "is a client context currently active", so those two
 * can never disagree.
 */
export async function resolveActiveClientContext(req: VercelRequest, auth: AuthContext): Promise<ActiveClientContext | null> {
  const cookies = parseCookies(req);
  const clientCompanyId = cookies[CLIENT_CONTEXT_COOKIE_NAME];
  if (!clientCompanyId) return null;

  const result = await checkAgencyCanManageClient(auth, clientCompanyId);
  if (!result.ok) return null;

  return {
    clientCompanyId,
    clientName: result.clientName,
    agencyCompanyId: auth.companyId,
    agencyName: result.agencyName,
  };
}

/**
 * The one function every operational CRM handler (dashboard/pipeline/leads/
 * campaigns/forms/Meta integration) calls right after requirePermission/
 * requireAuth succeeds,
 * BEFORE using auth.companyId for anything: returns a (possibly) new
 * AuthContext with companyId swapped to the active client's, or the
 * ORIGINAL auth object unchanged when no valid context applies. Every other
 * field (userId, roleId, permissions, branchIds, assignedClientIds) is left
 * exactly as-is - authorization (which actions this caller may take)
 * always stays governed by the AGENCY user's own real role/permissions;
 * only WHICH company's data those actions read/write changes. A
 * resolveBranchAccess() call downstream still works correctly on the
 * returned object: an agency user's own branchIds are empty (they are not a
 * member of any branch in either their own or a client's company), which
 * resolveBranchAccess already treats as "unrestricted" - so acting inside a
 * client is never incorrectly branch-restricted by the agency user's
 * unrelated (nonexistent) branch memberships.
 */
export async function withEffectiveCompanyContext(req: VercelRequest, auth: AuthContext): Promise<AuthContext> {
  const context = await resolveActiveClientContext(req, auth);
  return context ? { ...auth, companyId: context.clientCompanyId } : auth;
}
