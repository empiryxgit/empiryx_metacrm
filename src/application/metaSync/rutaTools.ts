// The INTENT/TOOL SELECTION layer of the RUTA pipeline - the one place both
// classification tiers (the fast regex pattern matcher below, and the AI
// provider fallback in src/infrastructure/ai/provider.ts) draw their tool
// names/descriptions/parameter schemas from. Before this file existed the
// pattern matcher's five-ish regex branches and the AI provider's own fixed
// function array were two separately hand-maintained lists that had to be
// kept in sync by hand - RUTA_TOOLS below is now the single source of
// truth for "what RUTA can do," so adding a tool means adding one entry
// here, not remembering to update two places.
//
//   WhatsApp -> Webhook -> Identity/Auth -> AI Orchestrator -> INTENT/TOOL
//   SELECTION (this file) -> Authorization -> CRM Tool -> DB -> Structured
//   Result -> LLM -> WhatsApp
//
// Every tool's run() is handed a RutaToolContext (tenantId/userId/timezone
// only - never a raw request, never another user's data). The six tools
// backed by a NAMED CRM tool (leadCount/campaignLeadCounts/
// campaignPerformance/userLeadCounts/pipelineSummary/followUpCount, each
// noted in its own comment below) delegate BOTH the query and the
// authorization decision to that CRM tool in crmTools.ts - see that file's
// own header for the full "typed, validated, self-authorizing" contract -
// and then format a deterministic reply from its structured result (the
// "Structured Result" pipeline stage), which the orchestrator
// (rutaAiAssistant.ts) may hand to the LLM composition step
// (rutaReplyComposer.ts) to phrase, always with that deterministic text as
// the fallback. Every other tool here (help, myLeadsToday, updateOnX,
// pendingFollowUps, leadStatus, followUpsToday, sourceLeadCounts) still
// queries the DB directly and enforces its own authorization inline (see
// hasBroadGrant's own comment in crmTools.ts, and each tool's individual
// comment below for exactly what it does and doesn't require the grant
// for) - this mirrors, unchanged, the authorization behavior already
// audited and fixed in this codebase (Findings 2a/2b/2c).

