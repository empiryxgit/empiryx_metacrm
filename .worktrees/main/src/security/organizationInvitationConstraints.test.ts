// Real-Postgres tests for the tenancy/relationship hardening migration
// (0023_tenancy_relationship_status_created_at_indexes.sql): specifically
// ux_organization_invitations_one_pending_per_agency_email, the new "at
// most one PENDING invitation per (agency, email) pair" guarantee, and its
// friendly-error wiring in generateOnboardingLink (src/application/
// agencyOnboarding.ts). Same real-Postgres, no-mocking convention as every
// other src/security/*.test.ts file.

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateOnboardingLink } from "../application/agencyOnboarding";
import { AuthError } from "../application/auth";
import { makeTenant } from "../testSupport/dbFixtures";
import { getDb } from "../infrastructure/db/client";
import { organizationInvitations } from "../infrastructure/db/schema";
import { revokeInvitation } from "../infrastructure/db/repositories/organizationInvitations";

describe.skipIf(!process.env.DATABASE_URL)("Organization invitations: one PENDING invite per (agency, email)", () => {
  it("generating a second link to the same email while the first is still PENDING is rejected with a friendly AuthError, not a raw DB error", async () => {
    const agency = await makeTenant("invconstraint-agency1", "agency");

    const first = await generateOnboardingLink({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      clientName: "Prospective Client",
      contactEmail: "prospect@example.com",
    });
    expect(first.token).toBeTruthy();

    await expect(
      generateOnboardingLink({
        agencyCompanyId: agency.tenantId,
        actingUserId: agency.userId,
        clientName: "Prospective Client (again)",
        contactEmail: "prospect@example.com",
      }),
    ).rejects.toThrow(AuthError);

    // Exactly one row for this pair, not two.
    const db = await getDb();
    const rows = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.agencyCompanyId, agency.tenantId));
    expect(rows.filter((r) => r.email === "prospect@example.com")).toHaveLength(1);
  });

  it("email comparison is case-insensitive (both generateOnboardingLink and the constraint operate on the lowercased value)", async () => {
    const agency = await makeTenant("invconstraint-agency2", "agency");

    await generateOnboardingLink({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      clientName: "Prospective Client",
      contactEmail: "Mixed.Case@Example.com",
    });

    await expect(
      generateOnboardingLink({
        agencyCompanyId: agency.tenantId,
        actingUserId: agency.userId,
        clientName: "Prospective Client (again)",
        contactEmail: "mixed.case@example.com",
      }),
    ).rejects.toThrow(AuthError);
  });

  it("two DIFFERENT agencies can each have their own PENDING invite to the same email at the same time - the constraint is scoped per agency, not global", async () => {
    const agencyA = await makeTenant("invconstraint-agencyA");
    const agencyB = await makeTenant("invconstraint-agencyB");

    const a = await generateOnboardingLink({
      agencyCompanyId: agencyA.tenantId,
      actingUserId: agencyA.userId,
      clientName: "Shared Prospect",
      contactEmail: "shared@example.com",
    });
    const b = await generateOnboardingLink({
      agencyCompanyId: agencyB.tenantId,
      actingUserId: agencyB.userId,
      clientName: "Shared Prospect",
      contactEmail: "shared@example.com",
    });
    expect(a.token).not.toBe(b.token);
  });

  it("after the first invitation is REVOKED, a new PENDING invitation to the same (agency, email) can be generated", async () => {
    const agency = await makeTenant("invconstraint-agency3", "agency");

    const first = await generateOnboardingLink({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      clientName: "Prospective Client",
      contactEmail: "retry@example.com",
    });

    const db = await getDb();
    const [row] = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.agencyCompanyId, agency.tenantId));
    await revokeInvitation(agency.tenantId, row!.id);
    void first;

    const second = await generateOnboardingLink({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      clientName: "Prospective Client (retry)",
      contactEmail: "retry@example.com",
    });
    expect(second.token).toBeTruthy();

    const rows = await db
      .select()
      .from(organizationInvitations)
      .where(eq(organizationInvitations.agencyCompanyId, agency.tenantId));
    expect(rows).toHaveLength(2); // the REVOKED row plus the new PENDING one - history is preserved, never deleted
    expect(rows.filter((r) => r.status === "PENDING")).toHaveLength(1);
  });
});
