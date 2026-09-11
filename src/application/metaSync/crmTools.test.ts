// crmTools.ts - the CRM TOOL layer's own tests, split into two tiers:
//   - Validation (no DB required, always run): every exported tool throws
//     CrmToolValidationError before touching the database when handed a
//     bad auth context or an invalid date range - see assertValid's own
//     comment in crmTools.ts for why validation always runs FIRST.
//   - Behavior (real Postgres, same describe.skipIf(!process.env.
//     DATABASE_URL) convention as every other *.flow.test.ts / *.test.ts
//     with a DB dependency in this codebase): tenant scoping, the
//     broad-query-grant fallback, and (new, not covered by any earlier
//     test) get_campaign_performance's won/conversion-rate calculation and
//     get_followup_summary's combined logged+pending shape.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../infrastructure/db/client";
import { campaigns, companies, leadFollowUps, leads, roles, users } from "../../infrastructure/db/schema";
import { PERMISSIONS } from "../../domain/permissions";
import { dayOffsetRange, todayRange } from "./rutaDateRange";
import {
  CrmToolValidationError,
  get_campaign_leads,
  get_campaign_performance,
  get_followup_summary,
  get_lead_count,
  get_pipeline_summary,
  get_user_leads,
} from "./crmTools";

const TZ = "Asia/Kolkata";

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// ---------------------------------------------------------------------------
// Validation tier - no DATABASE_URL required. A bad tenantId/userId/range
// must never reach a query - see crmTools.ts's assertValid.
// ---------------------------------------------------------------------------

