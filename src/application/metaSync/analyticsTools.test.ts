// analyticsTools.ts - the ANALYTICS TOOL layer's own tests, same two-tier
// split as crmTools.test.ts:
//   - Validation (no DB required, always run): every exported tool throws
//     CrmToolValidationError before touching the database, same convention
//     as crmTools.ts (these tools reuse its assertValid/validateAuth/
//     validateDateRange directly - see analyticsTools.ts's own imports).
//   - Behavior (real Postgres, describe.skipIf(!process.env.DATABASE_URL)):
//     the actual arithmetic (trend deltas, comparison deltas, conversion
//     rate, anomaly z-scores, team-performance broad-grant fallback) and
//     the composite explain_change fan-out, plus a direct check that
//     detect_anomalies/explain_change actually hit the cache on a second
//     call (via vitest.setup.ts's fake in-memory Redis backing store).
//
// Local fixture helpers below intentionally mirror crmTools.test.ts's own
// (same signatures) rather than src/testSupport/dbFixtures.ts's differently
// -shaped helpers - keeps the two sibling test files trivially comparable.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../infrastructure/db/client";
import { campaigns, companies, leadFollowUps, leads, roles, users } from "../../infrastructure/db/schema";
import { PERMISSIONS } from "../../domain/permissions";
import { dayOffsetRange, todayRange, type DateRange } from "./rutaDateRange";
import { CrmToolValidationError } from "./crmTools";
import {
  computeAnomalies,
  computeTrendStats,
  detect_anomalies,
  explain_change,
  get_campaign_comparison,
  get_conversion_rate,
  get_date_range_aggregation,
  get_source_comparison,
  get_team_performance,
  get_trend,
} from "./analyticsTools";

const TZ = "Asia/Kolkata";

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// ---------------------------------------------------------------------------
// Pure computation helpers - no DB, no auth, just arithmetic.
// ---------------------------------------------------------------------------

describe("computeTrendStats - pure arithmetic", () => {
  it("computes an up/down/flat direction and a percent change, null when the previous count is 0", () => {
    expect(computeTrendStats(15, 10)).toEqual({ currentCount: 15, previousCount: 10, changeCount: 5, changePct: 50, direction: "up" });
    expect(computeTrendStats(5, 10)).toEqual({ currentCount: 5, previousCount: 10, changeCount: -5, changePct: -50, direction: "down" });
    expect(computeTrendStats(10, 10)).toEqual({ currentCount: 10, previousCount: 10, changeCount: 0, changePct: 0, direction: "flat" });
    expect(computeTrendStats(3, 0)).toEqual({ currentCount: 3, previousCount: 0, changeCount: 3, changePct: null, direction: "up" });
  });
});

describe("computeAnomalies - pure arithmetic", () => {
  const mkBuckets = (counts: number[]) => counts.map((count, i) => ({ label: `day ${i}`, startIso: `2026-01-0${i + 1}T00:00:00.000Z`, endIso: `2026-01-0${i + 2}T00:00:00.000Z`, count }));

  it("flags no anomalies with fewer than 4 buckets, regardless of variance", () => {
    expect(computeAnomalies(mkBuckets([1, 100]))).toEqual([]);
    expect(computeAnomalies(mkBuckets([1, 2, 3]))).toEqual([]);
  });

  it("flags no anomalies when every bucket has the same count (zero standard deviation)", () => {
    expect(computeAnomalies(mkBuckets([5, 5, 5, 5, 5]))).toEqual([]);
  });

  it("flags a clear spike against a stable baseline", () => {
    // A single large spike among a stable baseline - separated from the
    // drop case below because a spike and a drop in the SAME small sample
    // inflate the standard deviation enough to mask each other's z-score
    // (an expected property of z-score anomaly detection on tiny samples,
    // not a bug - see computeAnomalies' own "conservative" comment).
    const anomalies = computeAnomalies(mkBuckets([10, 10, 10, 10, 10, 10, 10, 100]));
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.label).toBe("day 7");
    expect(anomalies[0]!.kind).toBe("spike");
    expect(anomalies[0]!.zScore).toBeGreaterThanOrEqual(2);
  });

  it("flags a clear drop against a stable baseline", () => {
    const anomalies = computeAnomalies(mkBuckets([10, 10, 10, 10, 10, 10, 10, 0]));
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.label).toBe("day 7");
    expect(anomalies[0]!.kind).toBe("drop");
    expect(anomalies[0]!.zScore).toBeLessThanOrEqual(-2);
  });
});