import { and, desc, eq, gte, ilike, isNotNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { leadFollowUps, leads, users } from "../../infrastructure/db/schema";
import { LEAD_SOURCES } from "../../domain/industryTemplates";
import type { AiToolSchema } from "../../infrastructure/ai/provider";
import { containsDateRangePhrase, type DateRange, parseDateRangePhrase, todayRange } from "./rutaDateRange";
import { composeReply } from "./rutaReplyComposer";
import {
  companyStages,
  get_campaign_leads,
  get_campaign_performance,
  get_followup_summary,
  get_lead_count,
  get_pipeline_summary,
  get_user_leads,
  hasBroadGrant,
} from "./crmTools";

export type { DateRange } from "./rutaDateRange";
// Re-exported for backward compatibility - hasBroadGrant now LIVES in
// crmTools.ts (it's a CRM-tool-layer authorization primitive, called by
// every permission-gated CRM tool itself rather than by any caller - see
// its own comment there), but nothing outside this file imported it
// directly before this refactor, so this re-export costs nothing and keeps
// the public surface of "where RUTA's authorization helper lives" stable.
export { hasBroadGrant } from "./crmTools";

export interface RutaToolContext {
  tenantId: string;
  userId: string;
  /** "Today" resolution timezone - the company's own (see
   * todayRangeInTimezone in rutaAiAssistant.ts), never server UTC or the
   * sender's device time. */
  timezone: string;
  /** The date range resolved by the most recent ANCHOR query in this same
   * conversation thread (see the "sessionRole" doc comment on RutaTool
   * below), when one is still live. A drill-down tool (campaignLeadCounts/campaignPerformance/
   * sourceLeadCounts / userLeadCounts) falls back to this when its OWN
   * message text names no date range of its own, so "Which campaign gave
   * the most?" right after "How many leads today?" inherits "today" without
   * the user repeating it. Never set by anything other than the
   * orchestrator (rutaAiAssistant.ts), and never trusted blindly - a tool
   * still prefers a date range parsed from its own text first. */
  defaultDateRange?: DateRange;
}

export interface PendingOption {
  kind: "lead" | "teammate";
  id: string;
  label: string;
}

/** Multi-turn session state, persisted on userWhatsappLinks.pendingQueryContext
 * (see src/application/metaSync/rutaAiAssistant.ts's session handling),
 * scoped per (tenantId, userId) by that column's own primary lookup key, so
 * two different users' in-flight conversations can never collide or
 * overwrite each other, even mid-conversation, even for the same tenant.
 * Two unrelated uses share this one TTL-bound slot (a fresh turn always
 * simply overwrites whatever was pending, never accumulates - see
 * setPendingQueryContext's own comment):
 *   - "disambiguation": a search matched more than one lead/teammate and is
 *     waiting on a numbered reply (unchanged from before conversational
 *     follow-ups existed).
 *   - "anchor": the date range resolved by the most recent ANCHOR-role tool
 *     (see RutaTool.sessionRole below), so a later drill-down or bare
 *     date-only follow-up in the same thread can reuse/re-run it. */
export type PendingQueryContext =
  | { kind: "disambiguation"; options: PendingOption[] }
  | { kind: "anchor"; tool: string; range: { startIso: string; endIso: string; label: string } };

/**
 * `text` is ALWAYS the deterministic, AI-free reply (see each CRM-backed
 * tool below) - the whole answer when no AI provider is configured, and
 * the safety net whenever one is. `structured`, when present, is the
 * CRM tool's own JSON structured result (crmTools.ts) for that same
 * answer - only tools backed directly by one of the six named CRM tools
 * (get_lead_count/get_campaign_leads/get_campaign_performance/
 * get_user_leads/get_pipeline_summary/get_followup_summary) set it. When
 * set, the orchestrator (rutaAiAssistant.ts) runs the "Structured Result
 * -> LLM -> WhatsApp" composition step (rutaReplyComposer.ts) to phrase the
 * FINAL reply from it, falling back to `text` on any failure; tools that
 * omit `structured` (help, myLeadsToday, updateOnX, pendingFollowUps,
 * leadStatus, followUpsToday, sourceLeadCounts, ...) always send `text`
 * as-is, unchanged from before this pipeline stage existed.
 *
 * Typed `unknown` here (not `Record<string, unknown>`) purely so each
 * CRM tool's own named result interface (GetLeadCountResult, ...) can be
 * assigned here directly with no cast - every one of them is already
 * plain, JSON-serializable data by construction (see crmTools.ts's file
 * header); rutaReplyComposer.ts's composeReply is the one place this is
 * treated as JSON (via JSON.stringify), and is typed accordingly.
 */
export type RutaToolResult =
  | { kind: "text"; text: string; dateRange?: DateRange; structured?: unknown }
  | { kind: "disambiguate"; text: string; options: PendingOption[] };

export interface RutaTool {
  name: string;
  description: string;
  parameters: AiToolSchema["parameters"];
  /** Executes the tool. `args.query` carries the raw inbound message text
   * for every tool (not just updateOnX) so date-range-aware tools can parse
   * a phrase out of it themselves; most tools still ignore it entirely -
   * their answer depends only on ctx. */
  run(ctx: RutaToolContext, args: { query?: string }): Promise<RutaToolResult>;
  /**
   * Conversational-follow-up role (see PendingQueryContext's own comment
   * above and rutaAiAssistant.ts's handleOneMessage for exactly how each
   * role is used):
   *   - "anchor": a primary/base query (a plain count, e.g. leadCount /
   *     followUpCount). On a successful (non-disambiguate) reply, the
   *     orchestrator stores its resolved date range as the new anchor,
   *     overwriting any previous one - this is what "What about yesterday?"
   *     re-runs.
   *   - "drilldown": a secondary/breakdown query (campaignLeadCounts/campaignPerformance/
   *     sourceLeadCounts / userLeadCounts) that CONSULTS ctx.defaultDateRange
   *     but never overwrites or clears the anchor - so asking a drill-down
   *     question doesn't lose the ability to later say "what about
   *     yesterday" and have it re-run the ORIGINAL anchor query, exactly as
   *     in the spec's example (leads today -> campaign breakdown -> "what
   *     about yesterday" re-runs the leads-today-style query, not the
   *     campaign breakdown).
   *   - undefined: an ordinary tool unrelated to date-range follow-ups
   *     (help, myLeadsToday, updateOnX, pendingFollowUps, leadStatus,
   *     pipelineSummary, ...). A successful reply from one of these clears
   *     any pending anchor/disambiguation - the conversation has moved on.
   */
  sessionRole?: "anchor" | "drilldown";
}

/** "Today" resolved in the COMPANY's own timezone. Thin wrapper over
 * rutaDateRange.ts's todayRange (the one real implementation, shared with
 * every other named range - "yesterday", "this week", ...) that drops the
 * `label` field, kept only so existing call sites (resolveLeadPick /
 * resolveTeammatePick / the older today-only tools below) don't need to
 * change. New code should prefer resolveRange/parseDateRangePhrase
 * directly. */
export function todayRangeInTimezone(timezone: string): { start: Date; end: Date } {
  const { start, end } = todayRange(timezone);
  return { start, end };
}

/**
 * Resolves the date range a date-range-aware tool should use, in priority
 * order: (1) a phrase parsed out of the tool's OWN query text - the most
 * specific, always wins if present; (2) the conversation's live anchor
 * range (ctx.defaultDateRange), set by the orchestrator when the previous
 * turn's anchor query is still fresh - lets a drill-down question inherit
 * "today" without repeating it; (3) today, the same default every one of
 * these tools had before date ranges existed at all.
 */
export function resolveRange(ctx: RutaToolContext, queryText: string | undefined): DateRange {
  const fromText = queryText ? parseDateRangePhrase(queryText, ctx.timezone) : null;
  return fromText ?? ctx.defaultDateRange ?? todayRange(ctx.timezone);
}

// ---------------------------------------------------------------------------
// Individual tools.
// ---------------------------------------------------------------------------

const helpTool: RutaTool = {
  name: "help",
  description: "The user is asking what RUTA AI Assistant can do.",
  parameters: { type: "object", properties: {} },
  async run() {
    return {
      kind: "text",
      text:
        'I can answer things like:\n• "how many leads did we get today" (or yesterday, this week, between 1 aug and 10 aug, ...)\n• "which campaign gave the most leads"\n• "campaign performance" / "conversion rate by campaign"\n• "leads by source"\n• "leads by teammate"\n• "follow-ups this week"\n• "pipeline summary"\n• "how many leads are qualified"\n• "update on <name or phone>"\n• "my leads today"\n• "pending follow-ups"\n\nAsk a follow-up like "what about yesterday?" and I\'ll re-run your last question with the new date.',
    };
  },
};

const followUpsTodayTool: RutaTool = {
  name: "followUpsToday",
  description: "How many follow-ups the asking user logged today.",
  parameters: { type: "object", properties: {} },
  async run(ctx) {
    const { start, end } = todayRangeInTimezone(ctx.timezone);
    const db = await getDb();
    const rows = await db
      .select({ id: leadFollowUps.id })
      .from(leadFollowUps)
      .where(and(eq(leadFollowUps.companyId, ctx.tenantId), eq(leadFollowUps.createdBy, ctx.userId), gte(leadFollowUps.createdAt, start), lt(leadFollowUps.createdAt, end)));
    return { kind: "text", text: rows.length === 1 ? "You logged 1 follow-up today." : `You logged ${rows.length} follow-ups today.` };
  },
};

const myLeadsTodayTool: RutaTool = {
  name: "myLeadsToday",
  description: "Leads newly assigned to or created for the asking user today.",
  parameters: { type: "object", properties: {} },
  async run(ctx) {
    const { start, end } = todayRangeInTimezone(ctx.timezone);
    const db = await getDb();
    const rows = await db
      .select({ fullName: leads.fullName, phoneNumber: leads.phoneNumber })
      .from(leads)
      .where(and(eq(leads.companyId, ctx.tenantId), eq(leads.ownerId, ctx.userId), gte(leads.metaCreatedAt, start), lt(leads.metaCreatedAt, end)))
      .orderBy(desc(leads.metaCreatedAt))
      .limit(10);
    if (rows.length === 0) return { kind: "text", text: "No leads assigned to you today." };
    const list = rows.map((r) => `• ${r.fullName ?? "Unnamed"}${r.phoneNumber ? ` — ${r.phoneNumber}` : ""}`).join("\n");
    return { kind: "text", text: `${rows.length} lead${rows.length === 1 ? "" : "s"} today:\n${list}` };
  },
};

const leadCountTool: RutaTool = {
  name: "leadCount",
  description:
    "Total number of leads the company received, company-wide, over a date range - today by default. Covers plain 'how many leads' as well as explicit ranges like 'yesterday', 'this week', 'last month', or 'between 1 aug and 10 aug'.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The date-range phrase from the user's message, if any (e.g. 'today', 'yesterday', 'this week', 'between 1 aug and 10 aug'). Omit for a plain lead-count question with no range mentioned." } },
  },
  // Company-wide COUNT ONLY (no names/phone numbers) - deliberately ungated
  // (no broad-query permission check): an aggregate number carries no
  // per-lead PII, unlike the detail lists below, which DO require the
  // grant. See PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY's own comment.
  //
  // ANCHOR role: this is the base "how many leads" query the spec's
  // conversational example builds on ("How many leads today?" -> "Which
  // campaign gave the most?" -> "What about yesterday?") - see
  // RutaTool.sessionRole's own comment for exactly what that means.
  sessionRole: "anchor",
  // Backed by the get_lead_count CRM tool (crmTools.ts) - that function
  // both queries the DB and decides authorization (none needed, aggregate
  // only); this run() is now just: resolve the range, call the CRM tool,
  // format the deterministic fallback, then hand the structured result to
  // the "Structured Result -> LLM" composition step (see RutaToolResult's
  // own comment above).
  async run(ctx, args) {
    const range = resolveRange(ctx, args.query);
    const structured = await get_lead_count({ tenantId: ctx.tenantId, userId: ctx.userId }, { range });
    const n = structured.count;
    const fallbackText = `You received ${n} lead${n === 1 ? "" : "s"} ${range.label}.`;
    return { kind: "text", text: fallbackText, dateRange: range, structured };
  },
};

