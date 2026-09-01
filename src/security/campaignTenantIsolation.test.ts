// Security/correctness tests for "Campaigns must remain organization/client
// scoped... Agency dashboard can aggregate campaign statistics but must not
// merge campaign ownership." Same real-Postgres, no-mocking convention as
// tenantIsolation.test.ts / agencyClientIsolation.test.ts /
// metaIntegrationTenantIsolation.test.ts.
//
// Two identically-named campaigns owned by two different clients is the
// sharpest version of this requirement's own example diagram (Client A's
// Campaign A/B/C vs Client B's Campaign X/Y) - every test below builds
// exactly that shape rather than relying on distinct names to accidentally
// keep results apart.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import handler from "../../api/campaigns/handler";
import { fakeReq, fakeRes } from "../testSupport/httpFixtures";
import { getDb } from "../infrastructure/db/client";
import { metaCampaigns, agencyClients, agencyClientAssignments, leads } from "../infrastructure/db/schema";
import { createCampaign, getCampaign, listCampaigns, listCampaignsForCompanies } from "../infrastructure/db/repositories/campaigns";
import { mapMetaCampaignToCrmCampaign } from "../infrastructure/db/repositories/metaSync";
import { signAccessToken, ACCESS_COOKIE_NAME, CLIENT_CONTEXT_COOKIE_NAME } from "../infrastructure/auth/tokens";
import { PERMISSIONS } from "../domain/permissions";
import { getAgencyLeadsReport } from "../application/agency";
import { resolveAgencyClientAccess } from "../application/agencyClientAccess";
import { makeTenant } from "../testSupport/dbFixtures";

async function insertRawMetaCampaign(tenantId: string, metaCampaignId: string, name: string) {
  const db = await getDb();
  const [row] = await db
    .insert(metaCampaigns)
    .values({ tenantId, metaAdAccountId: null, metaCampaignId, name, status: "active" })
    .returning();
  return row!;
}

async function claimAndAssign(agencyCompanyId: string, clientCompanyId: string, userId: string) {
  const db = await getDb();
  await db.insert(agencyClients).values({ agencyCompanyId, clientCompanyId, status: "active" });
  await db.insert(agencyClientAssignments).values({ agencyCompanyId, clientCompanyId, userId });
}

async function accessCookieFor(companyId: string, userId: string, assignedClientIds: string[] = []): Promise<string> {
  const token = await signAccessToken({
    sub: userId,
    companyId,
    roleId: randomUUID(),
    permissions: [PERMISSIONS.CAMPAIGNS_VIEW, PERMISSIONS.CAMPAIGNS_MANAGE],
    assignedClientIds,
  });
  return `${ACCESS_COOKIE_NAME}=${token}`;
}

function cookieHeader(accessCookie: string, clientContextClientId?: string): string {
  return clientContextClientId ? `${accessCookie}; ${CLIENT_CONTEXT_COOKIE_NAME}=${clientContextClientId}` : accessCookie;
}

async function insertLeadRow(companyId: string, crmCampaignId: string) {
  const db = await getDb();
  await db.insert(leads).values({
    companyId,
    crmCampaignId,
    metaLeadId: `test_${randomUUID()}`,
    metaCreatedAt: new Date(),
  });
}

