// Security/correctness tests for the "Agency Leads" aggregate report (see
// getAgencyLeadsReport in src/application/agency.ts) - the hard requirement
// it was built under: "enforce authorization on every query." Every filter
// (Client/Campaign/Assigned User) is a caller-supplied id that could name
// something outside this agency user's own resolved access; each one must
// be independently rejected (never silently ignored or silently widened)
// when it does. Same real-Postgres, no-mocking convention as
// tenantIsolation.test.ts / agencyClientIsolation.test.ts.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb } from "../infrastructure/db/client";
import { agencyClients, agencyClientAssignments, leads } from "../infrastructure/db/schema";
import { createCampaign } from "../infrastructure/db/repositories/campaigns";
import type { AuthContext } from "../infrastructure/auth/context";
import { getAgencyLeadsReport } from "../application/agency";
import { resolveAgencyClientAccess } from "../application/agencyClientAccess";
import { makeTenant } from "../testSupport/dbFixtures";

function authFor(companyId: string, userId: string, assignedClientIds: string[] = []): AuthContext {
  return { userId, sub: userId, companyId, roleId: randomUUID(), permissions: [], assignedClientIds };
}

async function insertLeadRow(input: {
  companyId: string;
  crmCampaignId?: string | null;
  ownerId?: string | null;
  source?: string;
  pipelineStage?: string;
  createdAt?: Date;
}) {
  const db = await getDb();
  const [row] = await db
    .insert(leads)
    .values({
      companyId: input.companyId,
      crmCampaignId: input.crmCampaignId ?? null,
      ownerId: input.ownerId ?? null,
      source: input.source ?? "website",
      pipelineStage: input.pipelineStage ?? "new",
      metaLeadId: `test_${randomUUID()}`,
      metaCreatedAt: new Date(),
      createdAt: input.createdAt ?? new Date(),
    })
    .returning();
  return row!;
}

