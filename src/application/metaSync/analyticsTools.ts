// The ANALYTICS TOOL layer of the RUTA pipeline - deterministic business
// metrics, one level up from crmTools.ts's per-entity CRM tools:
//
//   User question -> intent -> ANALYTICS TOOL -> aggregated metrics -> LLM
//   explanation
//
// Every function exported here computes its numbers ENTIRELY in
// TypeScript/SQL - trend deltas, percent changes, z-scores, comparisons -
// before anything is handed to an AI provider. The AI provider (see
// rutaReplyComposer.ts's composeReply, invoked by rutaTools.ts exactly the
// same way it already is for the six named CRM tools) is used ONLY to
// phrase a natural-language explanation of numbers already computed here -
// it never calculates a rate, a delta, a z-score, or any other business
// metric itself, and every reply still falls back to a deterministic,
// AI-free text if no provider is configured or composition fails. "Do not
// let the LLM calculate important business metrics when backend
// calculations are possible" holds by construction, the same way
// crmTools.ts's file header makes "LLM must never directly query DB" hold
// by construction one layer down.
//
// This file is built ENTIRELY on top of crmTools.ts's existing primitives
// (get_campaign_leads/get_source_leads, hasBroadGrant, companyStages, the
// validateAuth/validateDateRange/assertValid/CrmToolValidationError
// convention, the RangeOut/rangeOut date-range JSON encoding) rather than
// duplicating them - it runs its OWN queries only where no existing CRM
// tool covers the shape needed (the day-bucketed count query in
// get_date_range_aggregation, and the per-teammate performance query in
// get_team_performance).
//
// Caching: only the two genuinely EXPENSIVE, multi-query functions
// (detect_anomalies, explain_change) are cached, via
// infrastructure/cache/redis.ts's getCachedAnalytics/setCachedAnalytics (a
// 5-minute TTL - short enough that a fresh WhatsApp lead never looks stale
// for long, long enough to absorb the "why did leads drop" question being
// asked by more than one person in the same few minutes, which is exactly
// the pattern the spec's "for expensive analytics, introduce
// caching/materialized summaries where appropriate" calls for). Every
// other function here is cheap enough (1-3 simple aggregate queries) that
// caching would only add staleness without a meaningful cost saving - see
// each function's own comment.

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { leadFollowUps, leads, users } from "../../infrastructure/db/schema";
import { getCachedAnalytics, setCachedAnalytics } from "../../infrastructure/cache/redis";
import {
  type CrmAuthContext,
  type RangeOut,
  assertValid,
  companyStages,
  get_campaign_leads,
  get_source_leads,
  hasBroadGrant,
  rangeOut,
  validateAuth,
  validateDateRange,
} from "./crmTools";
import { dayBuckets, previousEquivalentRange, type DateRange } from "./rutaDateRange";

function validateTimezone(timezone: string): Record<string, string> {
  return !timezone || typeof timezone !== "string" || timezone.trim() === "" ? { timezone: "timezone is required." } : {};
}

// ---------------------------------------------------------------------------
// get_date_range_aggregation - day-bucketed lead counts over a range. The
// one shared building block get_trend/detect_anomalies/explain_change are
// all built from below - a SINGLE query (grouped by calendar day, bucketed
// in JS against dayBuckets' own timezone-aware boundaries, not a SQL
// date_trunc - see rutaDateRange.ts's file header for why the
// Intl.DateTimeFormat-offset approach is this codebase's one, consistent
// timezone convention), never re-run per caller.
// ---------------------------------------------------------------------------

export interface GetDateRangeAggregationResult {
  tool: "get_date_range_aggregation";
  scope: "company";
  range: RangeOut;
  totalCount: number;
  buckets: Array<{ label: string; startIso: string; endIso: string; count: number }>;
}

/** Company-wide day-bucketed counts only (no per-lead PII) - same ungated
 * rationale as get_lead_count/get_campaign_leads in crmTools.ts. */
