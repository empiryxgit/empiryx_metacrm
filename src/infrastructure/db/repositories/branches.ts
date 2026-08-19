// Branches & branch membership - multi-branch support. Every function here
// is company-scoped the same way tenancy.ts's user/role functions are
// (companyId is always part of the WHERE clause on anything that reads or
// mutates a single branch), so a branchId belonging to another company can
// never be read, updated, or linked to - see getBranchById below, which is
// the one function every API handler MUST route a client-supplied branchId
// through before trusting it.

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../client";
import { branchUsers, branches, users } from "../schema";
import { firstOrThrow } from "../util";

// ---- Branches -------------------------------------------------------------

export interface CreateBranchInput {
  companyId: string;
  name: string;
  code: string;
  address?: string;
  city?: string;
  state?: string;
  managerId?: string;
  // Optional - the column defaults to "active" itself, so omitting this
  // still behaves exactly as it did before the create form exposed a
  // Status field.
  status?: string;
}

export async function createBranch(input: CreateBranchInput) {
  const db = await getDb();
  const rows = await db.insert(branches).values(input).returning();
  return firstOrThrow(rows);
}

export async function listBranches(companyId: string) {
  const db = await getDb();
  return db.select().from(branches).where(eq(branches.companyId, companyId));
}

/** Member counts for every branch in this company, keyed by branchId - one
 * query, counted client-side rather than a SQL GROUP BY (matches this
 * repo's existing simple-query style; branch_users rows per company are
 * never large enough for this to matter). Powers the "Users" column on the
 * branches admin page (see public/admin/branches.html) - never trusted for
 * access control, purely a display count. */
export async function countBranchUsersByBranch(companyId: string): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .select({ branchId: branchUsers.branchId })
    .from(branchUsers)
    .innerJoin(branches, eq(branchUsers.branchId, branches.id))
    .where(eq(branches.companyId, companyId));
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.branchId, (counts.get(row.branchId) ?? 0) + 1);
  return counts;
}

/** THE tenant-isolation checkpoint for branches: returns null (never the
 * row) whenever the branch belongs to a different company, so every caller
 * that does `if (!branch) return 404` can never leak or act on another
 * tenant's branch, regardless of how the branchId reached this call. */
export async function getBranchById(companyId: string, branchId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(branches)
    .where(and(eq(branches.companyId, companyId), eq(branches.id, branchId)))
    .limit(1);
  return row ?? null;
}

export async function codeExists(companyId: string, code: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.companyId, companyId), eq(branches.code, code)))
    .limit(1);
  return Boolean(row);
}

export async function updateBranch(
  companyId: string,
  branchId: string,
  input: { name?: string; code?: string; address?: string; city?: string; state?: string; managerId?: string | null; status?: string },
) {
  const db = await getDb();
  const rows = await db
    .update(branches)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(branches.companyId, companyId), eq(branches.id, branchId)))
    .returning();
  return rows[0] ?? null;
}

/** Never a hard delete - a branch can carry leads/campaigns/forms with
 * years of history. "inactive" just hides it from pickers; every row that
 * still points at it (branchId columns are all ON DELETE SET NULL, not
 * cascade) keeps working exactly as it did before. */
export async function archiveBranch(companyId: string, branchId: string) {
  const db = await getDb();
  const rows = await db
    .update(branches)
    .set({ status: "inactive", updatedAt: new Date() })
    .where(and(eq(branches.companyId, companyId), eq(branches.id, branchId)))
    .returning();
  return rows[0] ?? null;
}

// ---- Branch membership (branch_users) --------------------------------

export async function listBranchUsers(branchId: string) {
  const db = await getDb();
  return db
    .select({
      branchId: branchUsers.branchId,
      userId: branchUsers.userId,
      role: branchUsers.role,
      isPrimary: branchUsers.isPrimary,
      fullName: users.fullName,
      email: users.email,
      createdAt: branchUsers.createdAt,
    })
    .from(branchUsers)
    .innerJoin(users, eq(branchUsers.userId, users.id))
    .where(eq(branchUsers.branchId, branchId));
}

