// Internal WhatsApp Query Bot - RUTA's OWN users (salespeople/admins) asking
// the CRM questions from their phone ("follow-ups today", "update on Rohan
// Shah"). Never customer/lead-facing - no message here is ever sent to a
// lead. Full design: claude/whatsapp-internal-query-bot-flow.md (CRM
// Automation project).
//
// Entry point: handleQueryBotMessages, called from api/webhooks/meta/
// handler.ts AFTER the webhook has already ack'd Meta (same post-ack timing
// as enqueueCapturedWhatsappEvents) for every message
// metaWhatsappEventService.ts's captureWhatsappEvents routed here instead of
// the lead-capture pipeline (a verified linked sender, or a LINK/UNLINK
// command from any sender).
//
// The model boundary (worth stating plainly, since it's the whole point of
// keeping answers trustworthy): the optional Azure OpenAI fallback (used
// ONLY when the fast pattern matcher below finds no match) is sent nothing
// but that one message's raw text, and can only return one of a fixed set
// of function calls + a plain search string - never a query, never an
// answer. Every actual answer is assembled here, in this file, from real
// Drizzle query results. See classifyWithAzureOpenAI's own comment.

import { and, desc, eq, gte, ilike, isNotNull, lt, lte } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { companies, leadFollowUps, leads, users } from "../../infrastructure/db/schema";
import {
  clearPendingQueryContext,
  consumeWhatsappLinkCode,
  deleteUserWhatsappLink,
  getSelectedMetaWhatsappAccount,
  getUserRoleAndPermissions,
  getUserWhatsappLinkByPhone,
  setPendingQueryContext,
} from "../../infrastructure/db/repositories/whatsapp";
import { getActiveMetaConnectionInternal } from "../../infrastructure/db/repositories/metaIntegration";
import { sendWhatsappTextMessage } from "../../infrastructure/meta/graphClient";
import { getEnv } from "../../infrastructure/env";
import { PERMISSIONS } from "../../domain/permissions";

export interface QueryBotInboundMessage {
  tenantId: string;
  fromPhoneNumber: string;
  waMessageId: string;
  messageText: string | null;
}

type UserWhatsappLink = NonNullable<Awaited<ReturnType<typeof getUserWhatsappLinkByPhone>>>;

type Intent = "help" | "followUpsToday" | "myLeadsToday" | "pendingFollowUps" | "updateOnX";

interface IntentCall {
  intent: Intent;
  query?: string; // only set for updateOnX
}

// ---- Entry point ------------------------------------------------------------

/** Never throws - one bad message must never block the rest of the batch
 * (same "log and move on" contract as enqueueCapturedWhatsappEvents). */
export async function handleQueryBotMessages(messages: QueryBotInboundMessage[]): Promise<void> {
  for (const msg of messages) {
    try {
      await handleOneMessage(msg);
    } catch (err) {
      console.error(`[whatsapp-query-bot] Failed to handle message ${msg.waMessageId}:`, err);
    }
  }
}

async function handleOneMessage(msg: QueryBotInboundMessage): Promise<void> {
  const text = (msg.messageText ?? "").trim();

  // LINK is recognized regardless of current link state - by definition a
  // user is not yet linked (or is re-linking from a new phone) when they
  // send it. Everything else below requires an already-verified link.
  const linkMatch = /^link\s+([a-z0-9]{4,8})\s*$/i.exec(text);
  if (linkMatch && linkMatch[1]) return handleLinkCommand(msg, linkMatch[1].toUpperCase());

  const link = await getUserWhatsappLinkByPhone(msg.tenantId, msg.fromPhoneNumber);
  if (!link) return; // Router only sends linked-or-LINK messages here; defensive no-op otherwise.

  const sendCtx = await getSendContext(msg.tenantId);
  if (!sendCtx) {
    console.error(`[whatsapp-query-bot] No sendable WhatsApp account for tenant ${msg.tenantId}; cannot reply.`);
    return;
  }

  if (/^unlink\s*$/i.test(text)) return handleUnlinkCommand(msg, link, sendCtx);

  // Numbered-list disambiguation from a PRIOR message in this same user's
  // thread - resolved before any fresh intent parsing.
  if (link.pendingQueryContext && link.pendingQueryContextExpiresAt && link.pendingQueryContextExpiresAt.getTime() > Date.now()) {
    const pick = resolvePendingSelection(text, link.pendingQueryContext as PendingQueryContext);
    if (pick) {
      await clearPendingQueryContext(msg.tenantId, link.userId);
      return runIntentAndReply(pick, msg, link, sendCtx);
    }
  }

  const patternCall = matchPattern(text);
  if (patternCall) return runIntentAndReply(patternCall, msg, link, sendCtx);

  const classified = await classifyWithAzureOpenAI(text);
  if (classified) return runIntentAndReply(classified, msg, link, sendCtx);

  await reply(sendCtx, msg.fromPhoneNumber, "Didn't catch that — try \"follow-ups today\", \"update on <name>\", or send HELP for the full list.");
}