const pendingFollowUpsTool: RutaTool = {
  name: "pendingFollowUps",
  description: "Leads with a follow-up due today or overdue.",
  parameters: { type: "object", properties: {} },
  async run(ctx) {
    const broad = await hasBroadGrant(ctx.tenantId, ctx.userId);
    const db = await getDb();
    const scope = broad ? eq(leads.companyId, ctx.tenantId) : and(eq(leads.companyId, ctx.tenantId), eq(leads.ownerId, ctx.userId));
    const rows = await db
      .select({ fullName: leads.fullName, phoneNumber: leads.phoneNumber, nextFollowUpAt: leads.nextFollowUpAt })
      .from(leads)
      .where(and(scope, isNotNull(leads.nextFollowUpAt), lte(leads.nextFollowUpAt, new Date())))
      .orderBy(leads.nextFollowUpAt)
      .limit(10);
    if (rows.length === 0) return { kind: "text", text: broad ? "No pending follow-ups company-wide." : "No pending follow-ups for you." };
    const list = rows.map((r) => `• ${r.fullName ?? "Unnamed"}${r.phoneNumber ? ` — ${r.phoneNumber}` : ""} (due ${r.nextFollowUpAt?.toLocaleDateString("en-IN")})`).join("\n");
    return { kind: "text", text: `${rows.length} pending follow-up${rows.length === 1 ? "" : "s"}${broad ? " (company-wide)" : ""}:\n${list}` };
  },
};