export async function get_date_range_aggregation(auth: CrmAuthContext, args: { range: DateRange; timezone: string }): Promise<GetDateRangeAggregationResult> {
  assertValid("get_date_range_aggregation", validateAuth(auth), validateDateRange(args.range), validateTimezone(args.timezone));
  const db = await getDb();
  const rows = await db
    .select({ metaCreatedAt: leads.metaCreatedAt })
    .from(leads)
    .where(and(eq(leads.companyId, auth.tenantId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)));

  const buckets = dayBuckets(args.range, args.timezone).map((b) => ({
    label: b.label,
    startIso: b.start.toISOString(),
    endIso: b.end.toISOString(),
    count: 0,
  }));
  for (const r of rows) {
    const t = r.metaCreatedAt.getTime();
    // Buckets are contiguous and sorted, so a linear scan is fine at the
    // <=400-bucket cap dayBuckets itself enforces; this runs once per lead
    // row, not once per lead per caller.
    const bucket = buckets.find((b) => t >= new Date(b.startIso).getTime() && t < new Date(b.endIso).getTime());
    if (bucket) bucket.count++;
  }
  return { tool: "get_date_range_aggregation", scope: "company", range: rangeOut(args.range), totalCount: rows.length, buckets };
}

// ---------------------------------------------------------------------------
// Pure computation helpers - operate on already-fetched bucket data, no DB
// access. Shared by get_trend/detect_anomalies/explain_change so none of
// them re-derive the same arithmetic independently.
// ---------------------------------------------------------------------------

export interface TrendStats {
  currentCount: number;
  previousCount: number;
  changeCount: number;
  changePct: number | null; // null when previousCount is 0 (percent change undefined, not infinite/NaN)
  direction: "up" | "down" | "flat";
}

export function computeTrendStats(currentCount: number, previousCount: number): TrendStats {
  const changeCount = currentCount - previousCount;
  const changePct = previousCount > 0 ? Math.round((changeCount / previousCount) * 1000) / 10 : null;
  const direction = changeCount > 0 ? "up" : changeCount < 0 ? "down" : "flat";
  return { currentCount, previousCount, changeCount, changePct, direction };
}

export interface AnomalyBucket {
  label: string;
  startIso: string;
  endIso: string;
  count: number;
  zScore: number;
  kind: "spike" | "drop";
}

/**
 * Basic anomaly detection: flags any bucket whose count is more than
 * `zThreshold` standard deviations from the buckets' own mean - a simple,
 * explainable rule (no external anomaly-detection dependency), deliberately
 * conservative (threshold 2.0, and requires at least 4 buckets so a
 * 2-3-day range never falsely flags normal day-to-day variance off too few
 * samples).
 */
export function computeAnomalies(buckets: Array<{ label: string; startIso: string; endIso: string; count: number }>, zThreshold = 2.0): AnomalyBucket[] {
  if (buckets.length < 4) return [];
  const counts = buckets.map((b) => b.count);
  const mean = counts.reduce((sum, n) => sum + n, 0) / counts.length;
  const variance = counts.reduce((sum, n) => sum + (n - mean) ** 2, 0) / counts.length;
  const stdDev = Math.sqrt(variance);
  if (stdDev === 0) return [];
  return buckets
    .map((b) => ({ ...b, zScore: Math.round(((b.count - mean) / stdDev) * 100) / 100 }))
    .filter((b) => Math.abs(b.zScore) >= zThreshold)
    .map((b) => ({ ...b, kind: (b.zScore > 0 ? "spike" : "drop") as "spike" | "drop" }));
}

// ---------------------------------------------------------------------------
// get_trend - current range vs. the immediately-preceding equivalent range
// (e.g. "this week" vs. "the previous 7 days").
// ---------------------------------------------------------------------------

export interface GetTrendResult {
  tool: "get_trend";
  scope: "company";
  range: RangeOut;
  previousRange: RangeOut;
  stats: TrendStats;
  buckets: Array<{ label: string; startIso: string; endIso: string; count: number }>; // current range only, day-bucketed
}

