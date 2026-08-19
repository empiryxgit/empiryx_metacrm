// Combines list/create (/api/admin/users) and update
// (/api/admin/users/{userId}) into ONE Vercel Function - see
// api/auth/handler.ts for why. Public URLs unchanged - vercel.json rewrites
// /api/admin/users/:userId here with userId injected as a query param
// (Vercel's filesystem [[...x]].ts catch-all convention was found not to
// reliably populate req.query in this deployment, so every dynamic route
// now uses the same explicit-rewrite pattern api/system.ts already relied
// on).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireAuth, requirePermission } from "../../../src/infrastructure/auth/context";
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
import { generateTempPassword, hashPassword } from "../../../src/infrastructure/auth/password";
import { PERMISSIONS } from "../../../src/domain/permissions";
import { getIndustryTemplate } from "../../../src/domain/industryTemplates";
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

    const { fullName, email, roleId } = (req.body ?? {}) as { fullName?: string; email?: string; roleId?: string };
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
  const template = company ? getIndustryTemplate(company.industryTemplate) : null;

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
  });
}

async function handleOne(req: VercelRequest, res: VercelResponse, userId: string) {
  if (req.method === "GET") {
    return handleView(req, res, userId);
  }

  const auth = await requirePermission(req, res, PERMISSIONS.USERS_MANAGE);
  if (!auth) return;

  if (req.method === "PATCH") {
    const { roleId, status, fullName } = (req.body ?? {}) as {
      roleId?: string;
      status?: string;
      fullName?: string;
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
      const target = await getUserById(userId);
      if (target) {
        const others = await countOtherActiveUsersWithRole(auth.companyId, target.roleId, userId);
        const targetRole = await getRoleById(auth.companyId, target.roleId);
        const targetManagesUsers = ((targetRole?.permissions as string[]) ?? []).includes(PERMISSIONS.USERS_MANAGE);
        if (targetManagesUsers && others === 0) {
          res.status(409).json({ error: "Cannot disable or re-role the last admin who can manage users." });
          return;
        }
      }
    }

    await updateUser(auth.companyId, userId, { roleId, status, fullName });
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