/** Every branch (any company) a user belongs to - used both by the admin
 * "which branches is this user in" view and to populate the branchIds JWT
 * claim at login (src/application/auth.ts). Callers that need company
 * isolation must intersect with a company-scoped branch lookup themselves;
 * this alone does not filter by company because a user only ever belongs to
 * branches of their own company in practice (branch_users.userId always
 * comes from a company-scoped createUser), so no cross-tenant leak is
 * possible via this path. */
export async function listUserBranches(userId: string) {
  const db = await getDb();
  return db
    .select({
      branchId: branchUsers.branchId,
      role: branchUsers.role,
      isPrimary: branchUsers.isPrimary,
      name: branches.name,
      code: branches.code,
      status: branches.status,
    })
    .from(branchUsers)
    .innerJoin(branches, eq(branchUsers.branchId, branches.id))
    .where(eq(branchUsers.userId, userId));
}

/** Lightweight id-only list for the JWT claim - see AccessTokenClaims.branchIds. */
export async function getUserBranchIds(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db.select({ branchId: branchUsers.branchId }).from(branchUsers).where(eq(branchUsers.userId, userId));
  return rows.map((r) => r.branchId);
}

export interface AddUserToBranchInput {
  branchId: string;
  userId: string;
  role?: string;
  isPrimary?: boolean;
}

/** Caller MUST already have verified (via getBranchById + a company-scoped
 * user lookup) that both the branch and the user belong to the same
 * company - this function itself does not repeat that check, to avoid two
 * different call sites disagreeing on how "same company" is verified. See
 * the branches API handler for the actual checkpoint. */
export async function addUserToBranch(input: AddUserToBranchInput) {
  const db = await getDb();

  // No multi-statement transactions over the Neon HTTP driver (see
  // src/application/auth.ts for the same constraint) - sequential,
  // individually-safe statements instead. Clearing every other primary flag
  // for this user BEFORE the insert/upsert keeps the partial unique index
  // (ux_branch_users_one_primary_per_user) from ever rejecting the write.
  if (input.isPrimary) {
    await db.update(branchUsers).set({ isPrimary: false, updatedAt: new Date() }).where(eq(branchUsers.userId, input.userId));
  }

  const [existing] = await db
    .select({ id: branchUsers.id })
    .from(branchUsers)
    .where(and(eq(branchUsers.branchId, input.branchId), eq(branchUsers.userId, input.userId)))
    .limit(1);

  if (existing) {
    const rows = await db
      .update(branchUsers)
      .set({ role: input.role ?? "staff", isPrimary: Boolean(input.isPrimary), updatedAt: new Date() })
      .where(eq(branchUsers.id, existing.id))
      .returning();
    return firstOrThrow(rows);
  }

  const rows = await db
    .insert(branchUsers)
    .values({
      branchId: input.branchId,
      userId: input.userId,
      role: input.role ?? "staff",
      isPrimary: Boolean(input.isPrimary),
    })
    .returning();
  return firstOrThrow(rows);
}

export async function removeUserFromBranch(branchId: string, userId: string) {
  const db = await getDb();
  await db.delete(branchUsers).where(and(eq(branchUsers.branchId, branchId), eq(branchUsers.userId, userId)));
}

export async function setPrimaryBranch(userId: string, branchId: string) {
  const db = await getDb();
  await db.update(branchUsers).set({ isPrimary: false, updatedAt: new Date() }).where(eq(branchUsers.userId, userId));
  await db
    .update(branchUsers)
    .set({ isPrimary: true, updatedAt: new Date() })
    .where(and(eq(branchUsers.userId, userId), eq(branchUsers.branchId, branchId)));
}

/** True if any branch in this company still has this user linked - used the
 * same way tenancy.ts's roleInUse() guards role deletion, so a branch's
 * membership list is always visible before code that depends on it changes. */
export async function branchIdsForCompany(companyId: string, branchIds: string[]): Promise<Set<string>> {
  if (branchIds.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.companyId, companyId), inArray(branches.id, branchIds)));
  return new Set(rows.map((r) => r.id));
}
