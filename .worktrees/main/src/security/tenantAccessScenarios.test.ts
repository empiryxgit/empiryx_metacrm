// Backend enforcement tests for the 8 tenant-isolation scenarios named in
// the "Agency/client access control" security review request. Every
// assertion here exercises a real application-layer function (or, where the
// review targets a check that previously lived ONLY inside an API handler -
// see Scenario 4 - a newly-extracted, independently-testable guard) against
// real Postgres. Nothing here goes through the frontend: these are exactly
// the checks a request hits regardless of what any client-side code does or
// doesn't enforce, per "Never rely on frontend restrictions for tenant
// security."
//
// Scenario -> code path map (see each `it()` block for the assertion):
//   1. Agency A accesses Client A                  -> getClientDetail (agency.ts): resolves
//   2. Agency A attempts Client B (other agency)    -> getClientDetail: rejects 404
//   3. Client A attempts to access Client B         -> tenant-scoped repository reads/writes
//                                                       (leads/campaigns), scoped by companyId
//                                                       taken from the session - never by a
//                                                       client-supplied id. See also the more
//                                                       exhaustive src/security/tenantIsolation.test.ts.
//   4. Client user attempts agency dashboard        -> assertAgencyAccountType (agencyClientAccess.ts)
//   5. Agency user attempts an unassigned client     -> getClientDetail + canAccessClient: rejects 404
//   6. Expired onboarding link                      -> completeAgencyOnboarding: rejects 410
//   7. Used onboarding link                         -> completeAgencyOnboarding: rejects 410
//   8. User manipulates client ID in API             -> getClientDetail / getAgencyCampaignsReport:
//                                                       rejects regardless of whether the manipulated
//                                                       id belongs to a real, foreign, or nonexistent client
//
// Same real-Postgres, no-mocking convention as every other src/security/*.test.ts file.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../infrastructure/db/client";
import { agencyClients, agencyClientAssignments, organizationInvitations, leads } from "../infrastructure/db/schema";
import { createCampaign } from "../infrastructure/db/repositories/campaigns";
import { updateLeadPipelineStage, insertLead, saveRawEvent } from "../infrastructure/db/repositories";
import { LeadPlatform } from "../domain/types";
import type { AuthContext } from "../infrastructure/auth/context";
import { getClientDetail, getAgencyCampaignsReport } from "../application/agency";
import { resolveAgencyClientAccess, assertAgencyAccountType } from "../application/agencyClientAccess";
import { generateOnboardingLink, completeAgencyOnboarding } from "../application/agencyOnboarding";
import { AuthError } from "../application/auth";
import { makeTenant, uniqueId } from "../testSupport/dbFixtures";

function authFor(companyId: string, userId: string, assignedClientIds: string[] = [], permissions: string[] = []): AuthContext {
  return { userId, sub: userId, companyId, roleId: randomUUID(), permissions, assignedClientIds };
}

