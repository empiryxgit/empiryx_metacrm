// Fixed role catalogs for the two "one side of an agency relationship"
// company contexts - an agency managing multiple clients, and a client
// company's own team - alongside the pre-existing, fully-custom
// per-company roles system (src/domain/permissions.ts's PERMISSION_CATALOG
// + admin/roles.html). This is deliberately ADDITIVE, not a replacement:
// every company still gets a `roles` row per teammate exactly as before,
// these are just a specific, non-editable STARTER set an agency-context
// company gets instead of the single generic "Owner" role
// createOwnerRole() gives every other company - see
// src/infrastructure/db/repositories/tenancy.ts's
// createAgencyFixedRoles/createClientFixedRoles and their call sites
// (registerCompanyAndOwner for a brand-new agency; addClientOrganization/
// completeAgencyOnboarding for a brand-new agency-originated client) for
// exactly which company-creation paths get which catalog. An admin can
// still add further fully-custom roles alongside these four via the
// ordinary /api/admin/roles endpoint (admin/roles.html) - "at minimum"
// these four exist, nothing here stops adding a fifth.
//
// Both catalogs share the same four capability TIERS (Owner/Admin/Manager/
// User) - only the names differ, plus exactly one extra permission on the
// agency side's OWNER tier alone. See AGENCY_ROLE_PERMISSIONS's own comment
// for the full explicit access rules (Owner: all clients; Admin/Manager/
// User: assignment-scoped) and why AGENCY_CLIENTS_VIEW_ALL reaches only
// AGENCY_OWNER, never AGENCY_ADMIN or either catalog's other tiers.

import { ALL_PERMISSIONS, PERMISSIONS, type PermissionCode } from "./permissions";

// Every tier below is built from this, NOT from ALL_PERMISSIONS directly -
// two permission codes are deliberately excluded from every auto-seeded
// role and must be added back explicitly wherever they actually apply:
//   - AGENCY_CLIENTS_VIEW_ALL is an agency-only cross-client visibility flag
//     (see its own comment in permissions.ts), and it must never end up in a
//     CLIENT_* role's stored permissions (meaningless there) or in
//     AGENCY_ADMIN's (see AGENCY_ROLE_PERMISSIONS's own comment on the
//     explicit access rules this catalog implements). It is added back in
//     ONE place only: AGENCY_OWNER, below.
//   - RUTA_AI_ASSISTANT_BROAD_QUERY is documented (permissions.ts) as
//     "deliberately off by default for every role, including Owner...
//     opt-in, never inherited" - it must NEVER be added back onto any
//     auto-seeded system role, full-access tiers included. (Fix for audit
//     Finding 2a: this permission was previously falling through into
//     BASE_ALL_PERMISSIONS unfiltered, so every Owner/AGENCY_OWNER/
//     AGENCY_ADMIN/CLIENT_OWNER/CLIENT_ADMIN role silently got it despite
//     the documented "opt-in only" intent above. See
//     drizzle/0036_fix_ruta_broad_query_permission_seeding.sql for the
//     one-time cleanup of already-seeded system roles this code fix alone
//     cannot reach.)
const BASE_ALL_PERMISSIONS: PermissionCode[] = ALL_PERMISSIONS.filter(
  (p) => p !== PERMISSIONS.AGENCY_CLIENTS_VIEW_ALL && p !== PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY,
);

const OWNER_TIER: PermissionCode[] = BASE_ALL_PERMISSIONS;
// Everything Owner has except company-wide profile/settings - the one
// deliberate difference this codebase draws between "runs the account" and
// "runs day-to-day operations of the account", since nothing else in
// PERMISSION_CATALOG today models a company-settings-vs-everything-else
// split any more granularly than that single permission.
const ADMIN_TIER: PermissionCode[] = BASE_ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.COMPANY_MANAGE);
// Full day-to-day operational control (campaigns, pipeline, leads, forms,
// submissions, the Meta integration) but none of the account-administration
// permissions (company profile, users, roles, branches) - a Manager runs
// the work, they don't run the account.
const MANAGER_TIER: PermissionCode[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.CAMPAIGNS_VIEW,
  PERMISSIONS.CAMPAIGNS_MANAGE,
  PERMISSIONS.WEBHOOKS_MANAGE,
  PERMISSIONS.PIPELINE_VIEW,
  PERMISSIONS.PIPELINE_MANAGE,
  PERMISSIONS.LEADS_VIEW,
  PERMISSIONS.LEADS_EXPORT,
  PERMISSIONS.LEADS_MANAGE,
  PERMISSIONS.FORMS_VIEW,
  PERMISSIONS.FORMS_MANAGE,
  PERMISSIONS.SUBMISSIONS_VIEW,
  PERMISSIONS.INTEGRATIONS_MANAGE,
];
// View-only across the same set of modules Manager can operate on.
const USER_TIER: PermissionCode[] = [
  PERMISSIONS.DASHBOARD_VIEW,
  PERMISSIONS.CAMPAIGNS_VIEW,
  PERMISSIONS.PIPELINE_VIEW,
  PERMISSIONS.LEADS_VIEW,
  PERMISSIONS.FORMS_VIEW,
  PERMISSIONS.SUBMISSIONS_VIEW,
];