describe("crmTools - argument validation (no DB required)", () => {
  const today = todayRange(TZ);

  it("get_lead_count rejects a missing tenantId/userId", async () => {
    await expect(get_lead_count({ tenantId: "", userId: "u1" }, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_lead_count({ tenantId: "t1", userId: "" }, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
  });

  it("get_lead_count rejects a range where start is not before end", async () => {
    const backwards = { start: today.end, end: today.start, label: "backwards" };
    try {
      await get_lead_count({ tenantId: "t1", userId: "u1" }, { range: backwards });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CrmToolValidationError);
      expect((err as CrmToolValidationError).errors.range).toMatch(/range\.start must be before range\.end/);
    }
  });

  it("get_lead_count rejects a non-Date range boundary", async () => {
    // @ts-expect-error - deliberately wrong shape, proving the runtime check
    // catches what the type system alone would not for a caller that isn't
    // fully typed (or is passing a value straight out of JSON).
    await expect(get_lead_count({ tenantId: "t1", userId: "u1" }, { range: { start: "2026-01-01", end: today.end, label: "x" } })).rejects.toBeInstanceOf(CrmToolValidationError);
  });

  it("get_campaign_leads / get_campaign_performance / get_user_leads / get_followup_summary all validate the same way", async () => {
    const bad = { tenantId: "", userId: "" };
    await expect(get_campaign_leads(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_campaign_performance(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_user_leads(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_followup_summary(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
  });

  it("get_pipeline_summary rejects a missing tenantId/userId (it takes no range)", async () => {
    await expect(get_pipeline_summary({ tenantId: "", userId: "" })).rejects.toBeInstanceOf(CrmToolValidationError);
  });

  it("CrmToolValidationError carries the tool name and every failing field", async () => {
    try {
      await get_lead_count({ tenantId: "", userId: "" }, { range: { start: today.end, end: today.start, label: "x" } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(CrmToolValidationError);
      const e = err as CrmToolValidationError;
      expect(e.tool).toBe("get_lead_count");
      expect(Object.keys(e.errors).sort()).toEqual(["range", "tenantId", "userId"]);
    }
  });
});

// ---------------------------------------------------------------------------
// Behavior tier - real Postgres.
// ---------------------------------------------------------------------------

async function makeTenant(label: string): Promise<string> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Crm ${label}`, slug: unique(`crm-${label}`), accountType: "individual", timezone: TZ }).returning();
  return company!.id;
}

async function makeRole(tenantId: string, broadGrant: boolean): Promise<string> {
  const db = await getDb();
  const [role] = await db
    .insert(roles)
    .values({ companyId: tenantId, name: broadGrant ? "Broad" : "Restricted", permissions: broadGrant ? [PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY] : [], isSystem: true })
    .returning();
  return role!.id;
}

async function makeUser(tenantId: string, roleId: string, label: string): Promise<string> {
  const db = await getDb();
  const [user] = await db.insert(users).values({ companyId: tenantId, roleId, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: label }).returning();
  return user!.id;
}

async function makeCampaign(tenantId: string, name: string): Promise<string> {
  const db = await getDb();
  const [campaign] = await db.insert(campaigns).values({ companyId: tenantId, name }).returning();
  return campaign!.id;
}

async function insertLead(
  tenantId: string,
  opts: { ownerId?: string | null; source?: string; crmCampaignId?: string | null; campaignName?: string | null; pipelineStage?: string; metaCreatedAt?: Date } = {},
): Promise<void> {
  const db = await getDb();
  await db.insert(leads).values({
    companyId: tenantId,
    metaLeadId: unique("lead"),
    metaCreatedAt: opts.metaCreatedAt ?? new Date(),
    ownerId: opts.ownerId ?? null,
    source: opts.source ?? "meta_lead_ads",
    crmCampaignId: opts.crmCampaignId ?? null,
    campaignName: opts.campaignName ?? null,
    pipelineStage: opts.pipelineStage ?? "new",
  });
}

async function logFollowUp(tenantId: string, leadIdOwner: string, createdBy: string, createdAt?: Date): Promise<void> {
  const db = await getDb();
  const [lead] = await db.insert(leads).values({ companyId: tenantId, metaLeadId: unique("lead-for-followup"), metaCreatedAt: new Date(), ownerId: leadIdOwner }).returning();
  await db.insert(leadFollowUps).values({ companyId: tenantId, leadId: lead!.id, remarks: "note", createdBy, createdAt: createdAt ?? new Date() });
}

describe.skipIf(!process.env.DATABASE_URL)("crmTools - behavior (real Postgres)", () => {
  beforeEach(() => {
    // Each test creates its own fresh tenant/users - no shared mutable
    // state between tests, same convention as rutaAiAssistant.flow.test.ts.
  });

  it("get_lead_count is tenant-scoped and range-scoped", async () => {
    const tenantA = await makeTenant("lc-a");
    const tenantB = await makeTenant("lc-b");
    const roleA = await makeRole(tenantA, false);
    const roleB = await makeRole(tenantB, false);
    const userA = await makeUser(tenantA, roleA, "A");
    const userB = await makeUser(tenantB, roleB, "B");

    await insertLead(tenantA);
    await insertLead(tenantA);
    await insertLead(tenantB); // must never be counted for tenantA

    const today = todayRange(TZ);
    const resultA = await get_lead_count({ tenantId: tenantA, userId: userA }, { range: today });
    const resultB = await get_lead_count({ tenantId: tenantB, userId: userB }, { range: today });
    expect(resultA.count).toBe(2);
    expect(resultB.count).toBe(1);
    expect(resultA.tool).toBe("get_lead_count");
    expect(resultA.scope).toBe("company");
  });

  it("get_campaign_leads breaks down by CRM campaign name, falling back to the raw Meta campaign name, then Unassigned/Other", async () => {
    const tenantId = await makeTenant("cl");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const campaignId = await makeCampaign(tenantId, "Ahmedabad 3BHK");

    await insertLead(tenantId, { crmCampaignId: campaignId });
    await insertLead(tenantId, { crmCampaignId: campaignId });
    await insertLead(tenantId, { campaignName: "Raw Meta Campaign" }); // no CRM campaign link
    await insertLead(tenantId, {}); // neither - Unassigned/Other

    const result = await get_campaign_leads({ tenantId, userId }, { range: todayRange(TZ) });
    expect(result.totalCount).toBe(4);
    const byName = Object.fromEntries(result.campaigns.map((c) => [c.name, c.count]));
    expect(byName["Ahmedabad 3BHK"]).toBe(2);
    expect(byName["Raw Meta Campaign"]).toBe(1);
    expect(byName["Unassigned/Other"]).toBe(1);
  });

  it("get_campaign_performance computes won count + conversion rate per campaign, CRM-native (never a Meta ad-spend/impression metric)", async () => {
    const tenantId = await makeTenant("cp");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const campaignA = await makeCampaign(tenantId, "Campaign A");
    const campaignB = await makeCampaign(tenantId, "Campaign B");

    // Campaign A: 4 leads, 2 won -> 50%.
    await insertLead(tenantId, { crmCampaignId: campaignA, pipelineStage: "won" });
    await insertLead(tenantId, { crmCampaignId: campaignA, pipelineStage: "won" });
    await insertLead(tenantId, { crmCampaignId: campaignA, pipelineStage: "new" });
    await insertLead(tenantId, { crmCampaignId: campaignA, pipelineStage: "contacted" });
    // Campaign B: 1 lead, 0 won -> 0%.
    await insertLead(tenantId, { crmCampaignId: campaignB, pipelineStage: "new" });

    const result = await get_campaign_performance({ tenantId, userId }, { range: todayRange(TZ) });
    const a = result.campaigns.find((c) => c.name === "Campaign A")!;
    const b = result.campaigns.find((c) => c.name === "Campaign B")!;
    expect(a.leadCount).toBe(4);
    expect(a.wonCount).toBe(2);
    expect(a.conversionRatePct).toBe(50);
    expect(b.leadCount).toBe(1);
    expect(b.wonCount).toBe(0);
    expect(b.conversionRatePct).toBe(0);
    // Sorted by lead volume, not conversion rate.
    expect(result.campaigns[0]!.name).toBe("Campaign A");
  });

  it("get_user_leads falls back to a personal, single-entry count without the broad-query grant, and breaks down by teammate with it", async () => {
    const tenantId = await makeTenant("ul");
    const restrictedRole = await makeRole(tenantId, false);
    const broadRole = await makeRole(tenantId, true);
    const restrictedUser = await makeUser(tenantId, restrictedRole, "Restricted");
    const broadUser = await makeUser(tenantId, broadRole, "Broad");

    await insertLead(tenantId, { ownerId: restrictedUser });
    await insertLead(tenantId, { ownerId: restrictedUser });
    await insertLead(tenantId, { ownerId: broadUser });

    const range = todayRange(TZ);
    const restrictedResult = await get_user_leads({ tenantId, userId: restrictedUser }, { range });
    expect(restrictedResult.scope).toBe("self");
    expect(restrictedResult.totalCount).toBe(2);
    expect(restrictedResult.users).toHaveLength(1);
    expect(restrictedResult.users[0]!.userId).toBe(restrictedUser);

    const broadResult = await get_user_leads({ tenantId, userId: broadUser }, { range });
    expect(broadResult.scope).toBe("company");
    expect(broadResult.totalCount).toBe(3);
    expect(broadResult.users.find((u) => u.userId === restrictedUser)?.count).toBe(2);
    expect(broadResult.users.find((u) => u.userId === broadUser)?.count).toBe(1);
  });

  it("get_pipeline_summary is personal-scoped without the broad-query grant, company-wide with it, in the tenant's own stage order", async () => {
    const tenantId = await makeTenant("ps");
    const restrictedRole = await makeRole(tenantId, false);
    const broadRole = await makeRole(tenantId, true);
    const restrictedUser = await makeUser(tenantId, restrictedRole, "Restricted");
    const broadUser = await makeUser(tenantId, broadRole, "Broad");

    await insertLead(tenantId, { ownerId: restrictedUser, pipelineStage: "new" });
    await insertLead(tenantId, { ownerId: restrictedUser, pipelineStage: "won" });
    await insertLead(tenantId, { ownerId: broadUser, pipelineStage: "new" });

    const restrictedResult = await get_pipeline_summary({ tenantId, userId: restrictedUser });
    expect(restrictedResult.scope).toBe("self");
    expect(restrictedResult.totalCount).toBe(2);
    expect(restrictedResult.stages.find((s) => s.key === "won")?.isWon).toBe(true);

    const broadResult = await get_pipeline_summary({ tenantId, userId: broadUser });
    expect(broadResult.scope).toBe("company");
    expect(broadResult.totalCount).toBe(3);
    // General template order: new, contacted, qualified, won, lost.
    expect(broadResult.stages.map((s) => s.key)).toEqual(["new", "contacted", "qualified", "won", "lost"]);
  });

  it("get_followup_summary combines the caller's own logged count with a pending/overdue count scoped by the broad-query grant", async () => {
    const tenantId = await makeTenant("fs");
    const restrictedRole = await makeRole(tenantId, false);
    const broadRole = await makeRole(tenantId, true);
    const restrictedUser = await makeUser(tenantId, restrictedRole, "Restricted");
    const broadUser = await makeUser(tenantId, broadRole, "Broad");
    const yesterday = dayOffsetRange(TZ, 1);

    await logFollowUp(tenantId, restrictedUser, restrictedUser, new Date()); // logged today by restrictedUser
    await logFollowUp(tenantId, broadUser, broadUser, new Date()); // logged today by broadUser - not restrictedUser's own count

    const db = await getDb();
    await db.insert(leads).values({ companyId: tenantId, metaLeadId: unique("overdue-restricted"), metaCreatedAt: new Date(), ownerId: restrictedUser, nextFollowUpAt: yesterday.start });
    await db.insert(leads).values({ companyId: tenantId, metaLeadId: unique("overdue-broad"), metaCreatedAt: new Date(), ownerId: broadUser, nextFollowUpAt: yesterday.start });

    const restrictedResult = await get_followup_summary({ tenantId, userId: restrictedUser }, { range: todayRange(TZ) });
    expect(restrictedResult.loggedCount).toBe(1); // only restrictedUser's own logged follow-up
    expect(restrictedResult.pendingScope).toBe("self");
    expect(restrictedResult.pendingCount).toBe(1); // only restrictedUser's own overdue lead

    const broadResult = await get_followup_summary({ tenantId, userId: broadUser }, { range: todayRange(TZ) });
    expect(broadResult.loggedCount).toBe(1); // only broadUser's own logged follow-up
    expect(broadResult.pendingScope).toBe("company");
    expect(broadResult.pendingCount).toBe(2); // company-wide with the grant
  });
});