/** 2 aggregation queries (current range, previous equivalent range) - cheap
 * enough not to need caching; not a fan-out anyone is likely to hit in a
 * tight loop the way explain_change's underlying trend is. */
export async function get_trend(auth: CrmAuthContext, args: { range: DateRange; timezone: string }): Promise<GetTrendResult> {
  assertValid("get_trend", validateAuth(auth), validateDateRange(args.range), validateTimezone(args.timezone));
  const previousRange = previousEquivalentRange(args.range);
  const [current, previous] = await Promise.all([
    get_date_range_aggregation(auth, { range: args.range, timezone: args.timezone }),
    get_date_range_aggregation(auth, { range: previousRange, timezone: args.timezone }),
  ]);
  const stats = computeTrendStats(current.totalCount, previous.totalCount);
  return { tool: "get_trend", scope: "company", range: current.range, previousRange: previous.range, stats, buckets: current.buckets };
}

// ---------------------------------------------------------------------------
// detect_anomalies - basic spike/drop detection over a range's day buckets.
// ---------------------------------------------------------------------------

export interface DetectAnomaliesResult {
  tool: "detect_anomalies";
  scope: "company";
  range: RangeOut;
  buckets: Array<{ label: string; startIso: string; endIso: string; count: number }>;
  anomalies: AnomalyBucket[];
}

/**
 * Cached (getCachedAnalytics/setCachedAnalytics, 5-minute TTL) - this is
 * one of the two functions the file header calls "genuinely expensive": it
 * fetches every lead row in the range to bucket it (same query as
 * get_date_range_aggregation) AND runs the z-score pass over every bucket,
 * and is the kind of question ("did we have a weird day this month?")
 * that's cheap to ask again within a few minutes. Fail-open on a cache
 * miss/error, same as every other cache read in this codebase (see
 * redis.ts's own comment on getCachedAnalytics).
 */
export async function detect_anomalies(auth: CrmAuthContext, args: { range: DateRange; timezone: string }): Promise<DetectAnomaliesResult> {
  assertValid("detect_anomalies", validateAuth(auth), validateDateRange(args.range), validateTimezone(args.timezone));
  const cacheKey = `anomalies:${auth.tenantId}:${args.range.start.toISOString()}:${args.range.end.toISOString()}:${args.timezone}`;
  const cached = await getCachedAnalytics<DetectAnomaliesResult>(cacheKey);
  if (cached) return cached;

  const agg = await get_date_range_aggregation(auth, { range: args.range, timezone: args.timezone });
  const anomalies = computeAnomalies(agg.buckets);
  const result: DetectAnomaliesResult = { tool: "detect_anomalies", scope: "company", range: agg.range, buckets: agg.buckets, anomalies };
  await setCachedAnalytics(cacheKey, result);
  return result;
}

// ---------------------------------------------------------------------------
// get_campaign_comparison / get_source_comparison - current vs. previous
// range, per-campaign / per-source, with computed deltas. Both reuse the
// existing get_campaign_leads/get_source_leads CRM tools rather than
// re-querying directly.
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  name: string;
  currentCount: number;
  previousCount: number;
  changeCount: number;
  changePct: number | null;
}

export interface GetCampaignComparisonResult {
  tool: "get_campaign_comparison";
  scope: "company";
  range: RangeOut;
  previousRange: RangeOut;
  rows: ComparisonRow[]; // sorted desc by |changeCount|
}