const updateOnXTool: RutaTool = {
  name: "updateOnX",
  description: "Status/update on a specific lead or teammate, identified by name or phone number.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The name or phone number asked about." } },
    required: ["query"],
  },
  // Search only - the numbered-pick RESOLUTION path (after a disambiguate
  // reply) is handled separately by resolveLeadPick/resolveTeammatePick
  // below, called directly by the orchestrator (rutaAiAssistant.ts) once it
  // parses a `__resolved__:kind:id` selection out of session state - that
  // path never re-enters this run().
  async run(ctx, args) {
    const query = (args.query ?? "").trim();
    if (!query) return { kind: "text", text: "Who would you like an update on?" };

    const db = await getDb();
    const broad = await hasBroadGrant(ctx.tenantId, ctx.userId);
    const digitsOnly = query.replace(/[^\d]/g, "");
    const leadScope = broad ? eq(leads.companyId, ctx.tenantId) : and(eq(leads.companyId, ctx.tenantId), eq(leads.ownerId, ctx.userId));
    const leadMatches = await db
      .select({ id: leads.id, fullName: leads.fullName, phoneNumber: leads.phoneNumber })
      .from(leads)
      .where(and(leadScope, digitsOnly.length >= 6 ? ilike(leads.phoneNumber, `%${digitsOnly}%`) : ilike(leads.fullName, `%${query}%`)))
      .limit(5);

    // Teammate name search is gated by the SAME broad-query grant as the
    // lead search above (audit Finding 2b) - without it, this always
    // searched every active teammate company-wide regardless of the grant.
    const teammateMatches = broad
      ? await db
          .select({ id: users.id, fullName: users.fullName })
          .from(users)
          .where(and(eq(users.companyId, ctx.tenantId), eq(users.status, "active"), ilike(users.fullName, `%${query}%`)))
          .limit(5)
      : [];

    const options: PendingOption[] = [
      ...leadMatches.map((l) => ({ kind: "lead" as const, id: l.id, label: `${l.fullName ?? "Unnamed"} — lead${l.phoneNumber ? `, ${l.phoneNumber}` : ""}` })),
      ...teammateMatches.map((u) => ({ kind: "teammate" as const, id: u.id, label: `${u.fullName} — teammate` })),
    ];

    if (options.length === 0) return { kind: "text", text: `No lead or teammate found matching "${query}".` };
    if (options.length === 1) {
      const only = options[0]!;
      const result = only.kind === "lead" ? await resolveLeadPick(ctx, only.id) : await resolveTeammatePick(ctx, only.id);
      return { kind: "text", text: result };
    }
    const numbered = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
    return { kind: "disambiguate", text: `Multiple matches — reply with a number:\n${numbered}`, options };
  },
};

// ---------------------------------------------------------------------------
// Date-range-aware count/breakdown tools (natural-language queries).
// leadCount and followUpCount are the two ANCHOR tools; campaignLeadCounts/
// sourceLeadCounts/userLeadCounts are DRILL-DOWN tools that consult but
// never own the anchor - see RutaTool.sessionRole's doc comment above for
// the full contract these rely on for conversational follow-ups.
// ---------------------------------------------------------------------------