// ---- LINK / UNLINK ----------------------------------------------------------

async function handleLinkCommand(msg: QueryBotInboundMessage, code: string): Promise<void> {
  const sendCtx = await getSendContext(msg.tenantId);
  if (!sendCtx) return;
  const result = await consumeWhatsappLinkCode(msg.tenantId, code, msg.fromPhoneNumber);
  if (result.ok) {
    await reply(sendCtx, msg.fromPhoneNumber, 'Linked! Try "follow-ups today" or "update on <name>". Send HELP anytime, or UNLINK to disconnect this number.');
    return;
  }
  const message =
    result.reason === "phone_taken"
      ? "This WhatsApp number is already linked to a different account in this workspace. Ask your admin, or unlink it there first."
      : "That code isn't valid or has expired. Generate a new one from Settings → Link WhatsApp.";
  await reply(sendCtx, msg.fromPhoneNumber, message);
}

async function handleUnlinkCommand(msg: QueryBotInboundMessage, link: UserWhatsappLink, sendCtx: SendContext): Promise<void> {
  await deleteUserWhatsappLink(msg.tenantId, link.userId);
  await reply(sendCtx, msg.fromPhoneNumber, "Unlinked. This number will no longer get CRM query replies. Re-link anytime from Settings.");
}

// ---- Pattern matching (fast tier, no external call) -------------------------

const UPDATE_ON_RE = /^(?:update (?:on|for|about)|status (?:of|on)|what'?s (?:the )?update (?:on|for))\s+(.+)$/i;

function matchPattern(text: string): IntentCall | null {
  const t = text.trim();
  if (!t) return null;
  if (/^help$/i.test(t)) return { intent: "help" };

  const updateMatch = UPDATE_ON_RE.exec(t);
  if (updateMatch && updateMatch[1]) return { intent: "updateOnX", query: updateMatch[1].trim() };

  if (/\bmy leads?\b/i.test(t) && /\btoday\b/i.test(t)) return { intent: "myLeadsToday" };
  if (/\bpending\b/i.test(t) && /follow[\s-]?ups?/i.test(t)) return { intent: "pendingFollowUps" };
  if (/follow[\s-]?ups?/i.test(t) && /\btoday\b/i.test(t) && /(how many|count|number of)/i.test(t)) return { intent: "followUpsToday" };
  // Loose fallbacks for short, common phrasings the specific rules above miss.
  if (/^follow[\s-]?ups?\s*today$/i.test(t)) return { intent: "followUpsToday" };
  if (/^pending$/i.test(t)) return { intent: "pendingFollowUps" };

  return null;
}

// ---- Azure OpenAI fallback (feature-flagged, function-calling only) --------
//
// Only reached when matchPattern finds nothing. Sends ONLY the raw message
// text - no database content, no other user's data, nothing from prior
// messages. Uses function-calling against a FIXED 5-function schema; the
// model can select one of these five (or none) and, for updateOnX, extract
// a plain search string - it cannot invent a function, emit SQL, or return
// free text as the answer. If AZURE_OPENAI_ENDPOINT/API_KEY/DEPLOYMENT_NAME
// are not set, this returns null immediately (no error) - matchPattern-only
// is a fully working v1 on its own.
const AZURE_FUNCTIONS = [
  { name: "followUpsToday", description: "How many follow-ups the asking user logged today.", parameters: { type: "object", properties: {} } },
  { name: "myLeadsToday", description: "Leads newly assigned to or created for the asking user today.", parameters: { type: "object", properties: {} } },
  { name: "pendingFollowUps", description: "Leads with a follow-up due today or overdue.", parameters: { type: "object", properties: {} } },
  {
    name: "updateOnX",
    description: "Status/update on a specific lead or teammate, identified by name or phone number.",
    parameters: { type: "object", properties: { query: { type: "string", description: "The name or phone number asked about." } }, required: ["query"] },
  },
  { name: "help", description: "The user is asking what the bot can do.", parameters: { type: "object", properties: {} } },
] as const;

async function classifyWithAzureOpenAI(text: string): Promise<IntentCall | null> {
  const endpoint = getEnv("AZURE_OPENAI_ENDPOINT");
  const apiKey = getEnv("AZURE_OPENAI_API_KEY");
  const deployment = getEnv("AZURE_OPENAI_DEPLOYMENT_NAME");
  if (!endpoint || !apiKey || !deployment) return null; // Not provisioned yet - graceful no-op, never an error.

  try {
    const url = `${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=2024-06-01`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          messages: [
            { role: "system", content: "Classify the user's WhatsApp message into exactly one of the provided functions. If none fit, do not call any function." },
            { role: "user", content: text },
          ],
          tools: AZURE_FUNCTIONS.map((f) => ({ type: "function", function: f })),
          tool_choice: "auto",
          temperature: 0,
          max_tokens: 200,
        }),
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      console.error(`[whatsapp-query-bot] Azure OpenAI classification failed: ${response.status}`);
      return null;
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
    };
    const call = data.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!call?.name) return null;
    const name = AZURE_FUNCTIONS.find((f) => f.name === call.name)?.name;
    if (!name) return null; // Model named something outside the fixed set - ignored, not trusted.
    if (name === "updateOnX") {
      const args = call.arguments ? (JSON.parse(call.arguments) as { query?: string }) : {};
      if (!args.query || typeof args.query !== "string") return null;
      return { intent: "updateOnX", query: args.query.trim() };
    }
    return { intent: name };
  } catch (err) {
    console.error("[whatsapp-query-bot] Azure OpenAI classification error:", err);
    return null; // Fails closed to "didn't catch that" - never blocks the reply.
  }
}