describe.skipIf(!process.env.DATABASE_URL)("Security: Agency Leads report authorization", () => {
  it("totals and per-client breakdown only ever include clients the caller is authorized for - a foreign agency's client never appears, even with matching leads in the same database", async () => {
    const agency = await makeTenant("alr-agency1", "agency");
    const otherAgency = await makeTenant("alr-otheragency1", "agency");
    const clientA = await makeTenant("alr-clientA1");
    const clientB = await makeTenant("alr-clientB1");
    const clientForeign = await makeTenant("alr-clientForeign1");
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, status: "active" },
      { agencyCompanyId: otherAgency.tenantId, clientCompanyId: clientForeign.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, userId: agency.userId },
    ]);

    await insertLeadRow({ companyId: clientA.tenantId });
    await insertLeadRow({ companyId: clientA.tenantId });
    await insertLeadRow({ companyId: clientB.tenantId });
    await insertLeadRow({ companyId: clientForeign.tenantId }); // must never be counted or shown

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId, clientB.tenantId]);
    const report = await getAgencyLeadsReport(agency.tenantId, resolveAgencyClientAccess(auth), {});

    expect(report.totalLeads).toBe(3); // 2 (A) + 1 (B), never the foreign client's lead
    const byId = new Map(report.clients.map((c) => [c.id, c.leads]));
    expect(byId.get(clientA.tenantId)).toBe(2);
    expect(byId.get(clientB.tenantId)).toBe(1);
    expect(byId.has(clientForeign.tenantId)).toBe(false);
    expect(report.filters.clients.some((c) => c.id === clientForeign.tenantId)).toBe(false);
  });

  it("Client filter: narrows correctly when authorized; rejected outright when it names a client outside the caller's access", async () => {
    const agency = await makeTenant("alr-agency2", "agency");
    const clientA = await makeTenant("alr-clientA2");
    const clientB = await makeTenant("alr-clientB2");
    const unassignedClient = await makeTenant("alr-clientC2"); // claimed by the SAME agency, but not assigned to this user
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: unassignedClient.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, userId: agency.userId },
    ]);
    await insertLeadRow({ companyId: clientA.tenantId });
    await insertLeadRow({ companyId: clientB.tenantId });
    await insertLeadRow({ companyId: unassignedClient.tenantId });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId, clientB.tenantId]);
    const access = resolveAgencyClientAccess(auth);

    const narrowed = await getAgencyLeadsReport(agency.tenantId, access, { clientId: clientB.tenantId });
    expect(narrowed.totalLeads).toBe(1);
    expect(narrowed.clients).toHaveLength(1);
    expect(narrowed.clients[0]?.id).toBe(clientB.tenantId);
    expect(narrowed.clients[0]?.leads).toBe(1);

    // Same agency, same "claimed" status, but this user has no individual
    // assignment to it - must be rejected exactly like a fully foreign
    // client, not silently allowed just because the AGENCY itself can see it.
    await expect(getAgencyLeadsReport(agency.tenantId, access, { clientId: unassignedClient.tenantId })).rejects.toMatchObject({
      status: 403,
    });
  });

  it("Campaign filter: must belong to an authorized client's own campaigns - a campaign from an inaccessible client is rejected, never silently matched against the wrong tenant's leads", async () => {
    const agency = await makeTenant("alr-agency3", "agency");
    const clientA = await makeTenant("alr-clientA3");
    const clientForeign = await makeTenant("alr-clientForeign3");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId });

    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "A campaign", platform: "facebook", createdBy: clientA.userId });
    const campaignForeign = await createCampaign({ companyId: clientForeign.tenantId, name: "Foreign campaign", platform: "facebook", createdBy: clientForeign.userId });
    await insertLeadRow({ companyId: clientA.tenantId, crmCampaignId: campaignA.id });
    await insertLeadRow({ companyId: clientA.tenantId, crmCampaignId: null });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const access = resolveAgencyClientAccess(auth);

    const filtered = await getAgencyLeadsReport(agency.tenantId, access, { campaignId: campaignA.id });
    expect(filtered.totalLeads).toBe(1);

    await expect(getAgencyLeadsReport(agency.tenantId, access, { campaignId: campaignForeign.id })).rejects.toMatchObject({ status: 403 });
  });

  it("Assigned User filter: must belong to an authorized client's own users - a user from an inaccessible client is rejected", async () => {
    const agency = await makeTenant("alr-agency4", "agency");
    const clientA = await makeTenant("alr-clientA4");
    const clientForeign = await makeTenant("alr-clientForeign4");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId });

    await insertLeadRow({ companyId: clientA.tenantId, ownerId: clientA.userId });
    await insertLeadRow({ companyId: clientA.tenantId, ownerId: null });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const access = resolveAgencyClientAccess(auth);

    const filtered = await getAgencyLeadsReport(agency.tenantId, access, { assignedUserId: clientA.userId });
    expect(filtered.totalLeads).toBe(1);

    await expect(getAgencyLeadsReport(agency.tenantId, access, { assignedUserId: clientForeign.userId })).rejects.toMatchObject({ status: 403 });
  });

  it("Source and Status filters: valid values narrow correctly; unrecognized values are rejected rather than silently ignored", async () => {
    const agency = await makeTenant("alr-agency5", "agency");
    const clientA = await makeTenant("alr-clientA5");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId });

    await insertLeadRow({ companyId: clientA.tenantId, source: "referral", pipelineStage: "won" });
    await insertLeadRow({ companyId: clientA.tenantId, source: "website", pipelineStage: "new" });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const access = resolveAgencyClientAccess(auth);

    const bySource = await getAgencyLeadsReport(agency.tenantId, access, { source: "referral" });
    expect(bySource.totalLeads).toBe(1);
    const byStatus = await getAgencyLeadsReport(agency.tenantId, access, { status: "won" });
    expect(byStatus.totalLeads).toBe(1);

    await expect(getAgencyLeadsReport(agency.tenantId, access, { source: "not_a_real_source" })).rejects.toMatchObject({ status: 400 });
    await expect(getAgencyLeadsReport(agency.tenantId, access, { status: "not_a_real_stage" })).rejects.toMatchObject({ status: 400 });
  });

  it("Date filter: from/to narrows to leads created within the window, inclusive of the named 'to' day", async () => {
    const agency = await makeTenant("alr-agency6", "agency");
    const clientA = await makeTenant("alr-clientA6");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId });

    const inWindow = new Date("2024-06-15T12:00:00Z");
    const onToDay = new Date("2024-06-20T23:00:00Z"); // still within an inclusive "to: 2024-06-20"
    const beforeWindow = new Date("2024-05-01T00:00:00Z");
    const afterWindow = new Date("2024-07-01T00:00:00Z");
    await insertLeadRow({ companyId: clientA.tenantId, createdAt: inWindow });
    await insertLeadRow({ companyId: clientA.tenantId, createdAt: onToDay });
    await insertLeadRow({ companyId: clientA.tenantId, createdAt: beforeWindow });
    await insertLeadRow({ companyId: clientA.tenantId, createdAt: afterWindow });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);
    const access = resolveAgencyClientAccess(auth);

    const report = await getAgencyLeadsReport(agency.tenantId, access, { from: "2024-06-01", to: "2024-06-20" });
    expect(report.totalLeads).toBe(2);
  });
});