const followUpCountTool: RutaTool = {
  name: "followUpCount",
  description:
    "Summary of the asking user's follow-up activity over a date range (today by default) - how many follow-ups they logged, plus how many are pending/overdue right now. Generalizes followUpsToday to any range ('yesterday', 'this week', 'last month', ...).",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The date-range phrase from the user's message, if any." } },
  },
  sessionRole: "anchor",
  // Backed by the get_followup_summary CRM tool (crmTools.ts).
  async run(ctx, args) {
    const range = resolveRange(ctx, args.query);
    const structured = await get_followup_summary({ tenantId: ctx.tenantId, userId: ctx.userId }, { range });
    const loggedLine = `You logged ${structured.loggedCount} follow-up${structured.loggedCount === 1 ? "" : "s"} ${range.label}.`;
    const pendingLine =
      structured.pendingCount === 0
        ? `No pending follow-ups${structured.pendingScope === "company" ? " company-wide" : ""} right now.`
        : `${structured.pendingCount} pending follow-up${structured.pendingCount === 1 ? "" : "s"}${structured.pendingScope === "company" ? " (company-wide)" : ""} due or overdue.`;
    const fallbackText = `${loggedLine}\n${pendingLine}`;
    return { kind: "text", text: fallbackText, dateRange: range, structured };
  },
};

const campaignLeadCountsTool: RutaTool = {
  name: "campaignLeadCounts",
  description:
    "Breakdown of leads by campaign over a date range - which campaign brought in the most/least leads. If the message names no date range, inherits the range from the conversation's current lead-count question (defaulting to today).",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The date-range phrase from the user's message, if any." } },
  },
  // Company-wide aggregate counts by campaign NAME only (no per-lead PII) -
  // deliberately ungated, same rationale as leadCount above. Drill-down
  // role: consults ctx.defaultDateRange, never sets/clears the anchor.
  // Backed by the get_campaign_leads CRM tool (crmTools.ts).
  sessionRole: "drilldown",
  async run(ctx, args) {
    const range = resolveRange(ctx, args.query);
    const structured = await get_campaign_leads({ tenantId: ctx.tenantId, userId: ctx.userId }, { range });
    if (structured.totalCount === 0) return { kind: "text", text: `No leads ${range.label} to break down by campaign.`, dateRange: range, structured };
    const top = structured.campaigns[0]!;
    const list = structured.campaigns.slice(0, 5).map((r) => `• ${r.name} — ${r.count}`).join("\n");
    const fallbackText = `${top.name} led with ${top.count} lead${top.count === 1 ? "" : "s"} ${range.label} (${structured.totalCount} total).\n\n${list}`;
    return { kind: "text", text: fallbackText, dateRange: range, structured };
  },
};

const campaignPerformanceTool: RutaTool = {
  name: "campaignPerformance",
  description:
    "get_campaign_performance - CRM-native performance breakdown by campaign over a date range: lead volume, how many of those leads reached the won/closed stage, and the resulting conversion rate. Not Meta ad-spend/impression metrics - the CRM/database is the source of truth for this. If the message names no date range, inherits the conversation's current lead-count range (defaulting to today).",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The date-range phrase from the user's message, if any." } },
  },
  // Same ungated, aggregate-only rationale as campaignLeadCounts above -
  // per-campaign totals and a conversion rate carry no per-lead PII. Backed
  // by the get_campaign_performance CRM tool (crmTools.ts).
  sessionRole: "drilldown",
  async run(ctx, args) {
    const range = resolveRange(ctx, args.query);
    const structured = await get_campaign_performance({ tenantId: ctx.tenantId, userId: ctx.userId }, { range });
    if (structured.campaigns.length === 0) return { kind: "text", text: `No leads ${range.label} to break down by campaign performance.`, dateRange: range, structured };
    const best = [...structured.campaigns].sort((a, b) => b.conversionRatePct - a.conversionRatePct)[0]!;
    const list = structured.campaigns
      .slice(0, 5)
      .map((c) => `• ${c.name} — ${c.leadCount} lead${c.leadCount === 1 ? "" : "s"}, ${c.wonCount} won (${c.conversionRatePct}%)`)
      .join("\n");
    const fallbackText = `${best.name} has the best conversion rate at ${best.conversionRatePct}% ${range.label}.\n\n${list}`;
    return { kind: "text", text: fallbackText, dateRange: range, structured };
  },
};

