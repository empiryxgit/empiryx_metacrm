// Phase 20 test support - shared fixtures for the integration test suite
// (OAuth/Sync/Webhook/Lead-creation/Security/Failure-recovery). These are
// integration tests: they run against a REAL Postgres (same local-Postgres
// pattern used throughout this project's manual verification - see
// docs/TESTING.md), never a mock DB, so every assertion reflects the
// actual schema/constraints/unique indexes. Every id is suffixed with a
// counter + Date.now() so parallel test files never collide on a shared
// dev/test database; nothing here ever deletes a row afterward (same
// "additive, non-destructive" convention the rest of this codebase
// follows) - a test database is expected to accumulate rows across runs.

import { getDb } from "../infrastructure/db/client";
import { companies, roles, users } from "../infrastructure/db/schema";

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

export interface TestTenant {
  tenantId: string;
  userId: string;
}

/** One fresh company + system role + user, standing in for one real
 * tenant. Two calls in the same test always produce two genuinely
 * different tenants - the backbone of every cross-tenant assertion in
 * this suite. `accountType` defaults to "individual" (the schema default,
 * and every pre-existing call site's actual behavior) - pass "agency" to
 * stand up an agency tenant instead (see agencyClientIsolation.test.ts). */
export async function makeTenant(label = "tenant", accountType: "individual" | "agency" = "individual"): Promise<TestTenant> {
  const db = await getDb();
  const [company] = await db
    .insert(companies)
    .values({ name: `Phase20 ${label}`, slug: unique(`phase20-${label}`), accountType })
    .returning();
  if (!company) throw new Error("makeTenant: company insert returned no row");
  const [role] = await db.insert(roles).values({ companyId: company.id, name: "Admin", permissions: [], isSystem: true }).returning();
  if (!role) throw new Error("makeTenant: role insert returned no row");
  const [user] = await db
    .insert(users)
    .values({ companyId: company.id, roleId: role.id, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: `${label} User` })
    .returning();
  if (!user) throw new Error("makeTenant: user insert returned no row");
  return { tenantId: company.id, userId: user.id };
}

export function uniqueId(label: string): string {
  return unique(label);
}