function compareRows<T extends { count: number }>(currentRows: Array<T & { name?: string; source?: string; label?: string }>, previousRows: Array<T & { name?: string; source?: string; label?: string }>, keyOf: (r: T) => string): ComparisonRow[] {
  const prevByKey = new Map(previousRows.map((r) => [keyOf(r), r.count]));
  const seen = new Set<string>();
  const rows: ComparisonRow[] = [];
  for (const r of currentRows) {
    const key = keyOf(r);
    seen.add(key);
    const previousCount = prevByKey.get(key) ?? 0;
    const stats = computeTrendStats(r.count, previousCount);
    rows.push({ name: key, currentCount: r.count, previousCount, changeCount: stats.changeCount, changePct: stats.changePct });
  }
  for (const r of previousRows) {
    const key = keyOf(r);
    if (seen.has(key)) continue;
    const stats = computeTrendStats(0, r.count);
    rows.push({ name: key, currentCount: 0, previousCount: r.count, changeCount: stats.changeCount, changePct: stats.changePct });
  }
  return rows.sort((a, b) => Math.abs(b.changeCount) - Math.abs(a.changeCount));
}

/** 2 CRM-tool calls (current + previous range), each already a single
 * aggregate query - cheap, not cached. */
export async function get_campaign_comparison(auth: CrmAuthContext, args: { range: DateRange; previousRange?: DateRange }): Promise<GetCampaignComparisonResult> {
  assertValid("get_campaign_comparison", validateAuth(auth), validateDateRange(args.range));
  const previousRange = args.previousRange ?? previousEquivalentRange(args.range);
  const [current, previous] = await Promise.all([get_campaign_leads(auth, { range: args.range }), get_campaign_leads(auth, { range: previousRange })]);
  const rows = compareRows(current.campaigns, previous.campaigns, (r) => r.name);
  return { tool: "get_campaign_comparison", scope: "company", range: current.range, previousRange: previous.range, rows };
}

export interface GetSourceComparisonResult {
  tool: "get_source_comparison";
  scope: "company";
  range: RangeOut;
  previousRange: RangeOut;
  rows: ComparisonRow[]; // sorted desc by |changeCount|
}

/** Same shape/cost as get_campaign_comparison above, built on
 * get_source_leads instead. */
export async function get_source_comparison(auth: CrmAuthContext, args: { range: DateRange; previousRange?: DateRange }): Promise<GetSourceComparisonResult> {
  assertValid("get_source_comparison", validateAuth(auth), validateDateRange(args.range));
  const previousRange = args.previousRange ?? previousEquivalentRange(args.range);
  const [current, previous] = await Promise.all([get_source_leads(auth, { range: args.range }), get_source_leads(auth, { range: previousRange })]);
  const rows = compareRows(current.sources.map((s) => ({ ...s, name: s.label })), previous.sources.map((s) => ({ ...s, name: s.label })), (r) => r.name!);
  return { tool: "get_source_comparison", scope: "company", range: current.range, previousRange: previous.range, rows };
}

// ---------------------------------------------------------------------------
// get_conversion_rate - overall won/qualified rate over a date range.
// Deliberately company-wide/ungated for CONSISTENCY with
// get_campaign_performance (crmTools.ts), which already reports a MORE
// granular per-campaign conversion rate ungated - gating this strictly
// less granular overall figure would be a backwards, inconsistent privacy
// posture (see file header of crmTools.ts for the general "aggregate
// carries no PII" ungated rationale this follows).
// ---------------------------------------------------------------------------

export interface GetConversionRateResult {
  tool: "get_conversion_rate";
  scope: "company";
  range: RangeOut;
  totalCount: number;
  wonCount: number;
  qualifiedCount: number;
  conversionRatePct: number;
  qualifiedRatePct: number;
}

/** 2 queries: the tenant's stage catalog (companyStages, cheap/small), and
 * one grouped count-by-stage over the range. Not cached - same cost class
 * as get_pipeline_summary in crmTools.ts, which isn't cached either. */