const sourceLeadCountsTool: RutaTool = {
  name: "sourceLeadCounts",
  description:
    "Breakdown of leads by source (Meta Lead Ads, Website, Referral, Walk-in, ...) over a date range. If the message names no date range, inherits the range from the conversation's current lead-count question (defaulting to today).",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The date-range phrase from the user's message, if any." } },
  },
  // Same "aggregate counts only, no PII" ungated rationale as leadCount/
  // campaignLeadCounts above.
  sessionRole: "drilldown",
  async run(ctx, args) {
    const range = resolveRange(ctx, args.query);
    const db = await getDb();
    const rows = await db
      .select({ source: leads.source, n: sql<number>`count(*)::int` })
      .from(leads)
      .where(and(eq(leads.companyId, ctx.tenantId), gte(leads.metaCreatedAt, range.start), lt(leads.metaCreatedAt, range.end)))
      .groupBy(leads.source);
    const total = rows.reduce((sum, r) => sum + Number(r.n), 0);
    if (total === 0) return { kind: "text", text: `No leads ${range.label} to break down by source.`, dateRange: range };
    const labeled = rows
      .map((r) => ({ label: LEAD_SOURCES.find((s) => s.key === r.source)?.label ?? r.source, n: Number(r.n) }))
      .sort((a, b) => b.n - a.n);
    const top = labeled[0]!;
    const list = labeled.slice(0, 8).map((r) => `• ${r.label} — ${r.n}`).join("\n");
    return { kind: "text", text: `${top.label} led with ${top.n} lead${top.n === 1 ? "" : "s"} ${range.label} (${total} total).\n\n${list}`, dateRange: range };
  },
};

const userLeadCountsTool: RutaTool = {
  name: "userLeadCounts",
  description: "Breakdown of leads by owning salesperson/teammate over a date range - which teammate has the most leads. If the message names no date range, inherits the conversation's current lead-count range (defaulting to today).",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The date-range phrase from the user's message, if any." } },
  },
  // A per-owner breakdown reveals OTHER teammates' individual counts, so
  // (unlike the aggregate-only campaign/source breakdowns above) this
  // requires the same broad-query grant as pendingFollowUps/updateOnX's
  // teammate search - see PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY's own
  // comment. Without it, this quietly falls back to just the asking user's
  // own count rather than refusing outright, same "personal fallback"
  // posture pendingFollowUpsTool already uses.
  // Backed by the get_user_leads CRM tool (crmTools.ts) - it decides the
  // broad-grant fallback itself; this run() only formats whichever shape
  // (self vs company) it comes back with.
  sessionRole: "drilldown",
  async run(ctx, args) {
    const range = resolveRange(ctx, args.query);
    const structured = await get_user_leads({ tenantId: ctx.tenantId, userId: ctx.userId }, { range });

    if (structured.scope === "self") {
      const n = structured.totalCount;
      const fallbackText = `You have ${n} lead${n === 1 ? "" : "s"} ${range.label}.`;
      return { kind: "text", text: fallbackText, dateRange: range, structured };
    }

    if (structured.totalCount === 0) return { kind: "text", text: `No leads ${range.label} to break down by teammate.`, dateRange: range, structured };
    const top = structured.users[0]!;
    const list = structured.users.slice(0, 8).map((r) => `• ${r.name} — ${r.count}`).join("\n");
    const fallbackText = `${top.name} has the most with ${top.count} lead${top.count === 1 ? "" : "s"} ${range.label} (${structured.totalCount} total).\n\n${list}`;
    return { kind: "text", text: fallbackText, dateRange: range, structured };
  },
};

// ---------------------------------------------------------------------------
// Pipeline stage tools - "lead status"/"pipeline summary". Both resolve the
// tenant's OWN stage catalog (a company's stages are industry-template-
// defined, not a fixed enum - see domain/industryTemplates.ts) rather than
// assuming a fixed set of stage keys.
// ---------------------------------------------------------------------------

// companyStages() itself now lives in crmTools.ts (imported above) - shared
// by get_pipeline_summary, get_campaign_performance's won/conversion
// calculation, and leadStatusTool below.

const pipelineSummaryTool: RutaTool = {
  name: "pipelineSummary",
  description: "get_pipeline_summary - full breakdown of leads currently in each pipeline stage (New, Contacted, Qualified, ...) - a live snapshot, not scoped to a date range.",
  parameters: { type: "object", properties: {} },
  // Backed by the get_pipeline_summary CRM tool (crmTools.ts) - it decides
  // the broad-grant fallback (personal vs company-wide) itself.
  async run(ctx) {
    const structured = await get_pipeline_summary({ tenantId: ctx.tenantId, userId: ctx.userId });
    if (structured.totalCount === 0) {
      return { kind: "text", text: structured.scope === "company" ? "No leads in the pipeline yet." : "You have no leads in the pipeline yet.", structured };
    }
    const lines = structured.stages.map((s) => `• ${s.label} — ${s.count}`);
    const fallbackText = `${structured.totalCount} lead${structured.totalCount === 1 ? "" : "s"} in the pipeline${structured.scope === "company" ? "" : " (yours)"}:\n${lines.join("\n")}`;
    return { kind: "text", text: fallbackText, structured };
  },
};

