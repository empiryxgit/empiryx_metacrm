// The CRM TOOL layer of the RUTA pipeline:
//
//   WhatsApp -> Webhook -> Identity/Auth -> AI Orchestrator -> Intent/Tool
//   Selection -> Authorization -> CRM TOOL -> DB -> Structured Result -> LLM
//   -> WhatsApp
//
// Every function exported here is a typed, validated, SELF-AUTHORIZING unit
// that is the ONLY code in this pipeline allowed to touch the database for
// a RUTA business query. The AI provider (classification, and reply
// composition - see rutaReplyComposer.ts) never runs a query, never reads
// this file, and never sees a tenantId/userId/permission - "LLM must never
// directly query DB" holds by construction: there is no code path from
// infrastructure/ai/provider.ts into this file at all.
//
// Each function here:
//   - takes a verified CrmAuthContext (tenantId/userId only) that the
//     orchestrator (rutaAiAssistant.ts) resolved from the WhatsApp identity
//     chain upstream - never accepted from, or influenced by, the AI
//     provider's output;
//   - validates its own arguments before running any query - hand-rolled
//     validators returning Record<string, string> error maps, the SAME
//     convention as src/domain/formValidation.ts (this codebase has no
//     schema-validation library/dependency such as zod - confirmed absent
//     from package.json - so this intentionally follows the existing
//     framework-free convention rather than introducing a new one);
//   - enforces TENANT scoping unconditionally (every query's WHERE clause
//     is filtered by companyId = auth.tenantId - never filtered
//     client-side after a wider fetch) and its own PERMISSION/data-scope
//     rule, decided HERE (not trusted from a caller-supplied flag) - see
//     hasBroadGrant's own comment below for the exact rule and rationale;
//   - returns a plain, JSON-serializable STRUCTURED result: numbers,
//     strings, and ISO date strings only - never a Date object, never a
//     pre-formatted reply string. This is the "Structured Result" the
//     pipeline hands to the LLM composition step (rutaReplyComposer.ts) or
//     a deterministic fallback formatter (rutaTools.ts) - never back into
//     another DB query, and never mutated by anything downstream.
//
// The CRM/database is the source of truth for every number here. Nothing
// in this file calls out to Meta's Graph API or any other external
// service - get_campaign_performance in particular deliberately reports
// CRM-native metrics (lead volume + pipeline conversion) rather than Meta
// ad-spend/impression metrics, so a WhatsApp reply is never blocked on, or
// made inconsistent by, an external API call. (A live Meta ad-performance
// pull is a materially different feature - already partially cached
// elsewhere for the ads dashboard - and is out of scope here.)

import { and, eq, gte, isNotNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { campaigns, companies, leadFollowUps, leads, users } from "../../infrastructure/db/schema";
import { getUserRoleAndPermissions } from "../../infrastructure/db/repositories/whatsapp";
import { PERMISSIONS } from "../../domain/permissions";
import { LEAD_SOURCES, resolveEffectiveIndustryTemplate, type StageDef } from "../../domain/industryTemplates";
import type { DateRange } from "./rutaDateRange";

export interface CrmAuthContext {
  tenantId: string;
  userId: string;
}

// ---------------------------------------------------------------------------
// Validation - hand-rolled, framework-free (see file header). A failure
// throws CrmToolValidationError rather than silently coercing/ignoring bad
// input; the orchestrator's existing per-tool try/catch (rutaAiAssistant.ts)
// already turns any thrown error, this one included, into a safe logged
// "something went wrong" reply - never a crash, never a silent wrong answer.
// ---------------------------------------------------------------------------

export class CrmToolValidationError extends Error {
  constructor(
    public readonly tool: string,
    public readonly errors: Record<string, string>,
  ) {
    super(`${tool}: invalid arguments (${Object.keys(errors).join(", ")})`);
    this.name = "CrmToolValidationError";
  }
}

// validateAuth/validateDateRange/assertValid/RangeOut/rangeOut are exported
// (not just used internally) so analyticsTools.ts - a sibling of this file,
// built on top of it rather than duplicating its conventions - can reuse
// the EXACT same validation error shape (CrmToolValidationError) and the
// EXACT same date-range JSON encoding. Nothing outside this metaSync
// module imports them.
export function validateAuth(auth: CrmAuthContext): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!auth || typeof auth.tenantId !== "string" || auth.tenantId.trim() === "") errors.tenantId = "tenantId is required.";
  if (!auth || typeof auth.userId !== "string" || auth.userId.trim() === "") errors.userId = "userId is required.";
  return errors;
}