// ---------------------------------------------------------------------------
// Validation tier - no DATABASE_URL required.
// ---------------------------------------------------------------------------

describe("analyticsTools - argument validation (no DB required)", () => {
  const today = todayRange(TZ);
  const bad = { tenantId: "", userId: "" };

  it("every range+timezone tool rejects a missing tenantId/userId", async () => {
    await expect(get_date_range_aggregation(bad, { range: today, timezone: TZ })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_trend(bad, { range: today, timezone: TZ })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(detect_anomalies(bad, { range: today, timezone: TZ })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(explain_change(bad, { range: today, timezone: TZ })).rejects.toBeInstanceOf(CrmToolValidationError);
  });

  it("every range-only tool rejects a missing tenantId/userId", async () => {
    await expect(get_campaign_comparison(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_source_comparison(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_conversion_rate(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_team_performance(bad, { range: today })).rejects.toBeInstanceOf(CrmToolValidationError);
  });

  it("get_date_range_aggregation/get_trend/detect_anomalies/explain_change reject a missing/blank timezone", async () => {
    const auth = { tenantId: "t1", userId: "u1" };
    await expect(get_date_range_aggregation(auth, { range: today, timezone: "" })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(get_trend(auth, { range: today, timezone: "" })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(detect_anomalies(auth, { range: today, timezone: "  " })).rejects.toBeInstanceOf(CrmToolValidationError);
    await expect(explain_change(auth, { range: today, timezone: "  " })).rejects.toBeInstanceOf(CrmToolValidationError);
  });

  it("rejects a range where start is not before end, same as crmTools", async () => {
    const backwards: DateRange = { start: today.end, end: today.start, label: "backwards" };
    await expect(get_trend({ tenantId: "t1", userId: "u1" }, { range: backwards, timezone: TZ })).rejects.toBeInstanceOf(CrmToolValidationError);
  });
});

// ---------------------------------------------------------------------------
// Behavior tier - real Postgres.
// ---------------------------------------------------------------------------

async function makeTenant(label: string): Promise<string> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Analytics ${label}`, slug: unique(`an-${label}`), accountType: "individual", timezone: TZ }).returning();
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

async function logFollowUp(tenantId: string, leadOwner: string, createdBy: string, createdAt?: Date): Promise<void> {
  const db = await getDb();
  const [lead] = await db.insert(leads).values({ companyId: tenantId, metaLeadId: unique("lead-for-followup"), metaCreatedAt: new Date(), ownerId: leadOwner }).returning();
  await db.insert(leadFollowUps).values({ companyId: tenantId, leadId: lead!.id, remarks: "note", createdBy, createdAt: createdAt ?? new Date() });
}

describe.skipIf(!process.env.DATABASE_URL)("analyticsTools - behavior (real Postgres)", () => {
  beforeEach(() => {
    // Each test creates its own fresh tenant/users - no shared mutable
    // state between tests, same convention as crmTools.test.ts.
  });

  it("get_date_range_aggregation buckets leads by calendar day and totals them", async () => {
    const tenantId = await makeTenant("agg");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const yesterday = dayOffsetRange(TZ, 1);
    const today = todayRange(TZ);
    const range: DateRange = { start: yesterday.start, end: today.end, label: "the last 2 days" };

    await insertLead(tenantId, { metaCreatedAt: yesterday.start }); // yesterday
    await insertLead(tenantId, { metaCreatedAt: new Date() }); // today
    await insertLead(tenantId, { metaCreatedAt: new Date() }); // today

    const result = await get_date_range_aggregation({ tenantId, userId }, { range, timezone: TZ });
    expect(result.totalCount).toBe(3);
    expect(result.buckets.length).toBeGreaterThanOrEqual(2);
    expect(result.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(3);
  });

  it("get_trend compares the current range to the immediately preceding equivalent range", async () => {
    const tenantId = await makeTenant("trend");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const yesterday = dayOffsetRange(TZ, 1);
    const today = todayRange(TZ);

    await insertLead(tenantId, { metaCreatedAt: yesterday.start }); // previous period: 1
    await insertLead(tenantId, { metaCreatedAt: today.start }); // current period: 2
    await insertLead(tenantId, { metaCreatedAt: today.start });

    const result = await get_trend({ tenantId, userId }, { range: today, timezone: TZ });
    expect(result.stats.currentCount).toBe(2);
    expect(result.stats.previousCount).toBe(1);
    expect(result.stats.direction).toBe("up");
    expect(result.stats.changeCount).toBe(1);
  });

  it("get_campaign_comparison computes deltas including a campaign that disappeared or newly appeared between periods", async () => {
    const tenantId = await makeTenant("cc");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const campaignA = await makeCampaign(tenantId, "Campaign A");
    const campaignB = await makeCampaign(tenantId, "Campaign B");
    const yesterday = dayOffsetRange(TZ, 1);
    const today = todayRange(TZ);

    // Previous period: A=3, B=1.
    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: yesterday.start });
    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: yesterday.start });
    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: yesterday.start });
    await insertLead(tenantId, { crmCampaignId: campaignB, metaCreatedAt: yesterday.start });
    // Current period: A=1 (dropped), B=0 (gone).
    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: today.start });

    const result = await get_campaign_comparison({ tenantId, userId }, { range: today, previousRange: yesterday });
    const a = result.rows.find((r) => r.name === "Campaign A")!;
    const b = result.rows.find((r) => r.name === "Campaign B")!;
    expect(a.currentCount).toBe(1);
    expect(a.previousCount).toBe(3);
    expect(a.changeCount).toBe(-2);
    expect(b.currentCount).toBe(0);
    expect(b.previousCount).toBe(1);
    expect(b.changeCount).toBe(-1);
  });

  it("get_source_comparison computes deltas by source", async () => {
    const tenantId = await makeTenant("sc");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const yesterday = dayOffsetRange(TZ, 1);
    const today = todayRange(TZ);

    await insertLead(tenantId, { source: "website", metaCreatedAt: yesterday.start });
    await insertLead(tenantId, { source: "website", metaCreatedAt: today.start });
    await insertLead(tenantId, { source: "website", metaCreatedAt: today.start });

    const result = await get_source_comparison({ tenantId, userId }, { range: today, previousRange: yesterday });
    const websiteRow = result.rows.find((r) => r.name.toLowerCase().includes("website"))!;
    expect(websiteRow.currentCount).toBe(2);
    expect(websiteRow.previousCount).toBe(1);
    expect(websiteRow.changeCount).toBe(1);
  });

  it("get_conversion_rate is always company-wide (ungated), matching won/qualified counts against the tenant's own stage catalog", async () => {
    const tenantId = await makeTenant("cr");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");

    await insertLead(tenantId, { pipelineStage: "won" });
    await insertLead(tenantId, { pipelineStage: "qualified" });
    await insertLead(tenantId, { pipelineStage: "new" });
    await insertLead(tenantId, { pipelineStage: "new" });

    const result = await get_conversion_rate({ tenantId, userId }, { range: todayRange(TZ) });
    expect(result.scope).toBe("company");
    expect(result.totalCount).toBe(4);
    expect(result.wonCount).toBe(1);
    expect(result.conversionRatePct).toBe(25);
    expect(result.qualifiedCount).toBe(2); // won implies qualified
    expect(result.qualifiedRatePct).toBe(50);
  });

  it("get_team_performance falls back to a personal single-row scope without the broad-query grant, and breaks down per teammate with it", async () => {
    const tenantId = await makeTenant("tp");
    const restrictedRole = await makeRole(tenantId, false);
    const broadRole = await makeRole(tenantId, true);
    const restrictedUser = await makeUser(tenantId, restrictedRole, "Restricted");
    const broadUser = await makeUser(tenantId, broadRole, "Broad");

    await insertLead(tenantId, { ownerId: restrictedUser, pipelineStage: "won" });
    await insertLead(tenantId, { ownerId: restrictedUser, pipelineStage: "new" });
    await insertLead(tenantId, { ownerId: broadUser, pipelineStage: "new" });
    // logFollowUp (see its own comment above) also inserts its own lead
    // (default pipelineStage "new") owned by restrictedUser - so
    // restrictedUser's expected leadCount below is 3, not 2.
    await logFollowUp(tenantId, restrictedUser, restrictedUser);

    const range = todayRange(TZ);
    const restrictedResult = await get_team_performance({ tenantId, userId: restrictedUser }, { range });
    expect(restrictedResult.scope).toBe("self");
    expect(restrictedResult.rows).toHaveLength(1);
    expect(restrictedResult.rows[0]!.leadCount).toBe(3);
    expect(restrictedResult.rows[0]!.wonCount).toBe(1);
    expect(restrictedResult.rows[0]!.conversionRatePct).toBeCloseTo(33.3, 1);
    expect(restrictedResult.rows[0]!.followUpsLogged).toBe(1);

    const broadResult = await get_team_performance({ tenantId, userId: broadUser }, { range });
    expect(broadResult.scope).toBe("company");
    expect(broadResult.rows.find((r) => r.userId === restrictedUser)?.leadCount).toBe(3);
    expect(broadResult.rows.find((r) => r.userId === broadUser)?.leadCount).toBe(1);
  });

  it("detect_anomalies caches its result - a second call with the same arguments returns without needing fresh data to differ", async () => {
    const tenantId = await makeTenant("da");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const range = todayRange(TZ);

    await insertLead(tenantId, { metaCreatedAt: new Date() });
    const first = await detect_anomalies({ tenantId, userId }, { range, timezone: TZ });

    // Insert more leads AFTER the first call - if the second call hits the
    // cache (as it should, same tenant/range/timezone), totalCount-derived
    // fields stay identical to the first call rather than reflecting the
    // new data.
    await insertLead(tenantId, { metaCreatedAt: new Date() });
    await insertLead(tenantId, { metaCreatedAt: new Date() });
    const second = await detect_anomalies({ tenantId, userId }, { range, timezone: TZ });

    expect(second).toEqual(first);
  });

  it("explain_change fans out to trend + campaign/source comparisons and reuses trend's buckets for anomaly detection", async () => {
    const tenantId = await makeTenant("ec");
    const roleId = await makeRole(tenantId, false);
    const userId = await makeUser(tenantId, roleId, "U");
    const campaignA = await makeCampaign(tenantId, "Campaign A");
    const yesterday = dayOffsetRange(TZ, 1);
    const today = todayRange(TZ);

    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: yesterday.start });
    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: today.start });
    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: today.start });
    await insertLead(tenantId, { crmCampaignId: campaignA, metaCreatedAt: today.start });

    const result = await explain_change({ tenantId, userId }, { range: today, timezone: TZ });
    expect(result.stats.currentCount).toBe(3);
    expect(result.stats.previousCount).toBe(1);
    expect(result.stats.direction).toBe("up");
    expect(result.topCampaignShifts.length).toBeGreaterThan(0);
    expect(result.topCampaignShifts[0]!.name).toBe("Campaign A");
  });
});
