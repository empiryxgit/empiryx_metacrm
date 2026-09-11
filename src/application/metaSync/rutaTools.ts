// Structured CRM tools for the RUTA AI Assistant - the one place both
// classification tiers (the fast regex pattern matcher below, and the AI
// provider fallback in src/infrastructure/ai/provider.ts) draw their tool
// names/descriptions/parameter schemas from, and the one place every tool's
// actual Drizzle query + reply text is assembled. Before this file existed
// the pattern matcher's five-ish regex branches and the AI provider's own
// fixed function array were two separately hand-maintained lists that had
// to be kept in sync by hand - RUTA_TOOLS below is now the single source of
// truth for "what RUTA can do," so adding a tool means adding one entry
// here, not remembering to update two places.
//
// Every tool's run() is handed a RutaToolContext (tenantId/userId/timezone
// only - never a raw request, never another user's data) and is entirely
// responsible for its OWN authorization scoping - there is no single
// uniform "requires permission X" gate here, because the actual rule varies
// per tool (see hasBroadGrant's own comment, and each tool's individual
// comment below for exactly what it does and doesn't require the grant
// for). This mirrors, unchanged, the authorization behavior already
// audited and fixed in this codebase (Findings 2a/2b/2c) - this file is a
// reorganization of that logic into named, independently testable units,
// not a behavior change.

import { and, desc, eq, gte, ilike, isNotNull, lt, lte } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { leadFollowUps, leads, users } from "../../infrastructure/db/schema";
import { getUserRoleAndPermissions } from "../../infrastructure/db/repositories/whatsapp";
import { PERMISSIONS } from "../../domain/permissions";
import type { AiToolSchema } from "../../infrastructure/ai/provider";

export interface RutaToolContext {
  tenantId: string;
  userId: string;
  /** "Today" resolution timezone - the company's own (see
   * todayRangeInTimezone in rutaAiAssistant.ts), never server UTC or the
   * sender's device time. */
  timezone: string;
}

export interface PendingOption {
  kind: "lead" | "teammate";
  id: string;
  label: string;
}

/** Multi-turn disambiguation state, persisted on userWhatsappLinks.pendingQueryContext
 * (see src/application/metaSync/rutaAiAssistant.ts's session handling) when
 * a search matches more than one lead/teammate - scoped per (tenantId,
 * userId) by that column's own primary lookup key, so two different users'
 * in-flight disambiguations can never collide or overwrite each other, even
 * mid-conversation, even for the same tenant. */
export interface PendingQueryContext {
  options: PendingOption[];
}

export type RutaToolResult =
  | { kind: "text"; text: string }
  | { kind: "disambiguate"; text: string; options: PendingOption[] };

export interface RutaTool {
  name: string;
  description: string;
  parameters: AiToolSchema["parameters"];
  /** Executes the tool. `args.query` is only ever populated for updateOnX
   * (the one tool that takes a free-text argument); every other tool
   * ignores `args` entirely - its answer depends only on ctx. */
  run(ctx: RutaToolContext, args: { query?: string }): Promise<RutaToolResult>;
}

/**
 * Whether this user's role grants company/branch-wide RUTA queries against
 * OTHER teammates' data - see PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY's
 * own comment in domain/permissions.ts for the full "deliberately off by
 * default, opt-in only, WhatsApp is a weaker identity channel" rationale.
 *
 * Important asymmetry with the web app: getUserRoleAndPermissions reads the
 * role's STORED `permissions` column directly - unlike
 * src/application/auth.ts's effectivePermissions(), which live-recomputes a
 * full-access role's permission set at JWT-issue time (see fixedRoles.ts's
 * fullAccessPermissionsForRoleName), this bot has no session/JWT to read,
 * only the verified phone->userId binding, so it has no live-recompute step
 * to go through. This is exactly why audit Finding 2a mattered: it's the
 * STORED value this function reads that must never carry
 * RUTA_AI_ASSISTANT_BROAD_QUERY for an auto-seeded system role. That's now
 * enforced going forward at seed time (fixedRoles.ts's BASE_ALL_PERMISSIONS,
 * tenancy.ts's createOwnerRole) plus a one-time cleanup migration
 * (drizzle/0036_fix_ruta_broad_query_permission_seeding.sql) for roles
 * already seeded before that fix - there is no runtime safety net here
 * beyond that stored value being correct.
 */
export async function hasBroadGrant(tenantId: string, userId: string): Promise<boolean> {
  const info = await getUserRoleAndPermissions(tenantId, userId);
  return info?.permissions.includes(PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY) ?? false;
}

/** "Today" resolved in the COMPANY's own timezone - duplicated here (rather
 * than imported) only to keep this file's public surface independent of
 * rutaAiAssistant.ts; both copies must stay identical, which is why this is
 * the ONLY place either file implements it - rutaAiAssistant.ts imports this
 * one instead of keeping its own. */
export function todayRangeInTimezone(timezone: string): { start: Date; end: Date } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = wallMs - now.getTime();
  const midnightAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0, 0);
  const start = new Date(midnightAsUtc - offsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
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
      text: 'I can answer things like:\n• "how many leads did we get today"\n• "follow-ups today"\n• "update on <name or phone>"\n• "my leads today"\n• "pending follow-ups"',
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

const leadsTodayTool: RutaTool = {
  name: "leadsToday",
  description: "Total number of leads the company received today, company-wide - not just the asking user's own.",
  parameters: { type: "object", properties: {} },
  // Company-wide COUNT ONLY (no names/phone numbers) - deliberately ungated
  // (no broad-query permission check): an aggregate number carries no
  // per-lead PII, unlike the detail lists below, which DO require the
  // grant. See PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY's own comment.
  async run(ctx) {
    const { start, end } = todayRangeInTimezone(ctx.timezone);
    const db = await getDb();
    const rows = await db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.companyId, ctx.tenantId), gte(leads.metaCreatedAt, start), lt(leads.metaCreatedAt, end)));
    return { kind: "text", text: rows.length === 1 ? "You received 1 lead today." : `You received ${rows.length} leads today.` };
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

/**
 * Single source of truth for what RUTA can do - both the fast pattern
 * matcher (matchPattern below) and every AI provider's function-calling
 * schema (see AiProvider's own doc comment in infrastructure/ai/provider.ts)
 * are built from this same list, so the two classification tiers can never
 * drift out of sync with each other.
 */
export const RUTA_TOOLS: RutaTool[] = [helpTool, followUpsTodayTool, myLeadsTodayTool, leadsTodayTool, pendingFollowUpsTool, updateOnXTool];

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

  // "my leads today" (personal) is checked BEFORE the generic company-wide
  // "leads today" rule below, since it's the more specific match.
  if (/\bmy leads?\b/i.test(t) && /\btoday\b/i.test(t)) return { name: "myLeadsToday", arguments: {} };
  if (/\bleads?\b/i.test(t) && /\btoday\b/i.test(t) && !/\bmy\b/i.test(t)) return { name: "leadsToday", arguments: {} };
  if (/\bpending\b/i.test(t) && /follow[\s-]?ups?/i.test(t)) return { name: "pendingFollowUps", arguments: {} };
  if (/follow[\s-]?ups?/i.test(t) && /\btoday\b/i.test(t) && /(how many|count|number of)/i.test(t)) return { name: "followUpsToday", arguments: {} };
  // Loose fallbacks for short, common phrasings the specific rules above miss.
  if (/^follow[\s-]?ups?\s*today$/i.test(t)) return { name: "followUpsToday", arguments: {} };
  if (/^pending$/i.test(t)) return { name: "pendingFollowUps", arguments: {} };

  return null;
}