// ---- Query handlers (the only place answers are actually assembled) -------

interface SendContext {
  phoneNumberId: string;
  accessToken: string;
  timezone: string;
}

async function getSendContext(tenantId: string): Promise<SendContext | null> {
  const [account, connection, companyRow] = await Promise.all([
    getSelectedMetaWhatsappAccount(tenantId),
    getActiveMetaConnectionInternal(tenantId),
    getDb().then((db) => db.select({ timezone: companies.timezone }).from(companies).where(eq(companies.id, tenantId)).limit(1)),
  ]);
  if (!account?.phoneNumberId || !connection?.accessToken) return null;
  return { phoneNumberId: account.phoneNumberId, accessToken: connection.accessToken, timezone: companyRow[0]?.timezone ?? "Asia/Kolkata" };
}

async function reply(ctx: SendContext, to: string, body: string): Promise<void> {
  try {
    await sendWhatsappTextMessage(ctx.phoneNumberId, ctx.accessToken, to, body);
  } catch (err) {
    console.error(`[whatsapp-query-bot] Failed to send WhatsApp reply to ${to}:`, err);
  }
}

/** "Today" resolved in the COMPANY's own timezone (companies.timezone),
 * never server UTC or the sender's device time - same source every other
 * date in the app already uses. */
function todayRangeInTimezone(timezone: string): { start: Date; end: Date } {
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
  const offsetMs = wallMs - now.getTime(); // how far ahead of UTC this timezone currently is
  const midnightAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), 0, 0, 0, 0);
  const start = new Date(midnightAsUtc - offsetMs);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

async function runIntentAndReply(call: IntentCall, msg: QueryBotInboundMessage, link: UserWhatsappLink, ctx: SendContext): Promise<void> {
  switch (call.intent) {
    case "help":
      return reply(
        ctx,
        msg.fromPhoneNumber,
        'I can answer:\n• "follow-ups today"\n• "update on <name or phone>"\n• "my leads today"\n• "pending follow-ups"\n\nText UNLINK to disconnect this number.',
      );
    case "followUpsToday":
      return handleFollowUpsToday(msg, link, ctx);
    case "myLeadsToday":
      return handleMyLeadsToday(msg, link, ctx);
    case "pendingFollowUps":
      return handlePendingFollowUps(msg, link, ctx);
    case "updateOnX":
      return handleUpdateOnX(msg, link, ctx, call.query ?? "");
  }
}