export async function get_conversion_rate(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetConversionRateResult> {
  assertValid("get_conversion_rate", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const [stageDefs, rows] = await Promise.all([
    companyStages(auth.tenantId),
    db
      .select({ pipelineStage: leads.pipelineStage, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(eq(leads.companyId, auth.tenantId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)))
      .groupBy(leads.pipelineStage),
  ]);
  const wonKeys = new Set(stageDefs.filter((s) => s.isWon).map((s) => s.key));
  const qualifiedKeys = new Set(stageDefs.filter((s) => s.isQualified || s.isWon).map((s) => s.key));
  let totalCount = 0;
  let wonCount = 0;
  let qualifiedCount = 0;
  for (const r of rows) {
    const n = Number(r.n);
    totalCount += n;
    if (wonKeys.has(r.pipelineStage)) wonCount += n;
    if (qualifiedKeys.has(r.pipelineStage)) qualifiedCount += n;
  }
  const conversionRatePct = totalCount > 0 ? Math.round((wonCount / totalCount) * 1000) / 10 : 0;
  const qualifiedRatePct = totalCount > 0 ? Math.round((qualifiedCount / totalCount) * 1000) / 10 : 0;
  return { tool: "get_conversion_rate", scope: "company", range: rangeOut(args.range), totalCount, wonCount, qualifiedCount, conversionRatePct, qualifiedRatePct };
}

// ---------------------------------------------------------------------------
// get_team_performance - per-teammate lead volume, wins, conversion rate,
// and logged follow-ups over a date range.
// ---------------------------------------------------------------------------

export interface TeamPerformanceRow {
  userId: string | null;
  name: string;
  leadCount: number;
  wonCount: number;
  conversionRatePct: number;
  followUpsLogged: number;
}

export interface GetTeamPerformanceResult {
  tool: "get_team_performance";
  scope: "self" | "company";
  range: RangeOut;
  rows: TeamPerformanceRow[]; // scope "self": single entry, the caller
}

/**
 * Per-teammate breakdown reveals OTHER teammates' individual metrics, so
 * (same posture as get_user_leads/get_pipeline_summary in crmTools.ts)
 * this requires the broad-query grant, checked HERE - falls back to a
 * personal scope:"self" row rather than a hard refusal when absent.
 * 3 queries when broad (stage catalog, per-owner lead/won counts, per-
 * creator follow-up counts); 2 when self-scoped (no stage catalog needed
 * beyond won-key lookup, still fetched for the conversion rate).
 */
export async function get_team_performance(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetTeamPerformanceResult> {
  assertValid("get_team_performance", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const broad = await hasBroadGrant(auth.tenantId, auth.userId);
  const stageDefs = await companyStages(auth.tenantId);
  const wonKeys = new Set(stageDefs.filter((s) => s.isWon).map((s) => s.key));

  const leadScope = broad ? eq(leads.companyId, auth.tenantId) : and(eq(leads.companyId, auth.tenantId), eq(leads.ownerId, auth.userId));
  const followUpScope = broad ? eq(leadFollowUps.companyId, auth.tenantId) : and(eq(leadFollowUps.companyId, auth.tenantId), eq(leadFollowUps.createdBy, auth.userId));

  const [leadRows, followUpRows] = await Promise.all([
    db
      .select({ ownerId: leads.ownerId, ownerName: users.fullName, pipelineStage: leads.pipelineStage, n: sql<number>`count(*)::int` })
      .from(leads)
      .leftJoin(users, eq(leads.ownerId, users.id))
      .where(and(leadScope, gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)))
      .groupBy(leads.ownerId, users.fullName, leads.pipelineStage),
    db
      .select({ createdBy: leadFollowUps.createdBy, n: sql<number>`count(*)::int` })
      .from(leadFollowUps)
      .where(and(followUpScope, gte(leadFollowUps.createdAt, args.range.start), lt(leadFollowUps.createdAt, args.range.end)))
      .groupBy(leadFollowUps.createdBy),
  ]);

  const followUpsByUser = new Map(followUpRows.map((r) => [r.createdBy, Number(r.n)]));
  const byOwner = new Map<string | null, { name: string; leadCount: number; wonCount: number }>();
  for (const r of leadRows) {
    const entry = byOwner.get(r.ownerId) ?? { name: r.ownerId ? (r.ownerName ?? "Unknown teammate") : "Unassigned", leadCount: 0, wonCount: 0 };
    entry.leadCount += Number(r.n);
    if (wonKeys.has(r.pipelineStage)) entry.wonCount += Number(r.n);
    byOwner.set(r.ownerId, entry);
  }
  const rows: TeamPerformanceRow[] = [...byOwner.entries()]
    .map(([userId, v]) => ({
      userId,
      name: v.name,
      leadCount: v.leadCount,
      wonCount: v.wonCount,
      conversionRatePct: v.leadCount > 0 ? Math.round((v.wonCount / v.leadCount) * 1000) / 10 : 0,
      followUpsLogged: userId ? (followUpsByUser.get(userId) ?? 0) : 0,
    }))
    .sort((a, b) => b.leadCount - a.leadCount);

  if (!broad) {
    const mine = rows.find((r) => r.userId === auth.userId) ?? {
      userId: auth.userId,
      name: "You",
      leadCount: 0,
      wonCount: 0,
      conversionRatePct: 0,
      followUpsLogged: followUpsByUser.get(auth.userId) ?? 0,
    };
    return { tool: "get_team_performance", scope: "self", range: rangeOut(args.range), rows: [mine] };
  }
  return { tool: "get_team_performance", scope: "company", range: rangeOut(args.range), rows };
}

// ---------------------------------------------------------------------------
// explain_change - the flagship composite tool ("Why did leads decrease
// this week?"). Fans out to get_trend + get_campaign_comparison +
// get_source_comparison in parallel, then reuses get_trend's ALREADY-
// FETCHED day buckets for anomaly detection (computeAnomalies is pure, no
// extra query) rather than re-running detect_anomalies' own query - 6 total
// DB-touching operations (2 from get_trend's pair of aggregations, 2 from
// campaign comparison, 2 from source comparison), not 7+.
// ---------------------------------------------------------------------------

export interface ExplainChangeResult {
  tool: "explain_change";
  scope: "company";
  range: RangeOut;
  previousRange: RangeOut;
  stats: TrendStats;
  anomalies: AnomalyBucket[];
  topCampaignShifts: ComparisonRow[]; // top 3 by |changeCount|
  topSourceShifts: ComparisonRow[]; // top 3 by |changeCount|
}

/**
 * Cached (getCachedAnalytics/setCachedAnalytics, 5-minute TTL) - the
 * second of the two "genuinely expensive" functions (file header): it's a
 * 3-way fan-out, exactly the composite "why" question the spec's own
 * example ("Why did leads decrease this week?") calls out, and the kind of
 * question likely to be asked by more than one person (owner + manager)
 * within the same few minutes after a visible dip.
 */
export async function explain_change(auth: CrmAuthContext, args: { range: DateRange; timezone: string }): Promise<ExplainChangeResult> {
  assertValid("explain_change", validateAuth(auth), validateDateRange(args.range), validateTimezone(args.timezone));
  const cacheKey = `explain:${auth.tenantId}:${args.range.start.toISOString()}:${args.range.end.toISOString()}:${args.timezone}`;
  const cached = await getCachedAnalytics<ExplainChangeResult>(cacheKey);
  if (cached) return cached;

  const previousRange = previousEquivalentRange(args.range);
  const [trend, campaignComparison, sourceComparison] = await Promise.all([
    get_trend(auth, { range: args.range, timezone: args.timezone }),
    get_campaign_comparison(auth, { range: args.range, previousRange }),
    get_source_comparison(auth, { range: args.range, previousRange }),
  ]);
  const anomalies = computeAnomalies(trend.buckets);

  const result: ExplainChangeResult = {
    tool: "explain_change",
    scope: "company",
    range: trend.range,
    previousRange: trend.previousRange,
    stats: trend.stats,
    anomalies,
    topCampaignShifts: campaignComparison.rows.slice(0, 3),
    topSourceShifts: sourceComparison.rows.slice(0, 3),
  };
  await setCachedAnalytics(cacheKey, result);
  return result;
}
