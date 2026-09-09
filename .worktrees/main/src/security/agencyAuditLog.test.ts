// Correctness tests for the agency/client access audit trail
// (recordAgencyAuditEvent / getAgencyAuditLog - src/application/
// agencyAuditLog.ts, src/infrastructure/db/repositories/agencyAuditLog.ts)
// and its call sites across src/application/agency.ts, agencyOnboarding.ts,
// and auth.ts. Same real-Postgres, no-mocking convention as every other
// src/security/*.test.ts file.
//
// What's specifically worth a dedicated regression test here:
//   - Each of the 11 fixed events actually fires from its real call site,
//     with the right agencyUserId/clientCompanyId per this feature's
//     documented actor-vs-subject rule (see agencyAuditLog.ts's header
//     comment).
//   - agencyUserId is correctly null for the one case where the actor is a
//     client-side user, not an agency one (INVITATION_ACCEPTED / the decline
//     path's CLIENT_REMOVED).
//   - A transition back to "active" (reactivation) logs nothing - only the
//     exact 11 named events are ever written, never an invented 12th.
//   - The hard, explicit user constraint - "Do not log passwords, tokens or
//     secrets" - actually holds: a temporary password/raw onboarding token
//     generated during a logged action never appears in any audit row's
//     `detail`.

import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../infrastructure/db/client";
import { agencyClients, users } from "../infrastructure/db/schema";
import { getAgencyAuditLog } from "../application/agencyAuditLog";
import { addClientOrganization, inviteExistingClient, respondToAgencyInvite, setClientRelationshipStatus } from "../application/agency";
import { completeAgencyOnboarding, generateOnboardingLink } from "../application/agencyOnboarding";
import { registerCompanyAndOwner } from "../application/auth";
import { makeTenant, uniqueId } from "../testSupport/dbFixtures";

async function auditRowsFor(agencyCompanyId: string) {
  return getAgencyAuditLog(agencyCompanyId, { limit: 500 });
}

async function emailForUser(userId: string): Promise<string> {
  const db = await getDb();
  const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return row!.email;
}

