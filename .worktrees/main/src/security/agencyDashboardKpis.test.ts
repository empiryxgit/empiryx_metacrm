// Correctness tests for the Agency Dashboard's KPI row and Clients table
// (getAgencyDashboardSummary / buildAgencyClientRoster / getClientMetrics -
// src/application/agency.ts, src/infrastructure/db/repositories/
// organizations.ts). Same real-Postgres, no-mocking convention as every
// other src/security/*.test.ts file.
//
// Three things specifically worth a dedicated regression test here, each
// its own describe block below:
//   - pendingInvitations combines BOTH invitation mechanisms this codebase
//     has (agencyClients.status === "invited", and organizationInvitations
//     rows whose EFFECTIVE status is PENDING) and correctly excludes
//     accepted/revoked/expired ones from either.
//   - leadsThisMonth/leadsToday only count leads inside their own window,
//     not every lead ever received.
//   - conversionRate resolves each client's own "won" stage from THAT
//     client's own effective industry template (see StageDef.isWon in
//     src/domain/industryTemplates.ts) - not a hard-coded
//     pipelineStage === "won" check, which would silently read as 0% for
//     any custom-template client whose win stage uses a different key.

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb } from "../infrastructure/db/client";
import { agencyClients, leads, organizationInvitations, companies, users } from "../infrastructure/db/schema";
import { createCampaign, updateCampaign } from "../infrastructure/db/repositories/campaigns";
import type { AuthContext } from "../infrastructure/auth/context";
import { getAgencyDashboardSummary } from "../application/agency";
import { generateOnboardingLink } from "../application/agencyOnboarding";
import { revokeInvitation } from "../infrastructure/db/repositories/organizationInvitations";
import { resolveAgencyClientAccess } from "../application/agencyClientAccess";
import { makeTenant } from "../testSupport/dbFixtures";

// Owner/Admin-tier caller (no assignedClientIds restriction, per
// resolveAgencyClientAccess's own contract - see
// agencyClientsAndCampaignsReportAuthorization.test.ts for the same
// pattern) - every test below wants the full roster, not a
// per-assignment-narrowed one; access scoping itself is already covered
// by that other test file.
function fullAccessAuthFor(companyId: string, userId: string): AuthContext {
  return { userId, sub: userId, companyId, roleId: randomUUID(), permissions: ["agency_clients.view_all"], assignedClientIds: [] };
}

async function insertLead(companyId: string, opts: { pipelineStage?: string; createdAt?: Date } = {}) {
  const db = await getDb();
  const createdAt = opts.createdAt ?? new Date();
  await db.insert(leads).values({
    companyId,
    metaLeadId: `test_${randomUUID()}`,
    metaCreatedAt: createdAt,
    pipelineStage: opts.pipelineStage ?? "new",
    createdAt,
  });
}

async function claimClient(agencyCompanyId: string, clientCompanyId: string, status: "invited" | "active" = "active") {
  const db = await getDb();
  await db.insert(agencyClients).values({ agencyCompanyId, clientCompanyId, status });
}

