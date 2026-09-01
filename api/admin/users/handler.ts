// Combines list/create (/api/admin/users) and update
// (/api/admin/users/{userId}) into ONE Vercel Function - see
// api/auth/handler.ts for why. Public URLs unchanged - vercel.json rewrites
// /api/admin/users/:userId here with userId injected as a query param
// (Vercel's filesystem [[...x]].ts catch-all convention was found not to
// reliably populate req.query in this deployment, so every dynamic route
// now uses the same explicit-rewrite pattern api/system.ts already relied
// on).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth, requirePermission, parseCookies, type AuthContext } from "../../../src/infrastructure/auth/context";
import {
  countOtherActiveUsersWithRole,
  createUser,
  emailExists,
  getCompanyById,
  getRoleById,
  getUserById,
  listUsers,
  updateUser,
} from "../../../src/infrastructure/db/repositories/tenancy";
import { resolveAgencyClientAccess, assertAgencyAccountType } from "../../../src/application/agencyClientAccess";
import { getUserAssignedClientIds, setAssignedClients } from "../../../src/infrastructure/db/repositories/agencyClientAssignments";
import { listClaimedClientOrganizations } from "../../../src/infrastructure/db/repositories/organizations";
import { generateTempPassword, hashPassword } from "../../../src/infrastructure/auth/password";
import { PERMISSIONS } from "../../../src/domain/permissions";
import { resolveEffectiveIndustryTemplate } from "../../../src/domain/industryTemplates";
import { resolveBranchAccess } from "../../../src/application/branchAccess";
import {
  addUserToBranch,
  archiveBranch,
  codeExists,
  countBranchUsersByBranch,
  createBranch,
  getBranchById,
  listBranches,
  listBranchUsers,
  listUserBranches,
  removeUserFromBranch,
  setPrimaryBranch,
  updateBranch,
} from "../../../src/infrastructure/db/repositories/branches";
import { AuthError, login } from "../../../src/application/auth";
import { setAuthCookies, CLIENT_CONTEXT_COOKIE_NAME, cookieOptions, clearCookieOptions } from "../../../src/infrastructure/auth/tokens";
import { checkAgencyCanManageClient } from "../../../src/application/agencyClientContext";
import { recordAgencyAuditEvent } from "../../../src/application/agencyAuditLog";
import {
  addClientOrganization,
  getAgencyCampaignsReport,
  getAgencyDashboardSummary,
  getAgencyLeadsReport,
  getClientDetail,
  getPendingInviteForCompany,
  inviteExistingClient,
  listAgencyClients,
  respondToAgencyInvite,
  setClientRelationshipStatus,
} from "../../../src/application/agency";
import {
  completeAgencyOnboarding,
  generateOnboardingLink,
  getOnboardingLinkPreview,
  listOnboardingLinks,
  revokeOnboardingLink,
} from "../../../src/application/agencyOnboarding";

function getQueryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function getUserId(req: VercelRequest): string | undefined {
  return getQueryString(req, "userId");
}

// Branch admin (list/create/view/update/archive branches, and manage
// branch_users) is folded into this same Vercel Function rather than given
// its own file - Vercel Hobby caps a deployment at 12 Functions total and
// this was already the 12th/last available slot (see api/forms/handler.ts's
// note) - so vercel.json routes every /api/branches/* path here with
// ?resource=branches (plus branchId/action/branchUserId as needed) instead.
// Falls through to the pre-existing user-management behavior below whenever
// ?resource= is absent, so /api/admin/users is completely unaffected.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = getQueryString(req, "resource");
  if (resource === "branches") {
    return handleBranchesResource(req, res);
  }
  if (resource === "agency") {
    return handleAgencyResource(req, res);
  }
  if (resource === "agencyInvite") {
    return handleAgencyInviteResource(req, res);
  }
  if (resource === "agencyOnboardingPublic") {
    return handleAgencyOnboardingPublicResource(req, res);
  }

  const userId = getUserId(req);
  if (userId) {
    return handleOne(req, res, userId);
  }
  return handleCollection(req, res);
}