export function validateDateRange(range: DateRange): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!range || !(range.start instanceof Date) || Number.isNaN(range.start.getTime())) errors.start = "range.start must be a valid date.";
  if (!range || !(range.end instanceof Date) || Number.isNaN(range.end.getTime())) errors.end = "range.end must be a valid date.";
  if (!errors.start && !errors.end && range.start.getTime() >= range.end.getTime()) errors.range = "range.start must be before range.end.";
  return errors;
}

export function assertValid(tool: string, ...errorMaps: Record<string, string>[]): void {
  const merged: Record<string, string> = Object.assign({}, ...errorMaps);
  if (Object.keys(merged).length > 0) throw new CrmToolValidationError(tool, merged);
}

export interface RangeOut {
  startIso: string;
  endIso: string;
  label: string;
}

export function rangeOut(range: DateRange): RangeOut {
  return { startIso: range.start.toISOString(), endIso: range.end.toISOString(), label: range.label };
}

/**
 * Whether this user's role grants company/branch-wide RUTA queries against
 * OTHER teammates' data. Deliberately off by default, opt-in only - see
 * PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY's own comment in
 * domain/permissions.ts for the full "WhatsApp is a weaker identity
 * channel" rationale.
 *
 * getUserRoleAndPermissions reads the role's STORED `permissions` column
 * directly - unlike src/application/auth.ts's effectivePermissions(), which
 * live-recomputes a full-access role's permission set at JWT-issue time -
 * this bot has no session/JWT to read, only the verified phone->userId
 * binding, so there is no live-recompute step to go through. This is a
 * DELIBERATE, permanent design property of this pipeline, not a
 * shortcut: every tool below calls this itself rather than trusting a
 * broad/scope flag from a caller, so the authorization decision is made
 * exactly once, here, by backend/services code - never inside the AI
 * provider, and never re-derived or overridden by rutaTools.ts or
 * rutaAiAssistant.ts above this file.
 */
export async function hasBroadGrant(tenantId: string, userId: string): Promise<boolean> {
  const info = await getUserRoleAndPermissions(tenantId, userId);
  return info?.permissions.includes(PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY) ?? false;
}

/** Resolves the tenant's own pipeline-stage catalog (industry-template
 * defined, not a fixed enum - see domain/industryTemplates.ts). Shared by
 * get_pipeline_summary and get_campaign_performance (for its won/conversion
 * calculation) below. */
export async function companyStages(tenantId: string): Promise<StageDef[]> {
  const db = await getDb();
  const [row] = await db
    .select({ industryTemplate: companies.industryTemplate, customTemplateConfig: companies.customTemplateConfig })
    .from(companies)
    .where(eq(companies.id, tenantId))
    .limit(1);
  const template = resolveEffectiveIndustryTemplate(row?.industryTemplate, row?.customTemplateConfig);
  return template.stages;
}

// ---------------------------------------------------------------------------
// get_lead_count - company-wide lead count over a date range.
// ---------------------------------------------------------------------------

export interface GetLeadCountResult {
  tool: "get_lead_count";
  scope: "company";
  range: RangeOut;
  count: number;
}

/**
 * Company-wide COUNT ONLY (no names/phone numbers/per-lead rows) -
 * deliberately ungated (no broad-query permission check): an aggregate
 * number carries no per-lead PII, unlike get_user_leads below. Tenant
 * filter: leads.companyId = auth.tenantId, always.
 */
export async function get_lead_count(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetLeadCountResult> {
  assertValid("get_lead_count", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.companyId, auth.tenantId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)));
  return { tool: "get_lead_count", scope: "company", range: rangeOut(args.range), count: row?.n ?? 0 };
}

// ---------------------------------------------------------------------------
// get_campaign_leads - breakdown of lead volume by campaign.
// ---------------------------------------------------------------------------