describe.skipIf(!process.env.DATABASE_URL)("Security: Campaign tenant isolation (client-owned campaigns)", () => {
  it("two clients with an identically-named campaign remain fully separate rows - list/get never blend them", async () => {
    const clientA = await makeTenant("camp-clientA1");
    const clientB = await makeTenant("camp-clientB1");

    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientA.userId });
    const campaignB = await createCampaign({ companyId: clientB.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientB.userId });

    const listA = await listCampaigns(clientA.tenantId);
    expect(listA.map((c) => c.id)).toEqual([campaignA.id]);
    const listB = await listCampaigns(clientB.tenantId);
    expect(listB.map((c) => c.id)).toEqual([campaignB.id]);

    expect(await getCampaign(clientA.tenantId, campaignA.id)).not.toBeNull();
    // Cross-tenant by-id lookup must never resolve, even though the row
    // genuinely exists (just under a different owner).
    expect(await getCampaign(clientB.tenantId, campaignA.id)).toBeNull();
    expect(await getCampaign(clientA.tenantId, campaignB.id)).toBeNull();
  });

  it("mapMetaCampaignToCrmCampaign rejects a cross-tenant target CRM campaign outright - defense in depth, independent of any HTTP-layer pre-check", async () => {
    const clientA = await makeTenant("camp-clientA2");
    const clientB = await makeTenant("camp-clientB2");

    const metaCampaignA = await insertRawMetaCampaign(clientA.tenantId, "raw-meta-2a", "Spring Promo (Meta)");
    const campaignB = await createCampaign({ companyId: clientB.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientB.userId });

    // Called directly (not through the HTTP handler) - proves the
    // repository itself, not just api/campaigns/handler.ts's own
    // pre-check, refuses to merge Client A's Meta campaign onto Client B's
    // CRM campaign.
    const result = await mapMetaCampaignToCrmCampaign(clientA.tenantId, metaCampaignA.id, campaignB.id);
    expect(result).toBeNull();

    const db = await getDb();
    const [unchanged] = await db.select().from(metaCampaigns).where(eq(metaCampaigns.id, metaCampaignA.id));
    expect(unchanged?.crmCampaignId).toBeNull();

    // The legitimate same-tenant mapping still works - this isn't a
    // blanket regression, only the cross-tenant path is refused.
    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientA.userId });
    const mapped = await mapMetaCampaignToCrmCampaign(clientA.tenantId, metaCampaignA.id, campaignA.id);
    expect(mapped?.crmCampaignId).toBe(campaignA.id);
  });

  it("POST /api/campaigns/meta/:id/map: an agency user managing Client A can never map Client A's Meta campaign to Client B's CRM campaign, even though the same agency operator manages both", async () => {
    const agency = await makeTenant("camp-agency3", "agency");
    const clientA = await makeTenant("camp-clientA3");
    const clientB = await makeTenant("camp-clientB3");
    await claimAndAssign(agency.tenantId, clientA.tenantId, agency.userId);
    await claimAndAssign(agency.tenantId, clientB.tenantId, agency.userId);

    const metaCampaignA = await insertRawMetaCampaign(clientA.tenantId, "raw-meta-3a", "Spring Promo (Meta)");
    const campaignB = await createCampaign({ companyId: clientB.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientB.userId });
    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "Other Campaign", platform: "facebook", createdBy: clientA.userId });

    const cookie = cookieHeader(await accessCookieFor(agency.tenantId, agency.userId, [clientA.tenantId, clientB.tenantId]), clientA.tenantId);

    // Cross-tenant attempt, while legitimately "inside" Client A - must be
    // rejected exactly like any other not-found target, never silently
    // linked.
    // handleMapMetaCampaign reads req.body directly (this file, unlike
    // api/webhooks/meta/handler.ts, keeps Vercel's default bodyParser on -
    // no `export const config = { api: { bodyParser: false } } }` here), so
    // the fake request needs an already-parsed `.body`, not a raw byte
    // stream - fakeReq's rawBody/async-iterator is for the other file's
    // handlers.
    const badReq = fakeReq({
      method: "POST",
      query: { resource: "meta-campaigns", metaCampaignId: metaCampaignA.id, sub: "map" },
      headers: { cookie },
    });
    badReq.body = { crmCampaignId: campaignB.id };
    const badRes = fakeRes();
    await handler(badReq, badRes);
    expect(badRes.calls[0]?.status).toBe(404);

    const db = await getDb();
    const [stillUnmapped] = await db.select().from(metaCampaigns).where(eq(metaCampaigns.id, metaCampaignA.id));
    expect(stillUnmapped?.crmCampaignId).toBeNull();

    // The legitimate same-tenant mapping through the same endpoint still
    // succeeds.
    const goodReq = fakeReq({
      method: "POST",
      query: { resource: "meta-campaigns", metaCampaignId: metaCampaignA.id, sub: "map" },
      headers: { cookie },
    });
    goodReq.body = { crmCampaignId: campaignA.id };
    const goodRes = fakeRes();
    await handler(goodReq, goodRes);
    expect(goodRes.calls[0]?.json).toEqual({ mapped: true });
  });

  it("Agency Leads report: two identically-named campaigns across two clients aggregate independently - filtering by one campaign never leaks the other's leads, and both are listed as separate, correctly-attributed filter options", async () => {
    const agency = await makeTenant("camp-agency4", "agency");
    const clientA = await makeTenant("camp-clientA4");
    const clientB = await makeTenant("camp-clientB4");
    await claimAndAssign(agency.tenantId, clientA.tenantId, agency.userId);
    await claimAndAssign(agency.tenantId, clientB.tenantId, agency.userId);

    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientA.userId });
    const campaignB = await createCampaign({ companyId: clientB.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientB.userId });
    await insertLeadRow(clientA.tenantId, campaignA.id);
    await insertLeadRow(clientA.tenantId, campaignA.id);
    await insertLeadRow(clientB.tenantId, campaignB.id);
    await insertLeadRow(clientB.tenantId, campaignB.id);
    await insertLeadRow(clientB.tenantId, campaignB.id);

    const authFor = (assignedClientIds: string[]) => ({
      userId: agency.userId,
      sub: agency.userId,
      companyId: agency.tenantId,
      roleId: randomUUID(),
      permissions: [],
      assignedClientIds,
    });
    const access = resolveAgencyClientAccess(authFor([clientA.tenantId, clientB.tenantId]));

    // Two same-named campaigns show up as two DISTINCT filter options, each
    // correctly tagged with its own owning client - never collapsed into
    // one shared "Spring Promo" entry.
    const unfiltered = await getAgencyLeadsReport(agency.tenantId, access, {});
    expect(unfiltered.totalLeads).toBe(5);
    const campaignOptions = unfiltered.filters.campaigns.filter((c) => c.id === campaignA.id || c.id === campaignB.id);
    expect(campaignOptions).toHaveLength(2);
    expect(campaignOptions.find((c) => c.id === campaignA.id)?.clientId).toBe(clientA.tenantId);
    expect(campaignOptions.find((c) => c.id === campaignB.id)?.clientId).toBe(clientB.tenantId);

    // Filtering by Client A's campaign never leaks Client B's identically
    // named campaign's leads into the total.
    const filteredA = await getAgencyLeadsReport(agency.tenantId, access, { campaignId: campaignA.id });
    expect(filteredA.totalLeads).toBe(2);
    const filteredB = await getAgencyLeadsReport(agency.tenantId, access, { campaignId: campaignB.id });
    expect(filteredB.totalLeads).toBe(3);
  });

  it("listCampaignsForCompanies (agency-wide aggregation) tags every campaign with its own real owning company - it aggregates rows, it never invents a shared owner", async () => {
    const clientA = await makeTenant("camp-clientA5");
    const clientB = await makeTenant("camp-clientB5");
    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientA.userId });
    const campaignB = await createCampaign({ companyId: clientB.tenantId, name: "Spring Promo", platform: "facebook", createdBy: clientB.userId });

    const rows = await listCampaignsForCompanies([clientA.tenantId, clientB.tenantId]);
    const byId = new Map(rows.map((r) => [r.id, r.companyId]));
    expect(byId.get(campaignA.id)).toBe(clientA.tenantId);
    expect(byId.get(campaignB.id)).toBe(clientB.tenantId);
    expect(byId.get(campaignA.id)).not.toBe(byId.get(campaignB.id));
  });
});
