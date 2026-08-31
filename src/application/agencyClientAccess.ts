// The single place that decides which client(s) an authenticated AGENCY
// request may see - see src/domain/fixedRoles.ts's own comment on
// AGENCY_CLIENTS_VIEW_ALL for the permission this is built on. Every
// agency-facing read in src/application/agency.ts (getAgencyDashboardSummary,
// getClientDetail) MUST route through resolveAgencyClientAccess() and
// canAccessClient() - never assume every user of an agency company can see
// every client the agency manages.
//
// Deliberately the MIRROR IMAGE of src/application/branchAccess.ts's own
// "all vs restricted" shape, but with one intentional difference: branches
// treats zero assignments as "all" (backward compatible with every company
// that predates branches existing at all). This does NOT - a fresh
// AGENCY_ADMIN/AGENCY_MANAGER/AGENCY_USER with zero rows in
// agency_client_assignments sees NOTHING, per the explicit requirement this
// feature was built from ("Do not automatically give every agency user
// access to every client... The user cannot see Client B") and the
// explicit access rules AGENCY_OWNER -> All clients / AGENCY_ADMIN -> All
// ASSIGNED clients / AGENCY_MANAGER -> Assigned clients / AGENCY_USER ->
// Assigned client(s) - see src/domain/fixedRoles.ts's own comment. There is
// no comparable "this feature didn't used to exist" backward-compatibility
// concern to preserve here - client visibility scoping and this permission
// model launch together.

import type { AuthContext } from "../infrastructure/auth/context";
import { hasPermission } from "../infrastructure/auth/context";
import { PERMISSIONS } from "../domain/permissions";

export type AgencyClientAccess = { scope: "all" } | { scope: "restricted"; clientCompanyIds: string[] };

/**
 * "all" when the user holds agency_clients.view_all - by default this is
 * ONLY the AGENCY_OWNER fixed role (the sole "All clients" role in the
 * explicit access rules), though any custom role an admin explicitly
 * grants the permission to also qualifies. AGENCY_ADMIN does NOT hold it
 * by default - "All assigned clients" still means assignment-scoped, not a
 * second route to unconditional access. Otherwise "restricted" to exactly
 * whichever client company ids agency_client_assignments names for this
 * user (auth.assignedClientIds, carried in the JWT the same way branchIds
 * already is) - an empty array here means "sees zero clients", not "sees
 * every client".
 */
export function resolveAgencyClientAccess(auth: AuthContext): AgencyClientAccess {
  if (hasPermission(auth, PERMISSIONS.AGENCY_CLIENTS_VIEW_ALL)) return { scope: "all" };
  return { scope: "restricted", clientCompanyIds: auth.assignedClientIds ?? [] };
}

/** Checks a clientCompanyId already read back from our own database (e.g.
 * an agency_clients row's own clientCompanyId) against the caller's access
 * - no DB round trip, same role assertBranchAccessible's counterpart
 * canAccessBranch plays for branches. */
export function canAccessClient(access: AgencyClientAccess, clientCompanyId: string): boolean {
  return access.scope === "all" || access.clientCompanyIds.includes(clientCompanyId);
}