async function hasBroadGrant(tenantId: string, userId: string): Promise<boolean> {
  const info = await getUserRoleAndPermissions(tenantId, userId);
  return info?.permissions.includes(PERMISSIONS.WHATSAPP_BOT_BROAD_QUERY) ?? false;
}

async function handleFollowUpsToday(msg: QueryBotInboundMessage, link: UserWhatsappLink, ctx: SendContext): Promise<void> {
  const { start, end } = todayRangeInTimezone(ctx.timezone);
  const db = await getDb();
  const rows = await db
    .select({ id: leadFollowUps.id })
    .from(leadFollowUps)
    .where(and(eq(leadFollowUps.companyId, msg.tenantId), eq(leadFollowUps.createdBy, link.userId), gte(leadFollowUps.createdAt, start), lt(leadFollowUps.createdAt, end)));
  await reply(ctx, msg.fromPhoneNumber, rows.length === 1 ? "You logged 1 follow-up today." : `You logged ${rows.length} follow-ups today.`);
}

async function handleMyLeadsToday(msg: QueryBotInboundMessage, link: UserWhatsappLink, ctx: SendContext): Promise<void> {
  const { start, end } = todayRangeInTimezone(ctx.timezone);
  const db = await getDb();
  const rows = await db
    .select({ fullName: leads.fullName, phoneNumber: leads.phoneNumber })
    .from(leads)
    .where(and(eq(leads.companyId, msg.tenantId), eq(leads.ownerId, link.userId), gte(leads.metaCreatedAt, start), lt(leads.metaCreatedAt, end)))
    .orderBy(desc(leads.metaCreatedAt))
    .limit(10);
  if (rows.length === 0) {
    await reply(ctx, msg.fromPhoneNumber, "No leads assigned to you today.");
    return;
  }
  const list = rows.map((r) => `• ${r.fullName ?? "Unnamed"}${r.phoneNumber ? ` — ${r.phoneNumber}` : ""}`).join("\n");
  await reply(ctx, msg.fromPhoneNumber, `${rows.length} lead${rows.length === 1 ? "" : "s"} today:\n${list}`);
}

async function handlePendingFollowUps(msg: QueryBotInboundMessage, link: UserWhatsappLink, ctx: SendContext): Promise<void> {
  const broad = await hasBroadGrant(msg.tenantId, link.userId);
  const db = await getDb();
  const scope = broad
    ? eq(leads.companyId, msg.tenantId)
    : and(eq(leads.companyId, msg.tenantId), eq(leads.ownerId, link.userId));
  const rows = await db
    .select({ fullName: leads.fullName, phoneNumber: leads.phoneNumber, nextFollowUpAt: leads.nextFollowUpAt })
    .from(leads)
    .where(and(scope, isNotNull(leads.nextFollowUpAt), lte(leads.nextFollowUpAt, new Date())))
    .orderBy(leads.nextFollowUpAt)
    .limit(10);
  if (rows.length === 0) {
    await reply(ctx, msg.fromPhoneNumber, broad ? "No pending follow-ups company-wide." : "No pending follow-ups for you.");
    return;
  }
  const list = rows.map((r) => `• ${r.fullName ?? "Unnamed"}${r.phoneNumber ? ` — ${r.phoneNumber}` : ""} (due ${r.nextFollowUpAt?.toLocaleDateString("en-IN")})`).join("\n");
  await reply(ctx, msg.fromPhoneNumber, `${rows.length} pending follow-up${rows.length === 1 ? "" : "s"}${broad ? " (company-wide)" : ""}:\n${list}`);
}

interface PendingOption {
  kind: "lead" | "teammate";
  id: string;
  label: string;
}
interface PendingQueryContext {
  options: PendingOption[];
}

function resolvePendingSelection(text: string, ctx: PendingQueryContext): IntentCall | null {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > ctx.options.length) return null;
  const picked = ctx.options[n - 1];
  if (!picked) return null;
  return { intent: "updateOnX", query: `__resolved__:${picked.kind}:${picked.id}` };
}

