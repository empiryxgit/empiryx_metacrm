// Security/correctness tests for the two new agency-facing listing
// endpoints - listAgencyClients (GET /api/agency/clients) and
// getAgencyCampaignsReport (GET /api/agency/campaigns), both in
// src/application/agency.ts. Same real-Postgres, no-mocking convention,
// and the same "a foreign/unassigned client must never leak in" shape of
// assertion, as agencyLeadsReportAuthorization.test.ts (getAgencyLeadsReport
// is these two endpoints' closest sibling; listAgencyClients also shares
// its exact roster-building logic with getAgencyDashboardSummary via
// buildAgencyClientRoster).

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "../infrastructure/db/client";
import { agencyClients, agencyClientAssignments } from "../infrastructure/db/schema";
import { createCampaign } from "../infrastructure/db/repositories/campaigns";
import type { AuthContext } from "../infrastructure/auth/context";
import { getAgencyCampaignsReport, listAgencyClients } from "../application/agency";
import { resolveAgencyClientAccess } from "../application/agencyClientAccess";
import { makeTenant } from "../testSupport/dbFixtures";
import { updateCampaign } from "../infrastructure/db/repositories/campaigns";

function authFor(companyId: string, userId: string, assignedClientIds: string[] = []): AuthContext {
  return { userId, sub: userId, companyId, roleId: randomUUID(), permissions: [], assignedClientIds };
}

describe.skipIf(!process.env.DATABASE_URL)("Security: listAgencyClients (GET /api/agency/clients)", () => {
  it("only returns clients the caller is authorized for - a foreign agency's client, and an unassigned client of the SAME agency, are both excluded", async () => {
    const agency = await makeTenant("aclc-agency1", "agency");
    const otherAgency = await makeTenant("aclc-otheragency1", "agency");
    const clientA = await makeTenant("aclc-clientA1");
    const unassignedClient = await makeTenant("aclc-unassigned1"); // claimed by the SAME agency, but not assigned to this user
    const clientForeign = await makeTenant("aclc-clientForeign1");
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: unassignedClient.tenantId, status: "active" },
      { agencyCompanyId: otherAgency.tenantId, clientCompanyId: clientForeign.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId },
    ]);

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const clients = await listAgencyClients(agency.tenantId, resolveAgencyClientAccess(auth));

    expect(clients.map((c) => c.id)).toEqual([clientA.tenantId]);
    expect(clients.some((c) => c.id === unassignedClient.tenantId)).toBe(false);
    expect(clients.some((c) => c.id === clientForeign.tenantId)).toBe(false);
  });

  it("an Owner/Admin-tier caller (no assignedClientIds restriction) sees every claimed client", async () => {
    const agency = await makeTenant("aclc-agency2", "agency");
    const clientA = await makeTenant("aclc-clientA2");
    const clientB = await makeTenant("aclc-clientB2");
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, status: "active" },
    ]);
    // No agencyClientAssignments rows at all - an Owner/Admin permission
    // profile (AGENCY_CLIENTS_VIEW_ALL) bypasses assignment scoping
    // entirely, same as resolveAgencyClientAccess's own contract.
    const auth = { ...authFor(agency.tenantId, agency.userId), permissions: ["agency_clients.view_all"] };
    const clients = await listAgencyClients(agency.tenantId, resolveAgencyClientAccess(auth));
    expect(clients.map((c) => c.id).sort()).toEqual([clientA.tenantId, clientB.tenantId].sort());
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Security: Agency Campaigns report (getAgencyCampaignsReport)", () => {
  it("only includes campaigns belonging to clients the caller is authorized for", async () => {
    const agency = await makeTenant("acr-agency1", "agency");
    const otherAgency = await makeTenant("acr-otheragency1", "agency");
    const clientA = await makeTenant("acr-clientA1");
    const clientForeign = await makeTenant("acr-clientForeign1");
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: otherAgency.tenantId, clientCompanyId: clientForeign.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId });

    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientA.userId });
    await createCampaign({ companyId: clientForeign.tenantId, name: "Foreign Campaign", platform: "facebook", createdBy: clientForeign.userId });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const report = await getAgencyCampaignsReport(agency.tenantId, resolveAgencyClientAccess(auth), {});

    expect(report.campaigns.map((c) => c.id)).toEqual([campaignA.id]);
    expect(report.campaigns[0]?.clientName).toBe("Phase20 acr-clientA1"); // makeTenant's own naming convention - see dbFixtures.ts
    expect(report.filters.clients.some((c) => c.id === clientForeign.tenantId)).toBe(false);
  });

  it("Client filter: narrows correctly when authorized; rejected outright when it names a client outside the caller's access", async () => {
    const agency = await makeTenant("acr-agency2", "agency");
    const clientA = await makeTenant("acr-clientA2");
    const unassignedClient = await makeTenant("acr-unassigned2");
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: unassignedClient.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId });
    await createCampaign({ companyId: clientA.tenantId, name: "A Campaign", platform: "facebook", createdBy: clientA.userId });
    await createCampaign({ companyId: unassignedClient.tenantId, name: "Unassigned Campaign", platform: "facebook", createdBy: unassignedClient.userId });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const access = resolveAgencyClientAccess(auth);

    const narrowed = await getAgencyCampaignsReport(agency.tenantId, access, { clientId: clientA.tenantId });
    expect(narrowed.campaigns).toHaveLength(1);

    await expect(getAgencyCampaignsReport(agency.tenantId, access, { clientId: unassignedClient.tenantId })).rejects.toMatchObject({ status: 403 });
  });

  it("Status and platform filters: valid values narrow correctly; unrecognized values are rejected rather than silently ignored", async () => {
    const agency = await makeTenant("acr-agency3", "agency");
    const clientA = await makeTenant("acr-clientA3");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId });

    const activeCampaign = await createCampaign({ companyId: clientA.tenantId, name: "Active FB", platform: "facebook", createdBy: clientA.userId });
    await updateCampaign(clientA.tenantId, activeCampaign.id, { status: "active" });
    await createCampaign({ companyId: clientA.tenantId, name: "Draft IG", platform: "instagram", createdBy: clientA.userId });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const access = resolveAgencyClientAccess(auth);

    const byStatus = await getAgencyCampaignsReport(agency.tenantId, access, { status: "active" });
    expect(byStatus.campaigns).toHaveLength(1);
    expect(byStatus.campaigns[0]?.name).toBe("Active FB");

    const byPlatform = await getAgencyCampaignsReport(agency.tenantId, access, { platform: "instagram" });
    expect(byPlatform.campaigns).toHaveLength(1);
    expect(byPlatform.campaigns[0]?.name).toBe("Draft IG");

    await expect(getAgencyCampaignsReport(agency.tenantId, access, { status: "not_a_real_status" })).rejects.toMatchObject({ status: 400 });
    await expect(getAgencyCampaignsReport(agency.tenantId, access, { platform: "not_a_real_platform" })).rejects.toMatchObject({ status: 400 });
  });
});