describe.skipIf(!process.env.DATABASE_URL)("Tenant access control scenarios", () => {
  it("Scenario 1: Agency A accesses Client A -> SUCCESS", async () => {
    const agencyA = await makeTenant("scn1-agencyA", "agency");
    const clientA = await makeTenant("scn1-clientA");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agencyA.tenantId, clientCompanyId: clientA.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agencyA.tenantId, clientCompanyId: clientA.tenantId, userId: agencyA.userId });

    const access = resolveAgencyClientAccess(authFor(agencyA.tenantId, agencyA.userId, [clientA.tenantId]));
    const detail = await getClientDetail(agencyA.tenantId, clientA.tenantId, access);

    expect(detail.company.id).toBe(clientA.tenantId); // SUCCESS - no throw, correct client returned
  });

  it("Scenario 2: Agency A attempts Client B belonging to another agency -> DENIED", async () => {
    const agencyA = await makeTenant("scn2-agencyA", "agency");
    const agencyB = await makeTenant("scn2-agencyB", "agency");
    const clientB = await makeTenant("scn2-clientB");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agencyB.tenantId, clientCompanyId: clientB.tenantId, status: "active" });

    // Agency A has an unrestricted (Owner-tier) access profile - the denial
    // must come from the CROSS-AGENCY ownership check, not from assignment
    // scoping, since agencyA has no claim on this client at all.
    const access = resolveAgencyClientAccess(authFor(agencyA.tenantId, agencyA.userId, [], ["agency_clients.view_all"]));

    await expect(getClientDetail(agencyA.tenantId, clientB.tenantId, access)).rejects.toMatchObject({ status: 404 }); // DENIED
  });

  it("Scenario 3: Client A attempts to access Client B -> DENIED", async () => {
    const clientA = await makeTenant("scn3-clientA");
    const clientB = await makeTenant("scn3-clientB");

    // Leads: the most sensitive per-tenant record. Client B's own lead,
    // targeted by Client A's session-scoped companyId.
    const campaignB = await createCampaign({ companyId: clientB.tenantId, name: "B's campaign", platform: "facebook", createdBy: clientB.userId });
    const rawEventB = await saveRawEvent({
      companyId: clientB.tenantId,
      campaignId: campaignB.id,
      objectType: "page",
      rawPayload: {},
      signatureHeader: null,
      metaLeadId: `meta_lead_b_${randomUUID()}`,
      pageId: "PAGE_B1",
      formId: "form_b1",
    });
    const leadB = await insertLead({
      companyId: clientB.tenantId,
      branchId: null,
      crmCampaignId: campaignB.id,
      metaLeadId: `meta_lead_b_${randomUUID()}`,
      platform: LeadPlatform.Facebook,
      pageId: "PAGE_B1",
      formId: "form_b1",
      formName: "B Form",
      customFields: {},
      formResponses: {},
      metaCreatedAt: new Date(),
      rawEventId: rawEventB.id,
    });
    if (leadB.outcome !== "inserted") throw new Error("expected a fresh lead insert");

    // Every mutation this app exposes is scoped by the CALLER's own
    // companyId (never a client-supplied one) - so "Client A attempts
    // Client B" means: the same lead id, addressed under Client A's own
    // tenant scope, must affect nothing.
    expect(await updateLeadPipelineStage(clientA.tenantId, leadB.id, "contacted")).toBe(false); // DENIED (no-op)

    const db = await getDb();
    const [row] = await db.select({ pipelineStage: leads.pipelineStage, companyId: leads.companyId }).from(leads).where(eq(leads.id, leadB.id));
    expect(row?.pipelineStage).toBe("new"); // untouched
    expect(row?.companyId).toBe(clientB.tenantId); // still Client B's, never reassigned
  });

  it("Scenario 4: Client user attempts agency dashboard -> DENIED", async () => {
    // assertAgencyAccountType is the exact guard handleAgencyResource
    // (api/admin/users/handler.ts) runs before dispatching to ANY
    // agency-dashboard action, for every authenticated request regardless
    // of that user's own permissions.
    expect(() => assertAgencyAccountType("individual")).toThrow(AuthError); // DENIED
    let caught: unknown;
    try {
      assertAgencyAccountType("individual");
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 403 });

    // Control: an actual agency account is never blocked by this same gate.
    expect(() => assertAgencyAccountType("agency")).not.toThrow();
  });

  it("Scenario 5: Agency user attempts an unassigned client -> DENIED", async () => {
    const agency = await makeTenant("scn5-agency", "agency");
    const assignedClient = await makeTenant("scn5-assigned");
    const unassignedClient = await makeTenant("scn5-unassigned"); // claimed by the SAME agency, just not assigned to this user
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: assignedClient.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: unassignedClient.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: assignedClient.tenantId, userId: agency.userId });

    // Assignment-scoped caller (Manager/User tier - no agency_clients.view_all)
    const access = resolveAgencyClientAccess(authFor(agency.tenantId, agency.userId, [assignedClient.tenantId]));

    await expect(getClientDetail(agency.tenantId, unassignedClient.tenantId, access)).rejects.toMatchObject({ status: 404 }); // DENIED
    // Control: the assigned client is still reachable by the same caller.
    await expect(getClientDetail(agency.tenantId, assignedClient.tenantId, access)).resolves.toMatchObject({ company: { id: assignedClient.tenantId } });
  });

  it("Scenario 6: Expired onboarding link -> INVALID / EXPIRED", async () => {
    const agency = await makeTenant("scn6-agency", "agency");
    const link = await generateOnboardingLink({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      clientName: "Scenario 6 Prospect",
      contactEmail: `${uniqueId("scn6")}@example.com`,
    });

    // Backdate its expiry - simulates time passing without needing to wait
    // for the real TTL.
    const db = await getDb();
    await db
      .update(organizationInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(organizationInvitations.agencyCompanyId, agency.tenantId));

    await expect(
      completeAgencyOnboarding({
        token: link.token,
        companyName: "Scenario 6 Co",
        ownerName: "Owner",
        ownerEmail: `${uniqueId("scn6-owner")}@example.com`,
        phoneNumber: "+15550001111",
        password: "a-very-long-password-000",
      }),
    ).rejects.toMatchObject({ status: 410 }); // INVALID / EXPIRED
  });

  it("Scenario 7: Used onboarding link -> INVALID / ALREADY USED", async () => {
    const agency = await makeTenant("scn7-agency", "agency");
    const link = await generateOnboardingLink({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      clientName: "Scenario 7 Prospect",
      contactEmail: `${uniqueId("scn7")}@example.com`,
    });

    // First redemption succeeds.
    const first = await completeAgencyOnboarding({
      token: link.token,
      companyName: "Scenario 7 Co",
      ownerName: "Owner",
      ownerEmail: `${uniqueId("scn7-owner1")}@example.com`,
      phoneNumber: "+15550002222",
      password: "a-very-long-password-111",
    });
    expect(first.company.id).toBeTruthy();

    // Replaying the SAME token a second time must be rejected, even with a
    // different email - the token itself is spent, atomically, on first use.
    await expect(
      completeAgencyOnboarding({
        token: link.token,
        companyName: "Scenario 7 Co (retry)",
        ownerName: "Owner",
        ownerEmail: `${uniqueId("scn7-owner2")}@example.com`,
        phoneNumber: "+15550003333",
        password: "a-very-long-password-222",
      }),
    ).rejects.toMatchObject({ status: 410 }); // INVALID / ALREADY USED
  });

  it("Scenario 8: User manipulates client ID in API -> DENIED", async () => {
    const agency = await makeTenant("scn8-agency", "agency");
    const ownClient = await makeTenant("scn8-ownclient");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agency.tenantId, clientCompanyId: ownClient.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: ownClient.tenantId, userId: agency.userId });
    const access = resolveAgencyClientAccess(authFor(agency.tenantId, agency.userId, [ownClient.tenantId]));

    // A clientId that simply does not exist anywhere - the crudest form of
    // "manipulate the id in the request" - must be denied identically to a
    // real foreign client, never distinguished (no existence leak).
    const madeUpClientId = randomUUID();
    await expect(getClientDetail(agency.tenantId, madeUpClientId, access)).rejects.toMatchObject({ status: 404 }); // DENIED

    // Same denial through the OTHER agency-facing read endpoint that takes
    // a client id straight from request filters (?clientId=...).
    await expect(getAgencyCampaignsReport(agency.tenantId, access, { clientId: madeUpClientId })).rejects.toMatchObject({ status: 403 }); // DENIED

    // Control: the caller's own legitimately-assigned client is unaffected.
    await expect(getClientDetail(agency.tenantId, ownClient.tenantId, access)).resolves.toMatchObject({ company: { id: ownClient.tenantId } });
  });
});