export type AgencyRoleName = "AGENCY_OWNER" | "AGENCY_ADMIN" | "AGENCY_MANAGER" | "AGENCY_USER";
export const AGENCY_ROLE_NAMES: AgencyRoleName[] = ["AGENCY_OWNER", "AGENCY_ADMIN", "AGENCY_MANAGER", "AGENCY_USER"];

export type ClientRoleName = "CLIENT_OWNER" | "CLIENT_ADMIN" | "CLIENT_MANAGER" | "CLIENT_USER";
export const CLIENT_ROLE_NAMES: ClientRoleName[] = ["CLIENT_OWNER", "CLIENT_ADMIN", "CLIENT_MANAGER", "CLIENT_USER"];

/**
 * The explicit per-role CLIENT VISIBILITY rules this catalog implements
 * (src/application/agencyClientAccess.ts is what actually enforces these at
 * read time):
 *
 *   AGENCY_OWNER   -> All clients (unconditional - the only role that
 *                     bypasses agency_client_assignments entirely)
 *   AGENCY_ADMIN   -> All ASSIGNED clients (every client assigned to them -
 *                     administrative capability within the agency account,
 *                     but NOT automatic visibility into every client)
 *   AGENCY_MANAGER -> Assigned clients
 *   AGENCY_USER    -> Assigned client(s)
 *
 * AGENCY_CLIENTS_VIEW_ALL is the ONE thing that grants the unconditional
 * "All clients" row above - and ONLY AGENCY_OWNER holds it. Every other
 * tier (Admin included) is assignment-scoped: with zero rows in
 * agency_client_assignments for them, they see zero clients, exactly like
 * a fresh Manager/User - "All assigned clients" still means "only the ones
 * assigned," it is not a second route to unconditional access.
 */
export const AGENCY_ROLE_PERMISSIONS: Record<AgencyRoleName, PermissionCode[]> = {
  AGENCY_OWNER: [...OWNER_TIER, PERMISSIONS.AGENCY_CLIENTS_VIEW_ALL],
  AGENCY_ADMIN: ADMIN_TIER,
  AGENCY_MANAGER: MANAGER_TIER,
  AGENCY_USER: USER_TIER,
};

export const AGENCY_ROLE_DESCRIPTIONS: Record<AgencyRoleName, string> = {
  AGENCY_OWNER:
    "Full access to every area of the agency account, and sees every client unconditionally. Cannot be edited or deleted.",
  AGENCY_ADMIN:
    "Runs the agency account (cannot change company-wide profile/settings), but sees only whichever clients they've been assigned - see Users → Assigned Clients. Cannot be edited or deleted.",
  AGENCY_MANAGER:
    "Runs day-to-day work (campaigns, pipeline, leads, forms) for whichever clients they've been assigned - see Users → Assigned Clients. Cannot be edited or deleted.",
  AGENCY_USER:
    "Read-only access to whichever client(s) they've been assigned - see Users → Assigned Clients. Cannot be edited or deleted.",
};