async function handleUpdateOnX(msg: QueryBotInboundMessage, link: UserWhatsappLink, ctx: SendContext, query: string): Promise<void> {
  const db = await getDb();

  // A resolved numbered-list pick skips straight to fetching that one record.
  const resolved = /^__resolved__:(lead|teammate):(.+)$/.exec(query);
  if (resolved && resolved[1] && resolved[2]) {
    const kind = resolved[1];
    const id = resolved[2];
    if (kind === "lead") return replyLeadUpdate(msg, ctx, id);
    return replyTeammateUpdate(msg, link, ctx, id);
  }

  const broad = await hasBroadGrant(msg.tenantId, link.userId);
  const digitsOnly = query.replace(/[^\d]/g, "");
  const leadScope = broad ? eq(leads.companyId, msg.tenantId) : and(eq(leads.companyId, msg.tenantId), eq(leads.ownerId, link.userId));
  const leadMatches = await db
    .select({ id: leads.id, fullName: leads.fullName, phoneNumber: leads.phoneNumber })
    .from(leads)
    .where(and(leadScope, digitsOnly.length >= 6 ? ilike(leads.phoneNumber, `%${digitsOnly}%`) : ilike(leads.fullName, `%${query}%`)))
    .limit(5);

  const teammateMatches = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .where(and(eq(users.companyId, msg.tenantId), eq(users.status, "active"), ilike(users.fullName, `%${query}%`)))
    .limit(5);

  const options: PendingOption[] = [
    ...leadMatches.map((l) => ({ kind: "lead" as const, id: l.id, label: `${l.fullName ?? "Unnamed"} — lead${l.phoneNumber ? `, ${l.phoneNumber}` : ""}` })),
    ...teammateMatches.map((u) => ({ kind: "teammate" as const, id: u.id, label: `${u.fullName} — teammate` })),
  ];

  if (options.length === 0) {
    await reply(ctx, msg.fromPhoneNumber, `No lead or teammate found matching "${query}".`);
    return;
  }
  if (options.length === 1) {
    const only = options[0];
    if (only) return only.kind === "lead" ? replyLeadUpdate(msg, ctx, only.id) : replyTeammateUpdate(msg, link, ctx, only.id);
  }
  const numbered = options.map((o, i) => `${i + 1}. ${o.label}`).join("\n");
  await setPendingQueryContext(msg.tenantId, link.userId, { options } satisfies PendingQueryContext);
  await reply(ctx, msg.fromPhoneNumber, `Multiple matches — reply with a number:\n${numbered}`);
}

async function replyLeadUpdate(msg: QueryBotInboundMessage, ctx: SendContext, leadId: string): Promise<void> {
  const db = await getDb();
  const [lead] = await db
    .select({ fullName: leads.fullName, pipelineStage: leads.pipelineStage, nextFollowUpAt: leads.nextFollowUpAt, id: leads.id })
    .from(leads)
    .where(and(eq(leads.id, leadId), eq(leads.companyId, msg.tenantId)))
    .limit(1);
  if (!lead) {
    await reply(ctx, msg.fromPhoneNumber, "That lead is no longer available.");
    return;
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
  await reply(ctx, msg.fromPhoneNumber, lines.join("\n"));
}

async function replyTeammateUpdate(msg: QueryBotInboundMessage, link: UserWhatsappLink, ctx: SendContext, teammateUserId: string): Promise<void> {
  // Self-lookup is always allowed; anyone else's activity requires the
  // broad-query grant - checked here (not just at search time) since a
  // resolved numbered pick skips the search step entirely.
  if (teammateUserId !== link.userId) {
    const broad = await hasBroadGrant(msg.tenantId, link.userId);
    if (!broad) {
      await reply(ctx, msg.fromPhoneNumber, "You don't have access to other teammates' activity.");
      return;
    }
  }
  const { start, end } = todayRangeInTimezone(ctx.timezone);
  const db = await getDb();
  const [teammate] = await db.select({ fullName: users.fullName }).from(users).where(and(eq(users.id, teammateUserId), eq(users.companyId, msg.tenantId))).limit(1);
  if (!teammate) {
    await reply(ctx, msg.fromPhoneNumber, "That teammate is no longer available.");
    return;
  }
  const rows = await db
    .select({ id: leadFollowUps.id })
    .from(leadFollowUps)
    .where(and(eq(leadFollowUps.companyId, msg.tenantId), eq(leadFollowUps.createdBy, teammateUserId), gte(leadFollowUps.createdAt, start), lt(leadFollowUps.createdAt, end)));
  await reply(ctx, msg.fromPhoneNumber, `${teammate.fullName} logged ${rows.length} follow-up${rows.length === 1 ? "" : "s"} today.`);
}