const leadStatusTool: RutaTool = {
  name: "leadStatus",
  description: "How many leads are currently in a specific named pipeline stage (e.g. 'how many leads are qualified', 'leads in won stage'). Falls back to the full pipeline breakdown if no specific stage is named.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "The stage name asked about, if any (e.g. 'qualified', 'won', 'site visit')." } },
  },
  async run(ctx, args) {
    const broad = await hasBroadGrant(ctx.tenantId, ctx.userId);
    const stages = await companyStages(ctx.tenantId);
    const text = (args.query ?? "").toLowerCase();
    const matchedStage = text ? stages.find((s) => text.includes(s.label.toLowerCase()) || text.includes(s.key.toLowerCase())) : undefined;

    if (!matchedStage) return pipelineSummaryTool.run(ctx, args);

    const db = await getDb();
    const scope = broad
      ? and(eq(leads.companyId, ctx.tenantId), eq(leads.pipelineStage, matchedStage.key))
      : and(eq(leads.companyId, ctx.tenantId), eq(leads.ownerId, ctx.userId), eq(leads.pipelineStage, matchedStage.key));
    const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(leads).where(scope);
    const n = row?.n ?? 0;
    return { kind: "text", text: `${n} lead${n === 1 ? "" : "s"}${broad ? "" : " of yours"} in ${matchedStage.label}.` };
  },
};

/**
 * Single source of truth for what RUTA can do - both the fast pattern
 * matcher (matchPattern below) and every AI provider's function-calling
 * schema (see AiProvider's own doc comment in infrastructure/ai/provider.ts)
 * are built from this same list, so the two classification tiers can never
 * drift out of sync with each other.
 */
export const RUTA_TOOLS: RutaTool[] = [
  helpTool,
  followUpsTodayTool,
  followUpCountTool,
  myLeadsTodayTool,
  leadCountTool,
  campaignLeadCountsTool,
  campaignPerformanceTool,
  sourceLeadCountsTool,
  userLeadCountsTool,
  pendingFollowUpsTool,
  leadStatusTool,
  pipelineSummaryTool,
  updateOnXTool,
];

export function rutaToolSchemas(): AiToolSchema[] {
  return RUTA_TOOLS.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

export function getRutaTool(name: string): RutaTool | undefined {
  return RUTA_TOOLS.find((t) => t.name === name);
}

// ---------------------------------------------------------------------------
// Numbered-pick resolution - re-checks authorization itself (audit Finding
// 2c: a resolved LEAD pick previously skipped straight to a reply with no
// re-check, asymmetric with the teammate branch, which always re-checked).
// Options were scoped correctly at search time, but the grant could have
// changed since, or the pick could in principle be replayed - re-checking
// here costs nothing and closes that gap for both kinds symmetrically.
// ---------------------------------------------------------------------------

export async function resolveLeadPick(ctx: RutaToolContext, leadId: string): Promise<string> {
  const db = await getDb();
  const [lead] = await db
    .select({ fullName: leads.fullName, pipelineStage: leads.pipelineStage, nextFollowUpAt: leads.nextFollowUpAt, id: leads.id, ownerId: leads.ownerId })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.companyId, ctx.tenantId)))
    .limit(1);
  if (!lead) return "That lead is no longer available.";

  if (lead.ownerId !== ctx.userId) {
    const broad = await hasBroadGrant(ctx.tenantId, ctx.userId);
    if (!broad) return "You don't have access to that lead.";
  }

  const [lastNote] = await db
    .select({ remarks: leadFollowUps.remarks, createdAt: leadFollowUps.createdAt })
    .from(leadFollowUps)
    .where(eq(leadFollowUps.leadId, lead.id))
    .orderBy(desc(leadFollowUps.createdAt))
    .limit(1);
  const lines = [
    `${lead.fullName ?? "Unnamed lead"}`,
    `Stage: ${lead.pipelineStage}`,
    lead.nextFollowUpAt ? `Next follow-up: ${lead.nextFollowUpAt.toLocaleDateString("en-IN")}` : "No follow-up scheduled",
    lastNote ? `Last note (${lastNote.createdAt.toLocaleDateString("en-IN")}): ${lastNote.remarks}` : "No follow-up notes yet",
  ];
  return lines.join("\n");
}

export async function resolveTeammatePick(ctx: RutaToolContext, teammateUserId: string): Promise<string> {
  // Self-lookup is always allowed; anyone else's activity requires the
  // broad-query grant - checked here (not just at search time) since a
  // resolved numbered pick skips the search step entirely.
  if (teammateUserId !== ctx.userId) {
    const broad = await hasBroadGrant(ctx.tenantId, ctx.userId);
    if (!broad) return "You don't have access to other teammates' activity.";
  }
  const { start, end } = todayRangeInTimezone(ctx.timezone);
  const db = await getDb();
  const [teammate] = await db.select({ fullName: users.fullName }).from(users).where(and(eq(users.id, teammateUserId), eq(users.companyId, ctx.tenantId))).limit(1);
  if (!teammate) return "That teammate is no longer available.";
  const rows = await db
    .select({ id: leadFollowUps.id })
    .from(leadFollowUps)
    .where(and(eq(leadFollowUps.companyId, ctx.tenantId), eq(leadFollowUps.createdBy, teammateUserId), gte(leadFollowUps.createdAt, start), lt(leadFollowUps.createdAt, end)));
  return `${teammate.fullName} logged ${rows.length} follow-up${rows.length === 1 ? "" : "s"} today.`;
}