// Admin "create user" form: the admin sets name/email/role, the system
// generates a temporary password and returns it ONCE in this response body
// (never stored in plaintext, never emailed - see the architecture doc for
// why: no transactional-email dependency needed to stay free-tier-only).
// The admin relays it to the new user, who must change it on first login
// (see mustChangePassword on the users table + api/auth/[[...action]].ts).
async function handleCollection(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
    if (!auth) return;
    const users = await listUsers(auth.companyId);
    res.status(200).json({ users });
    return;
  }

  if (req.method === "POST") {
    const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
    if (!auth) return;

    const { fullName, email, roleId, assignedClientIds } = (req.body ?? {}) as {
      fullName?: string;
      email?: string;
      roleId?: string;
      // Assigned Clients, set at creation time - see the PATCH branch
      // below (handleOne) for the full tenant-safety validation this
      // shares; only meaningful (and only validated/applied) for an agency
      // company - silently ignored for any other accountType.
      assignedClientIds?: string[];
    };
    if (!fullName || !email || !roleId) {
      res.status(400).json({ error: "fullName, email and roleId are all required." });
      return;
    }

    const role = await getRoleById(auth.companyId, roleId);
    if (!role) {
      res.status(400).json({ error: "That role does not belong to this company." });
      return;
    }
    if (await emailExists(email)) {
      res.status(409).json({ error: "A user with this email already exists." });
      return;
    }

    const isAgencyWithAssignments = Array.isArray(assignedClientIds) && assignedClientIds.length > 0;
    const company = isAgencyWithAssignments ? await getCompanyById(auth.companyId) : null;
    if (isAgencyWithAssignments && company?.accountType === "agency") {
      const claimed = await listClaimedClientOrganizations(auth.companyId);
      const claimedIds = new Set(claimed.map((c) => c.clientCompanyId));
      const invalid = assignedClientIds!.filter((id) => !claimedIds.has(id));
      if (invalid.length > 0) {
        res.status(400).json({ error: "One or more clients are not part of your agency's roster." });
        return;
      }
    }

    const tempPassword = generateTempPassword();
    const passwordHash = await hashPassword(tempPassword);
    const user = await createUser({
      companyId: auth.companyId,
      roleId,
      email,
      passwordHash,
      fullName,
      mustChangePassword: true,
    });

    // AGENCY_USER_CREATED - only meaningful for an agency company (see
    // agencyAuditLog.ts's header comment: agencyUserId is always the ACTOR,
    // here the admin creating the account; the new user's own id/email is
    // recorded in `detail` as non-secret context, not as agencyUserId).
    // clientCompanyId is null - user creation itself has no client subject.
    const isAgencyCompany = (company ?? (await getCompanyById(auth.companyId)))?.accountType === "agency";
    if (isAgencyCompany) {
      await recordAgencyAuditEvent({
        agencyCompanyId: auth.companyId,
        action: "AGENCY_USER_CREATED",
        agencyUserId: auth.userId,
        detail: `Created user ${email}`,
      });
    }

    if (isAgencyWithAssignments && company?.accountType === "agency") {
      await setAssignedClients({
        agencyCompanyId: auth.companyId,
        userId: user.id,
        clientCompanyIds: assignedClientIds!,
        createdBy: auth.userId,
      });
      // CLIENT_ACCESS_GRANTED - one event per client the new user was
      // assigned at creation time (see agencyAuditLog.ts's header comment).
      for (const clientCompanyId of assignedClientIds!) {
        await recordAgencyAuditEvent({
          agencyCompanyId: auth.companyId,
          action: "CLIENT_ACCESS_GRANTED",
          agencyUserId: auth.userId,
          clientCompanyId,
          detail: `Granted to new user ${email} at creation`,
        });
      }
    }

    res.status(201).json({
      user: { id: user.id, email: user.email, fullName: user.fullName },
      // Shown exactly once - the client must display this to the admin
      // immediately and cannot retrieve it again.
      temporaryPassword: tempPassword,
    });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

// "View" on the Users page - a single user's full profile plus their
// company's context (name, size, industry). Deliberately does NOT include
// campaigns or any other company-scoped data - this is a user-detail view,
// not a company-detail view, so it stays limited to what's needed there.
async function handleView(req: VercelRequest, res: VercelResponse, userId: string) {
  const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
  if (!auth) return;

  const [user, company] = await Promise.all([getUserById(userId), getCompanyById(auth.companyId)]);
  if (!user || user.companyId !== auth.companyId) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  const role = await getRoleById(auth.companyId, user.roleId);
  const template = company ? resolveEffectiveIndustryTemplate(company.industryTemplate, company.customTemplateConfig) : null;

  // Assigned Clients (Users -> View -> "which clients can this teammate
  // see") is only a meaningful concept for an agency company's own users -
  // see src/domain/fixedRoles.ts/agencyClientAccess.ts. Omitted entirely
  // (not just empty) for any other company so the frontend has a clean
  // "does this even apply" signal rather than inferring it from an
  // always-empty array.
  const assignedClientIds = company?.accountType === "agency" ? await getUserAssignedClientIds(userId) : undefined;

  res.status(200).json({
    user: {
      id: user.id,
      fullName: user.fullName,
      email: user.email,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      mustChangePassword: user.mustChangePassword,
    },
    role: role ? { id: role.id, name: role.name } : null,
    company: company
      ? {
          name: company.name,
          companySize: company.companySize,
          industry: template?.name ?? null,
        }
      : null,
    assignedClientIds,
  });
}

async function handleOne(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method === "GET") {
    return handleView(req, res, userId);
  }

  const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
  if (!auth) return;

  // Tenant-isolation hardening: previously this branch went straight to
  // updateUser() below, which IS correctly scoped by companyId (a
  // cross-tenant userId simply matches zero rows there - no data was ever
  // written or leaked) - but nothing here checked existence/ownership
  // FIRST, so a PATCH aimed at another company's userId silently fell
  // through the "everything below is a no-op" path and still came back
  // `200 {"updated": true}`, a misleading success response for a request
  // that changed nothing. Checking company ownership up front, the same
  // way handleView (GET) already does, makes this endpoint respond
  // consistently (404) for a userId outside the caller's own company
  // instead of only being safe by accident of how the UPDATE's WHERE
  // clause happens to be written.
  const existingTarget = await getUserById(userId);
  if (!existingTarget || existingTarget.companyId !== auth.companyId) {
    res.status(404).json({ error: "User not found." });
    return;
  }

  if (req.method === "PATCH") {
    const { roleId, status, fullName, assignedClientIds } = (req.body ?? {}) as {
      roleId?: string;
      status?: string;
      fullName?: string;
      // "Assigned Clients" (see agencyClientAssignments.ts) - only honored
      // for an agency company's own users, checked just below. Undefined
      // means "leave assignments unchanged"; an array (even empty) means
      // "replace with exactly this set" - see setAssignedClients.
      assignedClientIds?: string[];
    };

    if (roleId) {
      const role = await getRoleById(auth.companyId, roleId);
      if (!role) {
        res.status(400).json({ error: "That role does not belong to this company." });
        return;
      }
    }

    // Guard rail: don't allow disabling or re-roling the last active user
    // who holds a role capable of managing users - that would permanently
    // lock the company out of its own admin panel.
    if (status === "disabled" || roleId) {
      const others = await countOtherActiveUsersWithRole(auth.companyId, existingTarget.roleId, userId);
      const targetRole = await getRoleById(auth.companyId, existingTarget.roleId);
      const targetManagesUsers = ((targetRole?.permissions as string[]) ?? []).includes(PERMISSIONS.USERS_MANAGE);
      if (targetManagesUsers && others === 0) {
        res.status(409).json({ error: "Cannot disable or re-role the last admin who can manage users." });
        return;
      }
    }

    if (Array.isArray(assignedClientIds)) {
      const company = await getCompanyById(auth.companyId);
      if (company?.accountType !== "agency") {
        res.status(400).json({ error: "Assigned clients only apply to agency accounts." });
        return;
      }
      // Tenant-safety: every id must actually be one of THIS agency's own
      // currently-claimed clients - never trust a clientCompanyId the
      // request body supplies on its own (same posture as every other
      // client-facing id in this codebase - see agency.ts's own header
      // comment).
      const claimed = await listClaimedClientOrganizations(auth.companyId);
      const claimedIds = new Set(claimed.map((c) => c.clientCompanyId));
      const invalid = assignedClientIds.filter((id) => !claimedIds.has(id));
      if (invalid.length > 0) {
        res.status(400).json({ error: "One or more clients are not part of your agency's roster." });
        return;
      }
      // Snapshot the BEFORE set so CLIENT_ACCESS_GRANTED/CLIENT_ACCESS_REVOKED
      // can be logged per-client, diffed against the AFTER set - setAssignedClients
      // itself is a replace-all with no diff of its own (see its doc comment).
      const before = new Set(await getUserAssignedClientIds(userId));
      await setAssignedClients({
        agencyCompanyId: auth.companyId,
        userId,
        clientCompanyIds: assignedClientIds,
        createdBy: auth.userId,
      });
      const after = new Set(assignedClientIds);
      for (const clientCompanyId of after) {
        if (!before.has(clientCompanyId)) {
          await recordAgencyAuditEvent({
            agencyCompanyId: auth.companyId,
            action: "CLIENT_ACCESS_GRANTED",
            agencyUserId: auth.userId,
            clientCompanyId,
            detail: `Granted to user ${userId} via Assigned Clients`,
          });
        }
      }
      for (const clientCompanyId of before) {
        if (!after.has(clientCompanyId)) {
          await recordAgencyAuditEvent({
            agencyCompanyId: auth.companyId,
            action: "CLIENT_ACCESS_REVOKED",
            agencyUserId: auth.userId,
            clientCompanyId,
            detail: `Revoked from user ${userId} via Assigned Clients`,
          });
        }
      }
    }

    // AGENCY_USER_ASSIGNED - a role (re)assignment for an existing agency
    // user (see agencyAuditLog.ts's header comment: agencyUserId is always
    // the ACTOR, here the admin making the change; the target user's id is
    // recorded in `detail`, not as a second agencyUserId-shaped column).
    // clientCompanyId is null - a role change has no client subject; that's
    // exactly what the CLIENT_ACCESS_* events just above are for.
    if (roleId && roleId !== existingTarget.roleId) {
      const company = await getCompanyById(auth.companyId);
      if (company?.accountType === "agency") {
        await recordAgencyAuditEvent({
          agencyCompanyId: auth.companyId,
          action: "AGENCY_USER_ASSIGNED",
          agencyUserId: auth.userId,
          detail: `Reassigned role for user ${userId}`,
        });
      }
    }

    await updateUser(auth.companyId, userId, {
      roleId,
      status,
      fullName,
    });
    res.status(200).json({ updated: true });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

// ---------------------------------------------------------------------
// Branches (?resource=branches) - see the note on the default export above
// for why this lives in the users-admin handler rather than its own file.
//
// Route map (see vercel.json):
//   GET/POST      /api/branches                               -> list / create
//   GET/PATCH     /api/branches/{branchId}                     -> view / update
//   POST          /api/branches/{branchId}/archive             -> archive
//   GET/POST      /api/branches/{branchId}/users                -> list members / add member
//   DELETE        /api/branches/{branchId}/users/{branchUserId} -> remove member
//   POST          /api/branches/{branchId}/users/{branchUserId}/primary -> set as that user's primary branch
//
// Every mutating and viewing route is gated on branches.manage - branch
// administration is an admin-only surface, unlike forms/leads/campaigns
// which are readable by anyone with the underlying module permission.
// ---------------------------------------------------------------------

async function handleBranchesResource(req: VercelRequest, res: VercelResponse) {
  const branchId = getQueryString(req, "branchId");
  const action = getQueryString(req, "action");
  const branchUserId = getQueryString(req, "branchUserId");
  const isPrimaryAction = getQueryString(req, "sub") === "primary";

  // These two have no branchId segment at all (/api/branches/mine,
  // /api/branches/company-users) - checked before the branchId branch below
  // so they're never mistaken for a literal branchId value.
  if (!branchId && action === "mine") return handleMyBranches(req, res);
  if (!branchId && action === "company-users") return handleBranchesCompanyUsers(req, res);

  if (!branchId) return handleBranchCollection(req, res);

  if (action === "archive") return handleBranchArchive(req, res, branchId);
  if (action === "users") {
    if (branchUserId) {
      if (isPrimaryAction) return handleSetPrimaryBranch(req, res, branchId, branchUserId);
      return handleRemoveBranchUser(req, res, branchId, branchUserId);
    }
    return handleBranchUsersCollection(req, res, branchId);
  }
  if (!action) return handleBranchOne(req, res, branchId);

  res.status(404).json({ error: "Not found" });
}

// Self-serve lookup for ANY authenticated user (no branches.manage required)
// - powers the global branch switcher in the app shell (see app.js). Not the
// same endpoint as the admin collection above: this returns only ACTIVE
// branches, narrowed to exactly what this user is allowed to see (every
// active branch for an unrestricted/"all" user, or just their own
// membership for a restricted one) - never the full admin list.
async function handleMyBranches(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const access = resolveBranchAccess(auth);

  if (access.scope === "all") {
    const active = (await listBranches(auth.companyId)).filter((b) => b.status === "active");
    res.status(200).json({
      scope: "all",
      branches: active.map((b) => ({ id: b.id, name: b.name, code: b.code, isPrimary: false })),
    });
    return;
  }

  // Restricted: go through the user's own membership rows (not the
  // company-wide branch list filtered down) so isPrimary is available -
  // that's what lets "+ Add Customer" default to a multi-branch user's
  // primary branch instead of just the first one alphabetically.
  const mine = await listUserBranches(auth.userId);
  const active = mine.filter((b) => b.status === "active");
  res.status(200).json({
    scope: "restricted",
    branches: active.map((b) => ({ id: b.branchId, name: b.name, code: b.code, isPrimary: Boolean(b.isPrimary) })),
  });
}

// Minimal user picker for the branch admin UI (assigning a manager /
// members) - gated on branches.manage rather than users.manage, so someone
// who can administer branches doesn't also need separate user-management
// rights just to see who they can assign. Deliberately projects only
// id/fullName/email - never role, status, or anything users.manage's own
// endpoint exposes.
async function handleBranchesCompanyUsers(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
  if (!auth) return;

  const users = await listUsers(auth.companyId);
  res.status(200).json({
    users: users.map((u) => ({ id: u.id, fullName: u.fullName, email: u.email })),
  });
}

async function handleBranchCollection(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
    if (!auth) return;
    const [rows, counts, companyUsers] = await Promise.all([
      listBranches(auth.companyId),
      countBranchUsersByBranch(auth.companyId),
      listUsers(auth.companyId),
    ]);
    const userNameById = new Map(companyUsers.map((u) => [u.id, u.fullName]));
    res.status(200).json({
      branches: rows.map((b) => ({
        ...b,
        userCount: counts.get(b.id) ?? 0,
        managerName: b.managerId ? userNameById.get(b.managerId) ?? null : null,
      })),
    });
    return;
  }

  if (req.method === "POST") {
    const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
    if (!auth) return;

    const body = (req.body ?? {}) as {
      name?: string;
      code?: string;
      address?: string;
      city?: string;
      state?: string;
      managerId?: string;
      status?: string;
    };
    const name = body.name?.trim();
    const code = body.code?.trim();
    if (!name || !code) {
      res.status(400).json({ error: "name and code are required." });
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
      res.status(400).json({ error: "code may only contain letters, numbers, hyphens and underscores." });
      return;
    }

    if (await codeExists(auth.companyId, code)) {
      res.status(409).json({ error: "A branch with this code already exists." });
      return;
    }

    if (body.managerId) {
      const manager = await getUserById(body.managerId);
      if (!manager || manager.companyId !== auth.companyId) {
        res.status(400).json({ error: "Invalid manager." });
        return;
      }
    }

    try {
      const branch = await createBranch({
        companyId: auth.companyId,
        name,
        code,
        address: body.address?.trim() || undefined,
        city: body.city?.trim() || undefined,
        state: body.state?.trim() || undefined,
        managerId: body.managerId || undefined,
        status: body.status === "inactive" ? "inactive" : "active",
      });
      res.status(201).json({ branch });
    } catch (err) {
      console.error("[branches] Failed to create branch:", err);
      res.status(500).json({ error: "Failed to create branch." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function handleBranchOne(req: VercelRequest, res: VercelResponse, branchId: string) {
  const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
  if (!auth) return;

  if (req.method === "GET") {
    const branch = await getBranchById(auth.companyId, branchId);
    if (!branch) {
      res.status(404).json({ error: "Branch not found." });
      return;
    }
    res.status(200).json({ branch });
    return;
  }

  if (req.method === "PATCH") {
    const existing = await getBranchById(auth.companyId, branchId);
    if (!existing) {
      res.status(404).json({ error: "Branch not found." });
      return;
    }

    const body = (req.body ?? {}) as {
      name?: string;
      code?: string;
      address?: string;
      city?: string;
      state?: string;
      managerId?: string | null;
      status?: string;
    };

    if (body.code !== undefined && body.code.trim() !== existing.code) {
      const code = body.code.trim();
      if (!/^[a-zA-Z0-9_-]+$/.test(code)) {
        res.status(400).json({ error: "code may only contain letters, numbers, hyphens and underscores." });
        return;
      }
      if (await codeExists(auth.companyId, code)) {
        res.status(409).json({ error: "A branch with this code already exists." });
        return;
      }
    }

    if (body.managerId) {
      const manager = await getUserById(body.managerId);
      if (!manager || manager.companyId !== auth.companyId) {
        res.status(400).json({ error: "Invalid manager." });
        return;
      }
    }

    const branch = await updateBranch(auth.companyId, branchId, {
      name: body.name?.trim(),
      code: body.code?.trim(),
      address: body.address?.trim(),
      city: body.city?.trim(),
      state: body.state?.trim(),
      managerId: body.managerId === undefined ? undefined : body.managerId || null,
      status: body.status === undefined ? undefined : body.status === "inactive" ? "inactive" : "active",
    });
    if (!branch) {
      res.status(404).json({ error: "Branch not found." });
      return;
    }
    res.status(200).json({ branch });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function handleBranchArchive(req: VercelRequest, res: VercelResponse, branchId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
  if (!auth) return;

  const branch = await archiveBranch(auth.companyId, branchId);
  if (!branch) {
    res.status(404).json({ error: "Branch not found." });
    return;
  }
  res.status(200).json({ archived: true });
}

async function handleBranchUsersCollection(req: VercelRequest, res: VercelResponse, branchId: string) {
  const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
  if (!auth) return;

  const branch = await getBranchById(auth.companyId, branchId);
  if (!branch) {
    res.status(404).json({ error: "Branch not found." });
    return;
  }

  if (req.method === "GET") {
    const members = await listBranchUsers(branchId);
    res.status(200).json({ users: members });
    return;
  }

  if (req.method === "POST") {
    const body = (req.body ?? {}) as { userId?: string; role?: string; isPrimary?: boolean };
    if (!body.userId) {
      res.status(400).json({ error: "userId is required." });
      return;
    }
    const target = await getUserById(body.userId);
    if (!target || target.companyId !== auth.companyId) {
      res.status(400).json({ error: "Invalid user." });
      return;
    }

    try {
      const membership = await addUserToBranch({
        branchId,
        userId: body.userId,
        role: body.role,
        isPrimary: Boolean(body.isPrimary),
      });
      res.status(200).json({ membership });
    } catch (err) {
      console.error("[branches] Failed to add user to branch:", err);
      res.status(500).json({ error: "Failed to add user to branch." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function handleRemoveBranchUser(req: VercelRequest, res: VercelResponse, branchId: string, targetUserId: string) {
  if (req.method !== "DELETE") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
  if (!auth) return;

  const branch = await getBranchById(auth.companyId, branchId);
  if (!branch) {
    res.status(404).json({ error: "Branch not found." });
    return;
  }

  await removeUserFromBranch(branchId, targetUserId);
  res.status(200).json({ removed: true });
}

async function handleSetPrimaryBranch(req: VercelRequest, res: VercelResponse, branchId: string, targetUserId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.BRANCHES_MANAGE);
  if (!auth) return;

  const branch = await getBranchById(auth.companyId, branchId);
  if (!branch) {
    res.status(404).json({ error: "Branch not found." });
    return;
  }
  const target = await getUserById(targetUserId);
  if (!target || target.companyId !== auth.companyId) {
    res.status(400).json({ error: "Invalid user." });
    return;
  }

  await setPrimaryBranch(targetUserId, branchId);
  res.status(200).json({ updated: true });
}

// Agency Dashboard (public/agency-dashboard.html) is folded into this same
// Vercel Function for the same reason ?resource=branches is - Vercel
// Hobby's 12-Function cap, already fully used (see this file's own header
// comment) - so vercel.json routes /api/agency/* here with ?resource=agency
// (plus ?action=). Falls through to the pre-existing behavior above
// whenever ?resource= is absent or is "branches", so neither is affected.
//
// Unlike every other resource in this file, these two actions are gated on
// accountType === "agency" rather than a PERMISSIONS.* code - there is no
// granular permission for "runs an agency" the way there is for e.g.
// branches.manage, since every agency account today is its own Owner (see
// src/application/accountType.ts's own doc comment on why this is an
// organization-level attribute). requireAuth (not requirePermission) is
// used for exactly that reason.
async function handleAgencyResource(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  try {
    assertAgencyAccountType(company.accountType);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }

  const action = getQueryString(req, "action");
  if (action === "dashboard") return handleAgencyDashboard(req, res, auth);
  if (action === "leads-report") return handleAgencyLeadsReport(req, res, auth);
  if (action === "campaigns-report") return handleAgencyCampaignsReport(req, res, auth);
  if (action === "clients") return handleAgencyClientsCollection(req, res, auth);
  if (action === "invite-client") return handleAgencyInviteClient(req, res, auth.companyId, auth.userId);
  if (action === "client-detail") return handleAgencyClientDetail(req, res, auth);
  if (action === "set-client-status") return handleAgencySetClientStatus(req, res, auth.companyId, auth.userId);
  if (action === "generate-onboarding-link") return handleAgencyGenerateOnboardingLink(req, res, auth.companyId, auth.userId);
  if (action === "list-onboarding-links") return handleAgencyListOnboardingLinks(req, res, auth.companyId);
  if (action === "revoke-onboarding-link") return handleAgencyRevokeOnboardingLink(req, res, auth.companyId);
  if (action === "enter-client-context") return handleAgencyEnterClientContext(req, res, auth);
  if (action === "exit-client-context") return handleAgencyExitClientContext(req, res, auth);

  res.status(404).json({ error: "Not found" });
}

// The "client switcher" - see src/application/agencyClientContext.ts's own
// header comment for the full design. These two actions are the ONLY place
// CLIENT_CONTEXT_COOKIE_NAME is ever set or cleared; every other consumer
// (withEffectiveCompanyContext, handleMe) only ever reads it back.
async function handleAgencyEnterClientContext(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { clientCompanyId } = (req.body ?? {}) as { clientCompanyId?: string };
  if (!clientCompanyId) {
    res.status(400).json({ error: "clientCompanyId is required." });
    return;
  }
  const result = await checkAgencyCanManageClient(auth, clientCompanyId);
  if (!result.ok) {
    res.status(403).json({ error: "You don't have access to that client." });
    return;
  }
  // Session-lifetime cookie (no Max-Age) - see CLIENT_CONTEXT_COOKIE_NAME's
  // own comment in tokens.ts for why this deliberately doesn't persist
  // across a browser restart the way "remember me" sessions can.
  res.setHeader("Set-Cookie", [`${CLIENT_CONTEXT_COOKIE_NAME}=${clientCompanyId}; ${cookieOptions(null)}`]);
  // CLIENT_CONTEXT_SWITCHED - see agencyAuditLog.ts's header comment. Only
  // logged once checkAgencyCanManageClient has actually authorized the
  // switch above (result.ok), so this never claims a switch happened when
  // access was denied.
  await recordAgencyAuditEvent({
    agencyCompanyId: auth.companyId,
    action: "CLIENT_CONTEXT_SWITCHED",
    agencyUserId: auth.userId,
    clientCompanyId,
    detail: "Entered client context",
  });
  res.status(200).json({ ok: true, clientName: result.clientName, agencyName: result.agencyName });
}

async function handleAgencyExitClientContext(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // The client being exited must be read from the cookie BEFORE it's
  // cleared below - this is the only place that "which client was I in"
  // information is available server-side (see this section's own header
  // comment: neither this handler nor the cookie value round-trips through
  // the request body).
  const previousClientCompanyId = parseCookies(req)[CLIENT_CONTEXT_COOKIE_NAME] ?? null;
  res.setHeader("Set-Cookie", [`${CLIENT_CONTEXT_COOKIE_NAME}=; ${clearCookieOptions()}`]);
  if (previousClientCompanyId) {
    await recordAgencyAuditEvent({
      agencyCompanyId: auth.companyId,
      action: "CLIENT_CONTEXT_SWITCHED",
      agencyUserId: auth.userId,
      clientCompanyId: previousClientCompanyId,
      detail: "Exited client context",
    });
  }
  res.status(200).json({ ok: true });
}

async function handleAgencyDashboard(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const summary = await getAgencyDashboardSummary(auth.companyId, resolveAgencyClientAccess(auth));
  res.status(200).json(summary);
}

// "Agency Leads" - aggregate lead reporting across every client this
// caller can see (see getAgencyLeadsReport's own doc comment for the full
// authorization discipline: every filter is independently re-checked
// against resolveAgencyClientAccess, never trusted at face value). Same
// no-extra-permission-gate posture as handleAgencyDashboard above - any
// authenticated member of an agency company can call this, narrowed
// entirely by their own resolved client access.
async function handleAgencyLeadsReport(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const report = await getAgencyLeadsReport(auth.companyId, resolveAgencyClientAccess(auth), {
      clientId: getQueryString(req, "clientId"),
      from: getQueryString(req, "from"),
      to: getQueryString(req, "to"),
      source: getQueryString(req, "source"),
      campaignId: getQueryString(req, "campaignId"),
      status: getQueryString(req, "status"),
      assignedUserId: getQueryString(req, "assignedUserId"),
    });
    res.status(200).json(report);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency/leads-report] Failed:", err);
    res.status(500).json({ error: "Failed to load the leads report." });
  }
}

// "Agency Campaigns" - the campaign-centric sibling of
// handleAgencyLeadsReport above. Same no-extra-permission-gate posture:
// any authenticated member of an agency company can call this, narrowed
// entirely by their own resolved client access.
async function handleAgencyCampaignsReport(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const report = await getAgencyCampaignsReport(auth.companyId, resolveAgencyClientAccess(auth), {
      clientId: getQueryString(req, "clientId"),
      status: getQueryString(req, "status"),
      platform: getQueryString(req, "platform"),
    });
    res.status(200).json(report);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency/campaigns-report] Failed:", err);
    res.status(500).json({ error: "Failed to load campaigns." });
  }
}

// Collection endpoint at /api/agency/clients - GET lists the roster (same
// data/authorization listAgencyClients shares with the dashboard's own
// Clients table, just without the KPI rollup attached), POST creates a
// brand-new client company the agency owns outright (addClientOrganization
// - see that function's own doc comment for why no invite/accept step is
// needed here, unlike handleAgencyInviteClient below). Same GET-list /
// POST-create shape this file already uses for /api/admin/users
// (handleCollection) and /api/branches (handleBranchCollection) - no
// extra permission gate beyond handleAgencyResource's own accountType
// check, same as every other agency action.
async function handleAgencyClientsCollection(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  if (req.method === "GET") {
    const clients = await listAgencyClients(auth.companyId, resolveAgencyClientAccess(auth));
    res.status(200).json({ clients });
    return;
  }

  if (req.method === "POST") {
    const { companyName, ownerName, ownerEmail } = (req.body ?? {}) as {
      companyName?: string;
      ownerName?: string;
      ownerEmail?: string;
    };
    if (!companyName || !ownerName || !ownerEmail) {
      res.status(400).json({ error: "companyName, ownerName and ownerEmail are all required." });
      return;
    }
    try {
      const result = await addClientOrganization({ agencyCompanyId: auth.companyId, actingUserId: auth.userId, companyName, ownerName, ownerEmail });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error("[agency/clients] Failed to add client:", err);
      res.status(500).json({ error: "Failed to add client." });
    }
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function handleAgencyInviteClient(req: VercelRequest, res: VercelResponse, agencyCompanyId: string, actingUserId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { ownerEmail } = (req.body ?? {}) as { ownerEmail?: string };
  if (!ownerEmail) {
    res.status(400).json({ error: "ownerEmail is required." });
    return;
  }
  try {
    const result = await inviteExistingClient({ agencyCompanyId, actingUserId, ownerEmail });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency/invite-client] Failed:", err);
    res.status(500).json({ error: "Failed to send invitation." });
  }
}

async function handleAgencyClientDetail(req: VercelRequest, res: VercelResponse, auth: AuthContext) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const clientId = getQueryString(req, "clientId");
  if (!clientId) {
    res.status(400).json({ error: "clientId is required." });
    return;
  }
  try {
    const detail = await getClientDetail(auth.companyId, clientId, resolveAgencyClientAccess(auth));
    res.status(200).json(detail);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency/client-detail] Failed:", err);
    res.status(500).json({ error: "Failed to load client." });
  }
}

async function handleAgencySetClientStatus(req: VercelRequest, res: VercelResponse, agencyCompanyId: string, actingUserId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const clientId = getQueryString(req, "clientId");
  const { status } = (req.body ?? {}) as { status?: string };
  if (!clientId || !status || !["active", "suspended", "removed"].includes(status)) {
    res.status(400).json({ error: "clientId and a valid status (active, suspended, or removed) are required." });
    return;
  }
  try {
    await setClientRelationshipStatus(agencyCompanyId, clientId, status as "active" | "suspended" | "removed", actingUserId);
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency/set-client-status] Failed:", err);
    res.status(500).json({ error: "Failed to update client." });
  }
}

async function handleAgencyGenerateOnboardingLink(req: VercelRequest, res: VercelResponse, agencyCompanyId: string, actingUserId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { clientName, contactEmail } = (req.body ?? {}) as { clientName?: string; contactEmail?: string };
  if (!clientName || !contactEmail) {
    res.status(400).json({ error: "clientName and contactEmail are required." });
    return;
  }
  try {
    const result = await generateOnboardingLink({ agencyCompanyId, actingUserId, clientName, contactEmail });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency/generate-onboarding-link] Failed:", err);
    res.status(500).json({ error: "Failed to generate onboarding link." });
  }
}

async function handleAgencyListOnboardingLinks(req: VercelRequest, res: VercelResponse, agencyCompanyId: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const links = await listOnboardingLinks(agencyCompanyId);
  res.status(200).json({ links });
}

async function handleAgencyRevokeOnboardingLink(req: VercelRequest, res: VercelResponse, agencyCompanyId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const tokenId = getQueryString(req, "tokenId");
  if (!tokenId) {
    res.status(400).json({ error: "tokenId is required." });
    return;
  }
  await revokeOnboardingLink(agencyCompanyId, tokenId);
  res.status(200).json({ ok: true });
}

// ---- Agency invite: the CLIENT side (any accountType) ---------------------
// Unlike handleAgencyResource above, this is NOT gated on accountType ===
// "agency" - any company can be the target of an invite, so this only ever
// requires a valid session and scopes every lookup to that session's OWN
// companyId. See getPendingInviteForCompany/respondToAgencyInvite in
// src/application/agency.ts for the actual logic.
async function handleAgencyInviteResource(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const action = getQueryString(req, "action");
  if (action === "pending") return handleAgencyInvitePending(req, res, auth.companyId);
  if (action === "respond") return handleAgencyInviteRespond(req, res, auth.companyId, auth.userId);

  res.status(404).json({ error: "Not found" });
}

async function handleAgencyInvitePending(req: VercelRequest, res: VercelResponse, companyId: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const invite = await getPendingInviteForCompany(companyId);
  res.status(200).json({ invite });
}

async function handleAgencyInviteRespond(req: VercelRequest, res: VercelResponse, companyId: string, actingClientUserId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { agencyCompanyId, accept } = (req.body ?? {}) as { agencyCompanyId?: string; accept?: boolean };
  if (!agencyCompanyId || typeof accept !== "boolean") {
    res.status(400).json({ error: "agencyCompanyId and accept are required." });
    return;
  }
  try {
    await respondToAgencyInvite({ companyId, agencyCompanyId, accept, actingClientUserId });
    res.status(200).json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency-invite/respond] Failed:", err);
    res.status(500).json({ error: "Failed to respond to invitation." });
  }
}

// ---- Agency onboarding link: the PUBLIC side (no auth at all) -------------
// Backs /onboarding/agency/{token} (public/onboarding-agency.html, reached
// via the vercel.json rewrite that turns that path into
// ?token=... on this same static page - see that page's own header
// comment). Deliberately calls neither requireAuth nor requirePermission -
// whoever is completing this link usually has no RUTA account yet. The
// token itself, hashed and looked up in getOnboardingLinkPreview /
// completeAgencyOnboarding (src/application/agencyOnboarding.ts), is the
// only thing that authorizes anything here; nothing in this function reads
// an agencyCompanyId/clientCompanyId from the request at all. Same
// unauthenticated-by-design posture as handlePublicGet/handlePublicSubmit
// above for public form links.
async function handleAgencyOnboardingPublicResource(req: VercelRequest, res: VercelResponse) {
  const action = getQueryString(req, "action");
  const token = getQueryString(req, "token");
  if (!token) {
    res.status(400).json({ error: "token is required." });
    return;
  }

  if (action === "complete") return handleAgencyOnboardingComplete(req, res, token);
  return handleAgencyOnboardingPreview(req, res, token);
}

async function handleAgencyOnboardingPreview(req: VercelRequest, res: VercelResponse, token: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  try {
    const preview = await getOnboardingLinkPreview(token);
    res.status(200).json(preview);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency-onboarding/preview] Failed:", err);
    res.status(500).json({ error: "Failed to load invitation." });
  }
}

async function handleAgencyOnboardingComplete(req: VercelRequest, res: VercelResponse, token: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const { companyName, ownerName, ownerEmail, phoneNumber, password } = (req.body ?? {}) as {
    companyName?: string;
    ownerName?: string;
    ownerEmail?: string;
    phoneNumber?: string;
    password?: string;
  };
  if (!companyName || !ownerName || !ownerEmail || !phoneNumber || !password) {
    res.status(400).json({ error: "companyName, ownerName, ownerEmail, phoneNumber and password are all required." });
    return;
  }
  try {
    const result = await completeAgencyOnboarding({ token, companyName, ownerName, ownerEmail, phoneNumber, password });

    // Client Organization Created -> Linked to Agency -> Client Dashboard:
    // the redirect only actually lands signed-in if a session exists yet,
    // so log the new owner in immediately - same "registration and first
    // login are the same moment" reasoning, and the same setAuthCookies
    // call, as handleRegister in api/auth/handler.ts. Uses the plaintext
    // password straight from this request's own body (never a value
    // completeAgencyOnboarding returns - it never returns the password at
    // all, same as every other flow in this codebase that only ever
    // returns a system-GENERATED temp password, never a user-CHOSEN one).
    const tokens = await login({
      email: ownerEmail,
      password,
      userAgent: req.headers["user-agent"],
      ipAddress: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
      rememberMe: true,
    });
    setAuthCookies(res, tokens);

    res.status(201).json(result);
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[agency-onboarding/complete] Failed:", err);
    res.status(500).json({ error: "Failed to complete registration." });
  }
}