describe.skipIf(!process.env.DATABASE_URL)("Agency Dashboard KPIs: pendingInvitations", () => {
  it("counts an unaccepted 'invited' client relationship, but not an already-active one", async () => {
    const agency = await makeTenant("kpi-inv-agency1", "agency");
    const invitedClient = await makeTenant("kpi-inv-invited1");
    const activeClient = await makeTenant("kpi-inv-active1");
    await claimClient(agency.tenantId, invitedClient.tenantId, "invited");
    await claimClient(agency.tenantId, activeClient.tenantId, "active");

    const summary = await getAgencyDashboardSummary(agency.tenantId, resolveAgencyClientAccess(fullAccessAuthFor(agency.tenantId, agency.userId)));
    expect(summary.kpis.pendingInvitations).toBe(1);
  });

  it("counts a live onboarding-link invitation, but not an expired or revoked one", async () => {
    const agency = await makeTenant("kpi-inv-agency2", "agency");

    await generateOnboardingLink({ agencyCompanyId: agency.tenantId, actingUserId: agency.userId, clientName: "Live Prospect", contactEmail: "live@example.com" });
    await generateOnboardingLink({ agencyCompanyId: agency.tenantId, actingUserId: agency.userId, clientName: "Stale Prospect", contactEmail: "stale@example.com" });
    await generateOnboardingLink({ agencyCompanyId: agency.tenantId, actingUserId: agency.userId, clientName: "Revoked Prospect", contactEmail: "revoked@example.com" });

    const db = await getDb();
    // Backdate "Stale Prospect"'s invitation past its expiry - its stored
    // status column stays "PENDING" (nothing sweeps it), but
    // effectiveInvitationStatus (and so this KPI) must read it as expired.
    // Scoped by THIS test's own agencyCompanyId, not just the (literal,
    // reused-every-run-against-the-same-local-Postgres) email - otherwise
    // a re-run of this suite picks up a leftover row from a previous run's
    // now-orphaned agency instead of the one this test just created.
    await db
      .update(organizationInvitations)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(organizationInvitations.email, "stale@example.com"), eq(organizationInvitations.agencyCompanyId, agency.tenantId)));
    const [revokedRow] = await db
      .select()
      .from(organizationInvitations)
      .where(and(eq(organizationInvitations.email, "revoked@example.com"), eq(organizationInvitations.agencyCompanyId, agency.tenantId)));
    await revokeInvitation(agency.tenantId, revokedRow!.id);

    const summary = await getAgencyDashboardSummary(agency.tenantId, resolveAgencyClientAccess(fullAccessAuthFor(agency.tenantId, agency.userId)));
    expect(summary.kpis.pendingInvitations).toBe(1);
  });

  it("combines both invitation mechanisms into one number", async () => {
    const agency = await makeTenant("kpi-inv-agency3", "agency");
    const invitedClient = await makeTenant("kpi-inv-invited3");
    await claimClient(agency.tenantId, invitedClient.tenantId, "invited");
    await generateOnboardingLink({ agencyCompanyId: agency.tenantId, actingUserId: agency.userId, clientName: "Prospect", contactEmail: "combo@example.com" });

    const summary = await getAgencyDashboardSummary(agency.tenantId, resolveAgencyClientAccess(fullAccessAuthFor(agency.tenantId, agency.userId)));
    expect(summary.kpis.pendingInvitations).toBe(2);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Dashboard KPIs: leadsToday / leadsThisMonth", () => {
  it("only counts leads inside each window - not every lead the client has ever received", async () => {
    const agency = await makeTenant("kpi-time-agency1", "agency");
    const client = await makeTenant("kpi-time-client1");
    await claimClient(agency.tenantId, client.tenantId, "active");

    // getClientMetrics computes "today"/"this month" from a plain `new
    // Date()` at call time - pinned to a fixed mid-month instant here so
    // the "this month, but not today" bucket is always well-defined
    // (running this suite for real on the 1st of a month, with no pin,
    // leaves no valid day earlier in the same month to construct).
    const now = new Date(2026, 5, 15, 10, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const earlierToday = new Date(now);
      earlierToday.setHours(0, 30, 0, 0);
      const earlierThisMonth = new Date(now.getFullYear(), now.getMonth(), 1, 12);
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15);

      await insertLead(client.tenantId, { createdAt: now });
      await insertLead(client.tenantId, { createdAt: earlierToday });
      await insertLead(client.tenantId, { createdAt: earlierThisMonth });
      await insertLead(client.tenantId, { createdAt: lastMonth });

      const summary = await getAgencyDashboardSummary(agency.tenantId, resolveAgencyClientAccess(fullAccessAuthFor(agency.tenantId, agency.userId)));
      const row = summary.clients.find((c) => c.id === client.tenantId)!;
      expect(row.leads).toBe(4); // total, unwindowed - this agency/client pair is unique to this test
      expect(summary.kpis.totalLeads).toBe(4);
      expect(summary.kpis.leadsToday).toBe(2); // now + earlierToday
      expect(summary.kpis.leadsThisMonth).toBe(3); // now + earlierToday + earlierThisMonth, not lastMonth
      expect(row.lastActivityAt).toBe(now.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("a client with no leads yet reports null lastActivityAt, not a stale/zero date", async () => {
    const agency = await makeTenant("kpi-time-agency2", "agency");
    const client = await makeTenant("kpi-time-client2");
    await claimClient(agency.tenantId, client.tenantId, "active");

    const summary = await getAgencyDashboardSummary(agency.tenantId, resolveAgencyClientAccess(fullAccessAuthFor(agency.tenantId, agency.userId)));
    const row = summary.clients.find((c) => c.id === client.tenantId)!;
    expect(row.lastActivityAt).toBeNull();
    expect(row.leads).toBe(0);
    expect(row.conversionRate).toBe(0); // never NaN/Infinity on a zero-lead client
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Dashboard KPIs: conversionRate resolves each client's OWN 'won' stage", () => {
  it("a custom-template client whose win stage is not literally 'won' still converts correctly - never silently reads as 0%", async () => {
    const agency = await makeTenant("kpi-conv-agency1", "agency");
    const general = await makeTenant("kpi-conv-general1"); // default "general" template - win stage key IS "won"
    const custom = await makeTenant("kpi-conv-custom1");
    await claimClient(agency.tenantId, general.tenantId, "active");
    await claimClient(agency.tenantId, custom.tenantId, "active");

    // custom's own win stage is deliberately named something other than
    // "won" - the exact case a hard-coded pipelineStage === "won" check
    // would get wrong.
    const db = await getDb();
    await db
      .update(companies)
      .set({
        industryTemplate: "custom",
        customTemplateConfig: {
          name: "Solar Sales",
          pipelineName: "Solar Pipeline",
          stages: [
            { key: "new_lead", label: "New Lead", isInitial: true },
            { key: "deal_closed", label: "Deal Closed", isClosed: true, isWon: true },
          ],
          fields: [],
        },
      })
      .where(eq(companies.id, custom.tenantId));

    // general: 2 won / 4 total = 50%
    await insertLead(general.tenantId, { pipelineStage: "won" });
    await insertLead(general.tenantId, { pipelineStage: "won" });
    await insertLead(general.tenantId, { pipelineStage: "new" });
    await insertLead(general.tenantId, { pipelineStage: "new" });

    // custom: 1 won ("deal_closed") / 4 total = 25% - a "won" literal-key
    // check would find zero matches here and wrongly report 0%.
    await insertLead(custom.tenantId, { pipelineStage: "deal_closed" });
    await insertLead(custom.tenantId, { pipelineStage: "new_lead" });
    await insertLead(custom.tenantId, { pipelineStage: "new_lead" });
    await insertLead(custom.tenantId, { pipelineStage: "new_lead" });

    const summary = await getAgencyDashboardSummary(agency.tenantId, resolveAgencyClientAccess(fullAccessAuthFor(agency.tenantId, agency.userId)));
    const generalRow = summary.clients.find((c) => c.id === general.tenantId)!;
    const customRow = summary.clients.find((c) => c.id === custom.tenantId)!;
    expect(generalRow.conversionRate).toBe(50);
    expect(customRow.conversionRate).toBe(25);

    // Agency-wide: summed from each client's own won/total (3 won / 8
    // total = 37.5%) - NOT an average of 50% and 25% (which would give the
    // wrong answer, 37.5% only coincidentally matching here since both
    // clients happen to have the same lead volume; the implementation
    // must not rely on that).
    expect(summary.kpis.conversionRate).toBe(37.5);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Agency Dashboard Clients table: users / campaigns / status", () => {
  it("reports the client's own user headcount and total (not just active) campaign count", async () => {
    const agency = await makeTenant("kpi-roster-agency1", "agency");
    const client = await makeTenant("kpi-roster-client1"); // makeTenant already creates 1 user
    await claimClient(agency.tenantId, client.tenantId, "active");

    const db = await getDb();
    const [existingUser] = await db.select().from(users).where(eq(users.companyId, client.tenantId));
    await db.insert(users).values({
      companyId: client.tenantId,
      roleId: existingUser!.roleId, // reuse makeTenant's own role - only the headcount matters here
      email: `extra-${randomUUID()}@example.com`,
      passwordHash: "x",
      fullName: "Extra User",
    });

    const active = await createCampaign({ companyId: client.tenantId, name: "Active One", platform: "facebook", createdBy: client.userId });
    await updateCampaign(client.tenantId, active.id, { status: "active" });
    await createCampaign({ companyId: client.tenantId, name: "Draft One", platform: "instagram", createdBy: client.userId });

    const summary = await getAgencyDashboardSummary(agency.tenantId, resolveAgencyClientAccess(fullAccessAuthFor(agency.tenantId, agency.userId)));
    const row = summary.clients.find((c) => c.id === client.tenantId)!;
    expect(row.users).toBe(2); // makeTenant's own user + the extra one
    expect(row.campaigns).toBe(2); // total, regardless of status
    expect(row.activeCampaigns).toBe(1);
  });
});
