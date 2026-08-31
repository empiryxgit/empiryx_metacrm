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
// User) - only the names and, for the agency side, one extra permission
// differ. See AGENCY_ROLE_PERMISSIONS's own comment for why
// AGENCY_CLIENTS_VIEW_ALL is the one thing that makes the agency catalog
// different from the client catalog rather than these being the exact same
// four permission sets under two different label sets.

import { ALL_PERMISSIONS, PERMISSIONS, type PermissionCode } from "./permissions";

const OWNER_TIER: PermissionCode[] = ALL_PERMISSIONS;
// Everything Owner has except company-wide profile/settings - the one
// deliberate difference this codebase draws between "runs the account" and
// "runs day-to-day operations of the account", since nothing else in
// PERMISSION_CATALOG today models a company-settings-vs-everything-else
// split any more granularly than that single permission.
const ADMIN_TIER: PermissionCode[] = ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.COMPANY_MANAGE);
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
 * AGENCY_CLIENTS_VIEW_ALL is what actually implements "do not automatically
 * give every agency user access to every client": only the two full-trust
 * tiers (Owner/Admin) hold it. AGENCY_MANAGER/AGENCY_USER do NOT - see
 * src/application/agencyClientAccess.ts for what that means for them (they
 * see only whichever clients agency_client_assignments names for that
 * specific user, never every client the agency manages, until someone
 * explicitly assigns one).
 */
export const AGENCY_ROLE_PERMISSIONS: Record<AgencyRoleName, PermissionCode[]> = {
  AGENCY_OWNER: [...OWNER_TIER, PERMISSIONS.AGENCY_CLIENTS_VIEW_ALL],
  AGENCY_ADMIN: [...ADMIN_TIER, PERMISSIONS.AGENCY_CLIENTS_VIEW_ALL],
  AGENCY_MANAGER: MANAGER_TIER,
  AGENCY_USER: USER_TIER,
};

export const AGENCY_ROLE_DESCRIPTIONS: Record<AgencyRoleName, string> = {
  AGENCY_OWNER:
    "Full access to every area of the agency account, including every client. Cannot be edited or deleted.",
  AGENCY_ADMIN:
    "Runs the agency account and sees every client, but cannot change company-wide profile/settings. Cannot be edited or deleted.",
  AGENCY_MANAGER:
    "Runs day-to-day work (campaigns, pipeline, leads, forms) for whichever clients they've been assigned - see Users → Assigned Clients. Cannot be edited or deleted.",
  AGENCY_USER:
    "Read-only access to whichever clients they've been assigned - see Users → Assigned Clients. Cannot be edited or deleted.",
};

/**
 * A client company's own team only ever operates inside that one company's
 * own tenant (same as any other company in this codebase) - there is no
 * cross-client visibility question on this side, so
 * AGENCY_CLIENTS_VIEW_ALL is deliberately never granted here; it would be a
 * no-op even if it were, since nothing on the client side ever calls
 * resolveAgencyClientAccess.
 */
export const CLIENT_ROLE_PERMISSIONS: Record<ClientRoleName, PermissionCode[]> = {
  CLIENT_OWNER: OWNER_TIER,
  CLIENT_ADMIN: ADMIN_TIER,
  CLIENT_MANAGER: MANAGER_TIER,
  CLIENT_USER: USER_TIER,
};

export const CLIENT_ROLE_DESCRIPTIONS: Record<ClientRoleName, string> = {
  CLIENT_OWNER: "Full access to every area of the account. Cannot be edited or deleted.",
  CLIENT_ADMIN: "Runs the account, but cannot change company-wide profile/settings. Cannot be edited or deleted.",
  CLIENT_MANAGER: "Runs day-to-day work (campaigns, pipeline, leads, forms). Cannot be edited or deleted.",
  CLIENT_USER: "Read-only access. Cannot be edited or deleted.",
};

/**
 * Which fixed-catalog role NAMES resolve to the CURRENT live ALL_PERMISSIONS
 * at token-issue time (src/application/auth.ts#effectivePermissions) rather
 * than the role's own stored `permissions` snapshot - i.e. which roles are
 * meant to auto-heal and never fall behind when a new PERMISSIONS.*
 * constant is added later, the legacy single "Owner" role's exact original
 * behavior. Deliberately scoped by NAME, not by `isSystem` alone: every
 * fixed-catalog role (Owner/Admin/Manager/User alike) is `isSystem: true`
 * (uneditable - see api/admin/roles/handler.ts's isSystem check), but only
 * the true "full access" tiers should silently gain every future
 * permission - Manager/User must keep the narrower, tiered permission set
 * this whole feature exists to enforce, not quietly regain full access the
 * next time a PERMISSIONS.* constant is added.
 */
const FULL_ACCESS_ROLE_NAMES: string[] = ["Owner", "AGENCY_OWNER", "CLIENT_OWNER"];

export function isFullAccessSystemRoleName(name: string): boolean {
  return FULL_ACCESS_ROLE_NAMES.includes(name);
}