export interface GetCampaignLeadsResult {
  tool: "get_campaign_leads";
  scope: "company";
  range: RangeOut;
  totalCount: number;
  campaigns: Array<{ name: string; count: number }>; // sorted desc by count
}

/** Company-wide aggregate counts by campaign NAME only (no per-lead PII) -
 * same ungated rationale as get_lead_count above. */
export async function get_campaign_leads(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetCampaignLeadsResult> {
  assertValid("get_campaign_leads", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const rows = await db
    .select({ crmName: campaigns.name, rawName: leads.campaignName, n: sql<number>`count(*)::int` })
    .from(leads)
    .leftJoin(campaigns, eq(leads.crmCampaignId, campaigns.id))
    .where(and(eq(leads.companyId, auth.tenantId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)))
    .groupBy(campaigns.name, leads.campaignName);
  const named = rows.map((r) => ({ name: r.crmName ?? r.rawName ?? "Unassigned/Other", count: Number(r.n) })).sort((a, b) => b.count - a.count);
  const totalCount = named.reduce((sum, r) => sum + r.count, 0);
  return { tool: "get_campaign_leads", scope: "company", range: rangeOut(args.range), totalCount, campaigns: named };
}

// ---------------------------------------------------------------------------
// get_source_leads - breakdown of lead volume by source (Meta Lead Ads,
// Website, Referral, Walk-in, ...). Not one of the six originally-named
// tools, but pulled out of rutaTools.ts's sourceLeadCountsTool (which used
// to query directly) so analyticsTools.ts's get_source_comparison can
// reuse the exact same query/scoping rather than duplicating it.
// ---------------------------------------------------------------------------

export interface GetSourceLeadsResult {
  tool: "get_source_leads";
  scope: "company";
  range: RangeOut;
  totalCount: number;
  sources: Array<{ source: string; label: string; count: number }>; // sorted desc by count
}

/** Same ungated, aggregate-only rationale as get_lead_count/get_campaign_leads
 * above - per-source totals carry no per-lead PII. */
export async function get_source_leads(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetSourceLeadsResult> {
  assertValid("get_source_leads", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const rows = await db
    .select({ source: leads.source, n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.companyId, auth.tenantId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)))
    .groupBy(leads.source);
  const labeled = rows
    .map((r) => ({ source: r.source, label: LEAD_SOURCES.find((s) => s.key === r.source)?.label ?? r.source, count: Number(r.n) }))
    .sort((a, b) => b.count - a.count);
  const totalCount = labeled.reduce((sum, r) => sum + r.count, 0);
  return { tool: "get_source_leads", scope: "company", range: rangeOut(args.range), totalCount, sources: labeled };
}

// ---------------------------------------------------------------------------
// get_campaign_performance - CRM-native performance (lead volume + pipeline
// conversion), never Meta ad-spend/impression metrics. See file header.
// ---------------------------------------------------------------------------

export interface GetCampaignPerformanceResult {
  tool: "get_campaign_performance";
  scope: "company";
  range: RangeOut;
  campaigns: Array<{ name: string; leadCount: number; wonCount: number; conversionRatePct: number }>; // sorted desc by leadCount
}

/** Same ungated, aggregate-only rationale as get_lead_count/get_campaign_leads
 * - per-campaign totals and a won/conversion rate carry no per-lead PII. */
export async function get_campaign_performance(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetCampaignPerformanceResult> {
  assertValid("get_campaign_performance", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const stages = await companyStages(auth.tenantId);
  const wonKeys = new Set(stages.filter((s) => s.isWon).map((s) => s.key));

  const rows = await db
    .select({ crmName: campaigns.name, rawName: leads.campaignName, pipelineStage: leads.pipelineStage, n: sql<number>`count(*)::int` })
    .from(leads)
    .leftJoin(campaigns, eq(leads.crmCampaignId, campaigns.id))
    .where(and(eq(leads.companyId, auth.tenantId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)))
    .groupBy(campaigns.name, leads.campaignName, leads.pipelineStage);

  const byName = new Map<string, { leadCount: number; wonCount: number }>();
  for (const r of rows) {
    const name = r.crmName ?? r.rawName ?? "Unassigned/Other";
    const entry = byName.get(name) ?? { leadCount: 0, wonCount: 0 };
    entry.leadCount += Number(r.n);
    if (wonKeys.has(r.pipelineStage)) entry.wonCount += Number(r.n);
    byName.set(name, entry);
  }
  const campaignsOut = [...byName.entries()]
    .map(([name, v]) => ({
      name,
      leadCount: v.leadCount,
      wonCount: v.wonCount,
      conversionRatePct: v.leadCount > 0 ? Math.round((v.wonCount / v.leadCount) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.leadCount - a.leadCount);

  return { tool: "get_campaign_performance", scope: "company", range: rangeOut(args.range), campaigns: campaignsOut };
}

// ---------------------------------------------------------------------------
// get_user_leads - breakdown of lead ownership by teammate.
// ---------------------------------------------------------------------------

export interface GetUserLeadsResult {
  tool: "get_user_leads";
  scope: "self" | "company";
  range: RangeOut;
  totalCount: number;
  users: Array<{ userId: string | null; name: string; count: number }>; // scope "self": single entry, the caller
}

/**
 * A per-owner breakdown reveals OTHER teammates' individual counts, so
 * (unlike the aggregate-only tools above) this requires
 * PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY - checked HERE, not trusted
 * from any caller. Without the grant, this falls back to just the asking
 * user's own count rather than refusing outright (scope: "self").
 */
export async function get_user_leads(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetUserLeadsResult> {
  assertValid("get_user_leads", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const broad = await hasBroadGrant(auth.tenantId, auth.userId);

  if (!broad) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(eq(leads.companyId, auth.tenantId), eq(leads.ownerId, auth.userId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)));
    const n = row?.n ?? 0;
    return { tool: "get_user_leads", scope: "self", range: rangeOut(args.range), totalCount: n, users: [{ userId: auth.userId, name: "You", count: n }] };
  }

  const rows = await db
    .select({ ownerId: leads.ownerId, ownerName: users.fullName, n: sql<number>`count(*)::int` })
    .from(leads)
    .leftJoin(users, eq(leads.ownerId, users.id))
    .where(and(eq(leads.companyId, auth.tenantId), gte(leads.metaCreatedAt, args.range.start), lt(leads.metaCreatedAt, args.range.end)))
    .groupBy(leads.ownerId, users.fullName);
  const named = rows.map((r) => ({ userId: r.ownerId, name: r.ownerId ? (r.ownerName ?? "Unknown teammate") : "Unassigned", count: Number(r.n) })).sort((a, b) => b.count - a.count);
  const totalCount = named.reduce((sum, r) => sum + r.count, 0);
  return { tool: "get_user_leads", scope: "company", range: rangeOut(args.range), totalCount, users: named };
}

// ---------------------------------------------------------------------------
// get_pipeline_summary - live snapshot of leads by pipeline stage.
// ---------------------------------------------------------------------------

export interface GetPipelineSummaryResult {
  tool: "get_pipeline_summary";
  scope: "self" | "company";
  totalCount: number;
  stages: Array<{ key: string; label: string; count: number; isWon: boolean; isQualified: boolean }>;
  // Pipeline metrics, computed HERE (never left for an LLM to infer from
  // the stage list) - wonCount/qualifiedCount are simple sums over
  // `stages` above; conversionRatePct/qualifiedRatePct divide those by
  // totalCount, 0 when totalCount is 0 (never a divide-by-zero NaN).
  wonCount: number;
  qualifiedCount: number; // leads currently in a stage flagged isQualified OR isWon (won implies having been qualified)
  conversionRatePct: number;
  qualifiedRatePct: number;
}

/** Personal-scoped unless the caller holds the broad-query grant (checked
 * HERE) - same posture as get_user_leads above, for the same reason: a
 * full pipeline breakdown implicitly reveals company-wide volume. */
export async function get_pipeline_summary(auth: CrmAuthContext): Promise<GetPipelineSummaryResult> {
  assertValid("get_pipeline_summary", validateAuth(auth));
  const db = await getDb();
  const broad = await hasBroadGrant(auth.tenantId, auth.userId);
  const scope = broad ? eq(leads.companyId, auth.tenantId) : and(eq(leads.companyId, auth.tenantId), eq(leads.ownerId, auth.userId));

  const [stageDefs, rows] = await Promise.all([
    companyStages(auth.tenantId),
    db.select({ pipelineStage: leads.pipelineStage, n: sql<number>`count(*)::int` }).from(leads).where(scope).groupBy(leads.pipelineStage),
  ]);
  const byKey = new Map(rows.map((r) => [r.pipelineStage, Number(r.n)]));
  const known = new Set(stageDefs.map((s) => s.key));
  const stages = [
    ...stageDefs.map((s) => ({ key: s.key, label: s.label, count: byKey.get(s.key) ?? 0, isWon: s.isWon === true, isQualified: s.isQualified === true })),
    // Any stray stage value present on a row but absent from the current
    // template (e.g. left over from a since-changed custom template).
    ...rows.filter((r) => !known.has(r.pipelineStage)).map((r) => ({ key: r.pipelineStage, label: r.pipelineStage, count: Number(r.n), isWon: false, isQualified: false })),
  ];
  const totalCount = stages.reduce((sum, s) => sum + s.count, 0);
  const wonCount = stages.reduce((sum, s) => sum + (s.isWon ? s.count : 0), 0);
  const qualifiedCount = stages.reduce((sum, s) => sum + (s.isQualified || s.isWon ? s.count : 0), 0);
  const conversionRatePct = totalCount > 0 ? Math.round((wonCount / totalCount) * 1000) / 10 : 0;
  const qualifiedRatePct = totalCount > 0 ? Math.round((qualifiedCount / totalCount) * 1000) / 10 : 0;
  return { tool: "get_pipeline_summary", scope: broad ? "company" : "self", totalCount, stages, wonCount, qualifiedCount, conversionRatePct, qualifiedRatePct };
}

// ---------------------------------------------------------------------------
// get_followup_summary - the asking user's follow-up activity: how many
// logged over a date range, plus how many are pending/overdue right now.
// ---------------------------------------------------------------------------

export interface GetFollowupSummaryResult {
  tool: "get_followup_summary";
  range: RangeOut;
  loggedCount: number;
  loggedScope: "self"; // logging activity is always personal - who created the follow-up entry
  pendingCount: number;
  pendingScope: "self" | "company";
}

/**
 * loggedCount is always scoped to the asking user (leadFollowUps.createdBy)
 * - there is no company-wide "who logged what" breakdown here, matching
 * get_followup_summary's job as a personal activity summary. pendingCount
 * (leads due/overdue for a follow-up) additionally widens to company-wide
 * when the caller holds the broad-query grant (checked HERE), same posture
 * as get_pipeline_summary/get_user_leads above.
 */
export async function get_followup_summary(auth: CrmAuthContext, args: { range: DateRange }): Promise<GetFollowupSummaryResult> {
  assertValid("get_followup_summary", validateAuth(auth), validateDateRange(args.range));
  const db = await getDb();
  const broad = await hasBroadGrant(auth.tenantId, auth.userId);
  const pendingScope = broad ? eq(leads.companyId, auth.tenantId) : and(eq(leads.companyId, auth.tenantId), eq(leads.ownerId, auth.userId));

  const [loggedRows, pendingRows] = await Promise.all([
    db
      .select({ id: leadFollowUps.id })
      .from(leadFollowUps)
      .where(and(eq(leadFollowUps.companyId, auth.tenantId), eq(leadFollowUps.createdBy, auth.userId), gte(leadFollowUps.createdAt, args.range.start), lt(leadFollowUps.createdAt, args.range.end))),
    db
      .select({ id: leads.id })
      .from(leads)
      .where(and(pendingScope, isNotNull(leads.nextFollowUpAt), lte(leads.nextFollowUpAt, new Date()))),
  ]);

  return {
    tool: "get_followup_summary",
    range: rangeOut(args.range),
    loggedCount: loggedRows.length,
    loggedScope: "self",
    pendingCount: pendingRows.length,
    pendingScope: broad ? "company" : "self",
  };
}