describe.skipIf(!process.env.DATABASE_URL)("Agency Audit Log: CLIENT_CREATED / CLIENT_ACCESS_GRANTED (Add Client)", () => {
  it("logs CLIENT_CREATED and CLIENT_ACCESS_GRANTED with the acting agency user as agencyUserId", async () => {
    const agency = await makeTenant("audit-add-agency", "agency");
    const ownerEmail = `${uniqueId("audit-add-owner")}@example.com`;

    const result = await addClientOrganization({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      companyName: "Audit Add Client Co",
      ownerName: "Owner Name",
      ownerEmail,
    });

    const rows = await auditRowsFor(agency.tenantId);
    const created = rows.find((r) => r.action === "CLIENT_CREATED" && r.clientCompanyId === result.company.id);
    const granted = rows.find((r) => r.action === "CLIENT_ACCESS_GRANTED" && r.clientCompanyId === result.company.id);

    expect(created).toBeTruthy();
    expect(created!.agencyUserId).toBe(agency.userId);
    expect(granted).toBeTruthy();
    expect(granted!.agencyUserId).toBe(agency.userId);

    // "Do not log passwords, tokens or secrets" - the generated temporary
    // password must never appear in any audit row for this action.
    for (const row of rows) {
      expect(row.detail ?? "").not.toContain(result.temporaryPassword);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Audit Log: CLIENT_INVITED (Invite Client, already-registered company)", () => {
  it("logs CLIENT_INVITED with the acting agency user as agencyUserId and the client as clientCompanyId", async () => {
    const agency = await makeTenant("audit-invite-agency", "agency");
    const client = await makeTenant("audit-invite-client");
    const clientOwnerEmail = await emailForUser(client.userId);

    await inviteExistingClient({ agencyCompanyId: agency.tenantId, actingUserId: agency.userId, ownerEmail: clientOwnerEmail });

    const rows = await auditRowsFor(agency.tenantId);
    const invited = rows.find((r) => r.action === "CLIENT_INVITED" && r.clientCompanyId === client.tenantId);
    expect(invited).toBeTruthy();
    expect(invited!.agencyUserId).toBe(agency.userId);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Audit Log: INVITATION_ACCEPTED / CLIENT_REMOVED (client responds to invite)", () => {
  it("accept logs INVITATION_ACCEPTED with agencyUserId null - the actor is the client's own user, not an agency user", async () => {
    const agency = await makeTenant("audit-respond-agency1", "agency");
    const client = await makeTenant("audit-respond-client1");
    const clientOwnerEmail = await emailForUser(client.userId);
    await inviteExistingClient({ agencyCompanyId: agency.tenantId, actingUserId: agency.userId, ownerEmail: clientOwnerEmail });

    await respondToAgencyInvite({
      companyId: client.tenantId,
      agencyCompanyId: agency.tenantId,
      accept: true,
      actingClientUserId: client.userId,
    });

    const rows = await auditRowsFor(agency.tenantId);
    const accepted = rows.find((r) => r.action === "INVITATION_ACCEPTED" && r.clientCompanyId === client.tenantId);
    expect(accepted).toBeTruthy();
    expect(accepted!.agencyUserId).toBeNull();
    expect(accepted!.detail).toContain(client.userId);
  });

  it("decline logs CLIENT_REMOVED, also with agencyUserId null", async () => {
    const agency = await makeTenant("audit-respond-agency2", "agency");
    const client = await makeTenant("audit-respond-client2");
    const clientOwnerEmail = await emailForUser(client.userId);
    await inviteExistingClient({ agencyCompanyId: agency.tenantId, actingUserId: agency.userId, ownerEmail: clientOwnerEmail });

    await respondToAgencyInvite({
      companyId: client.tenantId,
      agencyCompanyId: agency.tenantId,
      accept: false,
      actingClientUserId: client.userId,
    });

    const rows = await auditRowsFor(agency.tenantId);
    const removed = rows.find((r) => r.action === "CLIENT_REMOVED" && r.clientCompanyId === client.tenantId);
    expect(removed).toBeTruthy();
    expect(removed!.agencyUserId).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Audit Log: CLIENT_SUSPENDED / CLIENT_REMOVED (relationship status changes)", () => {
  it("logs CLIENT_SUSPENDED and CLIENT_REMOVED, but logs nothing for a reactivation back to active", async () => {
    const agency = await makeTenant("audit-status-agency", "agency");
    const client = await makeTenant("audit-status-client");
    const db = await getDb();
    await db.insert(agencyClients).values({
      agencyCompanyId: agency.tenantId,
      clientCompanyId: client.tenantId,
      status: "active",
    });

    await setClientRelationshipStatus(agency.tenantId, client.tenantId, "suspended", agency.userId);
    await setClientRelationshipStatus(agency.tenantId, client.tenantId, "active", agency.userId); // reactivation - must log nothing
    await setClientRelationshipStatus(agency.tenantId, client.tenantId, "removed", agency.userId);

    const rows = await auditRowsFor(agency.tenantId);
    const forClient = rows.filter((r) => r.clientCompanyId === client.tenantId);
    const actions = forClient.map((r) => r.action).sort();
    expect(actions).toEqual(["CLIENT_REMOVED", "CLIENT_SUSPENDED"]); // no third row for the reactivation
    for (const row of forClient) {
      expect(row.agencyUserId).toBe(agency.userId);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Audit Log: AGENCY_CREATED (registration)", () => {
  it("logs AGENCY_CREATED for a new agency account, but nothing for an ordinary individual account", async () => {
    const agencyEmail = `${uniqueId("audit-register-agency")}@example.com`;
    const agencyResult = await registerCompanyAndOwner({
      companyName: "Audit Register Agency Co",
      fullName: "Agency Owner",
      email: agencyEmail,
      password: "a-very-long-password-123",
      accountType: "agency",
      phoneNumber: "+15550000000",
    });

    const agencyRows = await auditRowsFor(agencyResult.company.id);
    const created = agencyRows.find((r) => r.action === "AGENCY_CREATED");
    expect(created).toBeTruthy();
    expect(created!.agencyUserId).toBe(agencyResult.user.id);
    expect(created!.clientCompanyId).toBeNull();

    const individualEmail = `${uniqueId("audit-register-individual")}@example.com`;
    const individualResult = await registerCompanyAndOwner({
      companyName: "Audit Register Individual Co",
      fullName: "Individual Owner",
      email: individualEmail,
      password: "a-very-long-password-123",
      accountType: "individual",
      phoneNumber: "+15550000001",
    });
    const individualRows = await auditRowsFor(individualResult.company.id);
    expect(individualRows.find((r) => r.action === "AGENCY_CREATED")).toBeUndefined();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Audit Log: CLIENT_INVITED / INVITATION_ACCEPTED / CLIENT_CREATED (onboarding link)", () => {
  it("logs CLIENT_INVITED (link generated, no client yet) then INVITATION_ACCEPTED + CLIENT_CREATED + CLIENT_ACCESS_GRANTED on redemption, with no password/token leaked into any detail", async () => {
    const agency = await makeTenant("audit-onboard-agency", "agency");
    const contactEmail = `${uniqueId("audit-onboard-contact")}@example.com`;

    const link = await generateOnboardingLink({
      agencyCompanyId: agency.tenantId,
      actingUserId: agency.userId,
      clientName: "Audit Onboard Prospect",
      contactEmail,
    });

    const afterGenerate = await auditRowsFor(agency.tenantId);
    const invited = afterGenerate.find((r) => r.action === "CLIENT_INVITED" && r.clientCompanyId === null && (r.detail ?? "").includes(contactEmail));
    expect(invited).toBeTruthy();
    expect(invited!.agencyUserId).toBe(agency.userId);

    const password = "a-very-long-password-456";
    const completion = await completeAgencyOnboarding({
      token: link.token,
      companyName: "Audit Onboard Client Co",
      ownerName: "Onboard Owner",
      ownerEmail: `${uniqueId("audit-onboard-owner")}@example.com`,
      phoneNumber: "+15550000002",
      password,
    });

    const rows = await auditRowsFor(agency.tenantId);
    const accepted = rows.find((r) => r.action === "INVITATION_ACCEPTED" && r.clientCompanyId === completion.company.id);
    const created = rows.find((r) => r.action === "CLIENT_CREATED" && r.clientCompanyId === completion.company.id);
    const granted = rows.find((r) => r.action === "CLIENT_ACCESS_GRANTED" && r.clientCompanyId === completion.company.id);

    expect(accepted).toBeTruthy();
    expect(accepted!.agencyUserId).toBeNull(); // actor is the client's new owner, not an agency user
    expect(created).toBeTruthy();
    expect(created!.agencyUserId).toBe(agency.userId); // the inviting agency user
    expect(granted).toBeTruthy();
    expect(granted!.agencyUserId).toBe(agency.userId);

    // "Do not log passwords, tokens or secrets" - neither the raw onboarding
    // token nor the client owner's chosen password may ever appear in any
    // audit row for this agency.
    for (const row of rows) {
      const detail = row.detail ?? "";
      expect(detail).not.toContain(link.token);
      expect(detail).not.toContain(password);
    }
  });
});