// ---------------------------------------------------------------------------
// Fast-tier pattern matching - unchanged regex/ordering from the original
// implementation (see rutaAiAssistant.ts's own history), just relocated
// here so it can return tool names directly against RUTA_TOOLS instead of a
// separately-defined Intent union.
// ---------------------------------------------------------------------------

const UPDATE_ON_RE = /^(?:update (?:on|for|about)|status (?:of|on)|what'?s (?:the )?update (?:on|for))\s+(.+)$/i;

export function matchPattern(text: string): { name: string; arguments: Record<string, unknown> } | null {
  const t = text.trim();
  if (!t) return null;
  if (/^help$/i.test(t)) return { name: "help", arguments: {} };

  const updateMatch = UPDATE_ON_RE.exec(t);
  if (updateMatch && updateMatch[1]) return { name: "updateOnX", arguments: { query: updateMatch[1].trim() } };

  // "my leads today" (personal LIST) is checked before every other
  // leads/count rule below, since it's the most specific match.
  if (/\bmy leads?\b/i.test(t) && /\btoday\b/i.test(t)) return { name: "myLeadsToday", arguments: {} };

  // Breakdown/drill-down queries - checked BEFORE the generic leadCount
  // rule below, since a bare "leads" + a date phrase would otherwise also
  // satisfy leadCount's own trigger. Deliberately do NOT require the word
  // "lead" here - a natural follow-up like "Which campaign gave the most?"
  // (see the spec's own conversational example) never says "lead" at all,
  // relying entirely on the conversation's anchor/drill-down context.
  // Performance/conversion - checked BEFORE the bare campaign-breakdown
  // rule right below, since "campaign performance" / "conversion rate by
  // campaign" would otherwise also satisfy that rule's bare "campaign"
  // trigger. Deliberately does not require the word "campaign" either - a
  // bare "what's our conversion rate" is naturally answered as a
  // per-campaign breakdown here, the CRM-native metric this tool reports.
  if (/\b(performance|conversion)/i.test(t)) return { name: "campaignPerformance", arguments: { query: t } };
  if (/\bcampaign/i.test(t)) return { name: "campaignLeadCounts", arguments: { query: t } };
  if (/\bsource/i.test(t)) return { name: "sourceLeadCounts", arguments: { query: t } };
  if (/\b(team|teammate|salesperson|by (user|owner|agent))\b/i.test(t)) return { name: "userLeadCounts", arguments: { query: t } };
  if (/\bpipeline\b/i.test(t) && /(summary|breakdown|overview)/i.test(t)) return { name: "pipelineSummary", arguments: {} };
  if (/^pipeline$/i.test(t)) return { name: "pipelineSummary", arguments: {} };
  if (/\bstatus\b/i.test(t) && /\blead/i.test(t)) return { name: "leadStatus", arguments: { query: t } };
  if (/\bhow many\b/i.test(t) && /\blead/i.test(t) && /\b(new|contacted|qualified|won|lost|site visit)\b/i.test(t)) {
    return { name: "leadStatus", arguments: { query: t } };
  }

  // Lead counts - a plain "how many leads" with no range at all, or with an
  // explicit range ("today", "yesterday", "this week", "between ... and
  // ..."). "leads today" alone still lands here (leadCount defaults its own
  // range to today when its query text names none).
  if (/\blead/i.test(t) && !/\bmy\b/i.test(t) && (containsDateRangePhrase(t) || /(how many|count|number of)/i.test(t) || /^leads?$/i.test(t))) {
    return { name: "leadCount", arguments: { query: t } };
  }

  if (/\bpending\b/i.test(t) && /follow[\s-]?ups?/i.test(t)) return { name: "pendingFollowUps", arguments: {} };
  if (/follow[\s-]?ups?/i.test(t) && /\btoday\b/i.test(t) && /(how many|count|number of)/i.test(t)) return { name: "followUpsToday", arguments: {} };
  // Loose fallbacks for short, common phrasings the specific rules above miss.
  if (/^follow[\s-]?ups?\s*today$/i.test(t)) return { name: "followUpsToday", arguments: {} };
  if (/^pending$/i.test(t)) return { name: "pendingFollowUps", arguments: {} };
  // Generalized follow-up counts - any other follow-up question naming a
  // date range (checked AFTER the today-specific rules above, which stay
  // byte-for-byte unchanged for backward compatibility).
  if (/follow[\s-]?ups?/i.test(t) && containsDateRangePhrase(t)) return { name: "followUpCount", arguments: { query: t } };

  return null;
}
