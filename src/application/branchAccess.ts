// The single place that decides which branch(es) an authenticated request
// may read/write. Every API handler that touches a branch-scoped table
// (leads, campaigns, forms, form_submissions) MUST route through
// resolveBranchAccess() for reads and assertBranchAccessible() for any
// client-supplied branchId - never trust a branchId from the query string or
// request body on its own, and never rely on the frontend to have already
// filtered by branch (see the multi-branch spec: "backend must enforce
// company_id + branch_id... do not rely only on frontend filtering").

import type { AuthContext } from "../infrastructure/auth/context";
import { hasPermission } from "../infrastructure/auth/context";
import { PERMISSIONS } from "../domain/permissions";
import { getBranchById } from "../infrastructure/db/repositories/branches";

export type BranchAccess = { scope: "all" } | { scope: "restricted"; branchIds: string[] };

/**
 * "all" (unrestricted, sees every branch's data plus company-wide rows) when
 * the user holds branches.manage - OR when they hold no branch membership at
 * all, which is the exact state of every user in every company that has
 * never created a branch. That second case is deliberate: it is what keeps
 * this feature 100% backward compatible - a company that never adopts
 * branches sees identical behavior to before this feature existed, with zero
 * data migration required.
 *
 * "restricted" (their own branch(es), plus company-wide rows where
 * branchId is null) once a company actually assigns them to specific
 * branch(es).
 */
export function resolveBranchAccess(auth: AuthContext): BranchAccess {
  if (hasPermission(auth, PERMISSIONS.BRANCHES_MANAGE)) return { scope: "all" };
  const branchIds = auth.branchIds ?? [];
  if (branchIds.length === 0) return { scope: "all" };
  return { scope: "restricted", branchIds };
}

export type BranchAssertion =
  | { ok: true; branchId: string | null }
  | { ok: false; status: number; error: string };

/**
 * Validates a client-supplied branchId (from a query param or request body)
 * against BOTH tenant isolation and the caller's own branch access, in one
 * call. `undefined`/empty is always valid and means "company-wide" - it is
 * the caller's job to decide whether that's an acceptable outcome for the
 * operation (e.g. a restricted user creating a company-wide lead is fine;
 * seeing another tenant's branch never is).
 *
 * getBranchById is company-scoped (WHERE company_id = ... AND id = ...), so
 * a branchId belonging to a different company returns null here and this
 * resolves to a 404, not a 403 - never confirming to the caller that the id
 * exists at all under another tenant.
 */
export async function assertBranchAccessible(auth: AuthContext, requestedBranchId: unknown): Promise<BranchAssertion> {
  if (requestedBranchId === undefined || requestedBranchId === null || requestedBranchId === "") {
    return { ok: true, branchId: null };
  }
  if (typeof requestedBranchId !== "string") {
    return { ok: false, status: 400, error: "branchId must be a string." };
  }

  const branch = await getBranchById(auth.companyId, requestedBranchId);
  if (!branch) {
    return { ok: false, status: 404, error: "Branch not found." };
  }

  const access = resolveBranchAccess(auth);
  if (access.scope === "restricted" && !access.branchIds.includes(requestedBranchId)) {
    return { ok: false, status: 403, error: "You do not have access to this branch." };
  }

  return { ok: true, branchId: requestedBranchId };
}

/**
 * Checks a branchId already read back from our own database (e.g. an
 * existing row's own branchId, fetched via a company-scoped query) against
 * the caller's access - no DB round-trip, unlike assertBranchAccessible.
 * Use this to gate read/update/delete of a single row already fetched by
 * id (a campaign, a form, a lead) so a branch-restricted caller can never
 * view or mutate a row that belongs to a branch outside their access, even
 * though tenant isolation (companyId) alone would have let the fetch
 * through. Use assertBranchAccessible instead for a branchId the CLIENT
 * supplied directly (a query param or request body value), which still
 * needs its own tenant-isolation + existence check via getBranchById.
 */
export function canAccessBranch(access: BranchAccess, branchId: string | null): boolean {
  if (access.scope === "all") return true;
  if (branchId === null) return true; // company-wide rows are visible to every branch-restricted caller too
  return access.branchIds.includes(branchId);
}