/**
 * A client company's own team only ever operates inside that one company's
 * own tenant (same as any other company in this codebase) - there is no
 * cross-client visibility question on this side, so
 * AGENCY_CLIENTS_VIEW_ALL is never granted here (BASE_ALL_PERMISSIONS
 * already excludes it) - it would be a no-op even if it were, since
 * nothing on the client side ever calls resolveAgencyClientAccess. The
 * three explicit access rules this catalog implements:
 *
 *   CLIENT_OWNER -> Everything inside their own organization
 *   CLIENT_ADMIN -> Administrative access (runs the account day-to-day,
 *                   minus company-wide profile/settings)
 *   CLIENT_USER  -> Permission-based access (view-only, exactly the fixed
 *                   permission codes below - no administrative capability)
 *
 * CLIENT_MANAGER sits between Admin and User (operational, non-admin -
 * same MANAGER_TIER the agency side uses) - not called out as its own line
 * in the three rules above, but still one of the four roles "at minimum"
 * required, so it keeps the tier it already had.
 */
export const CLIENT_ROLE_PERMISSIONS: Record<ClientRoleName, PermissionCode[]> = {
  CLIENT_OWNER: OWNER_TIER,
  CLIENT_ADMIN: ADMIN_TIER,
  CLIENT_MANAGER: MANAGER_TIER,
  CLIENT_USER: USER_TIER,
};

export const CLIENT_ROLE_DESCRIPTIONS: Record<ClientRoleName, string> = {
  CLIENT_OWNER: "Everything inside your own organization. Cannot be edited or deleted.",
  CLIENT_ADMIN: "Administrative access - runs the account, but cannot change company-wide profile/settings. Cannot be edited or deleted.",
  CLIENT_MANAGER: "Runs day-to-day work (campaigns, pipeline, leads, forms). Cannot be edited or deleted.",
  CLIENT_USER: "Permission-based, read-only access. Cannot be edited or deleted.",
};

/**
 * Which fixed-catalog role NAMES resolve to a LIVE, always-current
 * permission set at token-issue time (src/application/auth.ts#
 * effectivePermissions) rather than the role's own stored `permissions`
 * snapshot - i.e. which roles are meant to auto-heal and never fall behind
 * when a new PERMISSIONS.* constant is added later, the legacy single
 * "Owner" role's exact original behavior. Deliberately scoped by NAME, not
 * by `isSystem` alone: every fixed-catalog role (Owner/Admin/Manager/User
 * alike) is `isSystem: true` (uneditable - see api/admin/roles/handler.ts's
 * isSystem check), but only the true "full access" tiers should silently
 * gain every future permission - Admin/Manager/User must keep their
 * narrower, tiered (and, for Admin, assignment-scoped) permission set this
 * whole feature exists to enforce, not quietly regain full/unassigned
 * access the next time a PERMISSIONS.* constant is added.
 */
const FULL_ACCESS_ROLE_NAMES: string[] = ["Owner", "AGENCY_OWNER", "CLIENT_OWNER"];

export function isFullAccessSystemRoleName(name: string): boolean {
  return FULL_ACCESS_ROLE_NAMES.includes(name);
}

/**
 * The actual live permission set a full-access role name
 * (isFullAccessSystemRoleName) resolves to - split out from a single flat
 * ALL_PERMISSIONS because AGENCY_CLIENTS_VIEW_ALL must reach exactly ONE of
 * these three roles' tokens, never all of them: AGENCY_OWNER is the only
 * role in the entire system with unconditional "All clients" access (see
 * AGENCY_ROLE_PERMISSIONS's own comment on the explicit access rules) - the
 * legacy single "Owner" role (plain individual companies) and CLIENT_OWNER
 * both auto-heal to every OTHER current/future permission, but must never
 * carry an agency-only cross-client flag that is meaningless for them.
 *
 * Deliberately never returns raw ALL_PERMISSIONS for any role name -
 * RUTA_AI_ASSISTANT_BROAD_QUERY must stay excluded even for AGENCY_OWNER
 * (opt-in only, see BASE_ALL_PERMISSIONS's own comment above / audit
 * Finding 2a), so AGENCY_OWNER's extra grant is composed explicitly
 * (BASE_ALL_PERMISSIONS + AGENCY_CLIENTS_VIEW_ALL) instead of reaching for
 * the unfiltered constant.
 */
export function fullAccessPermissionsForRoleName(name: string): PermissionCode[] {
  return name === "AGENCY_OWNER" ? [...BASE_ALL_PERMISSIONS, PERMISSIONS.AGENCY_CLIENTS_VIEW_ALL] : BASE_ALL_PERMISSIONS;
}
