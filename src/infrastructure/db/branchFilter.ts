// Turns a BranchAccess (src/application/branchAccess.ts) into a Drizzle SQL
// condition for a branch_id column. Shared by every repository query that
// lists branch-scoped rows (leads, campaigns, forms) so "restricted" access
// is applied identically everywhere - one bug here would otherwise have to
// be independently avoided in every repository file.

import { inArray, isNull, or, type SQL, type Column } from "drizzle-orm";
import type { BranchAccess } from "../../application/branchAccess";

/**
 * Returns undefined for "all" (no extra condition - caller adds nothing to
 * its AND(...) list). For "restricted", returns
 * `branch_id IS NULL OR branch_id IN (...)` - a restricted user still sees
 * every company-wide row (branchId null), only branch-specific rows outside
 * their own branch(es) are excluded.
 */
export function branchAccessCondition(branchIdColumn: Column, access: BranchAccess): SQL | undefined {
  if (access.scope === "all") return undefined;
  if (access.branchIds.length === 0) return isNull(branchIdColumn);
  return or(isNull(branchIdColumn), inArray(branchIdColumn, access.branchIds));
}
