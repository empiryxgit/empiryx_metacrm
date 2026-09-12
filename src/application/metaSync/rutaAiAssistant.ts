// RUTA AI Assistant - the AI orchestration layer for RUTA's OWN users
// (salespeople/admins) talking to RUTA about their authorized CRM/business
// data over WhatsApp ("How many leads did we get today?", "update on Rohan
// Shah"). Natural language only - no slash commands. Never customer/lead-
// facing: no message here is ever sent to a lead, and this never touches
// the lead-capture pipeline. Full design: claude/whatsapp-internal-query-
// bot-flow.md (CRM Automation project).
//
// This file is the ORCHESTRATOR - it owns the exact pipeline every inbound
// message goes through, end to end, and delegates each stage to its own
// module rather than inlining everything:
//
//   WhatsApp -> Webhook -> Identity/Auth -> AI Orchestrator (this file) ->
//   Intent/Tool Selection -> Authorization -> CRM Tool -> DB -> Structured
//   Result -> LLM -> WhatsApp
//
// On every request this pipeline resolves WhatsApp identity -> user_id ->
// tenant_id -> role -> permissions -> data scope, ENTIRELY in this
// backend/services layer - the AI provider (steps 4 and 9 below) only ever
// sees raw message text, a fixed tool schema, or an already-computed
// structured result; never a tenantId/userId/permission, and never decides
// what a user is authorized to see, and NEVER runs a database query itself,
// directly or indirectly (see AiProvider's own doc comment in
// infrastructure/ai/provider.ts for that exact boundary - it has no DB
// client, no credential, and no query function anywhere in its interface).
// Authorization is never delegated to, or trusted from, the LLM:
//   1. WhatsApp -> RUTA user mapping + tenant identification - resolved
//      upstream, before this file is even reached (see
//      metaWhatsappEventService.ts's isRutaAssistantMessage /
//      getUserWhatsappLinkByPhone) - by the time handleOneMessage runs, the
//      sender is already a verified linked user of a known tenant. The SAME
//      raw phone number can be linked to two DIFFERENT users in two
//      DIFFERENT tenants (userWhatsappLinks' unique index is
//      (tenantId, phoneNumber), not phoneNumber alone) - which user/tenant
//      a message resolves to depends on the tenantId the webhook layer
//      already attached (from the tenant's OWN selected phone_number_id),
//      never guessed from the phone number in isolation.
//   1a. Webhook duplicate/retry handling - tryClaimRutaMessageId
//      (src/infrastructure/cache/redis.ts) claims (tenantId, waMessageId)
//      before anything else runs; a redelivered/retried webhook call for a
//      message already claimed is a silent no-op (logged, no reply, no
//      double DB work) - see that function's own comment for why Redis is
//      the real idempotency mechanism here, not just a fast-path.
//   2. Rate limiting - src/infrastructure/cache/redis.ts's checkRateLimit,
//      applied per-user AND per-tenant before anything else runs.
//   3. Conversation/session management (Phase F: RUTA Conversation
//      Context) - every inbound message resolves/creates its
//      conversation_id first (getOrCreateActiveConversation,
//      infrastructure/db/repositories/rutaConversation.ts: the most
//      recent still-active ruta_conversations row for this (tenantId,
//      userId), or a fresh one once the last one has gone idle - see that
//      file's CONVERSATION_IDLE_TIMEOUT_MINUTES). Session state (numbered-
//      list disambiguation, and the date-range "anchor" for conversational
//      follow-ups) then lives on THAT conversation's own TTL-bound
//      pendingContext column, scoped by (tenantId, userId, conversationId)
//      together - never conversationId alone - so two users' or two
//      tenants' in-flight conversations can never collide or be crossed,
//      even by a bug that passed the wrong id (see rutaConversation.ts's
//      own header, and rutaTools.ts's PendingQueryContext doc comment for
//      the shape of the value itself, unchanged from before this phase).
//      Every resolved turn is ALSO appended to that conversation's own
//      compact, bounded history (ruta_conversation_turns,
//      MAX_TURNS_PER_CONVERSATION) - a real, separate-from-CRM-data
//      conversation record, but one this pipeline never reads back into
//      an AI prompt (see step 4/7 below and provider.ts's own boundary
//      comment) - resolution itself still runs off the O(1) pendingContext
//      pointer, not a history scan. There is no in-memory/global
//      conversation state anywhere in this pipeline.
//   4. Classification - fast-tier regex pattern matching, then (only on a
//      miss) the AI provider abstraction (src/infrastructure/ai/
//      provider.ts) as a fallback. Both draw from the SAME tool schema
//      (src/application/metaSync/rutaTools.ts's RUTA_TOOLS). The provider
//      only ever returns a tool NAME + free-text arguments - it never runs
//      a query and never sees a permission or a data scope.
//   5. Authorization - each tool in rutaTools.ts enforces its own scoping
//      rule against the VERIFIED tenantId/userId this file resolved in step
//      1, never anything the AI provider returned; this file never
//      second-guesses or bypasses a tool's own check. For the six tools
//      backed by a NAMED CRM tool (see below), the authorization decision
//      itself is made INSIDE that CRM tool (crmTools.ts's hasBroadGrant),
//      not by rutaTools.ts or this file - a single, non-bypassable place
//      per rule.
//   6. CRM Tool -> DB -> Structured Result - src/application/metaSync/
//      crmTools.ts's six typed, validated, self-authorizing functions
//      (get_lead_count / get_campaign_leads / get_campaign_performance /
//      get_user_leads / get_pipeline_summary / get_followup_summary), each
//      called by its matching rutaTools.ts tool's run(). Real Drizzle query
//      results only, every query scoped by tenantId (and, for personal
//      tools, userId) at the SQL WHERE clause - never filtered client-side
//      after a wider fetch - returning a plain JSON structured result, not
//      reply text. Every other tool in rutaTools.ts (help, myLeadsToday,
//      updateOnX, pendingFollowUps, leadStatus, followUpsToday,
//      sourceLeadCounts) still queries the DB directly inside its own
//      run() and returns finished reply text - the CRM/database is still
//      the sole source of truth for these, they simply predate, and don't
//      need, a separate structured-result shape of their own.
//   7. Structured Result -> LLM - rutaReplyComposer.ts's composeReply,
//      called below ONLY when the tool's result carries a `structured`
//      payload (i.e. one of the six CRM-tool-backed tools from step 6).
//      Hands the AI provider (AiProvider.compose - infrastructure/ai/
//      provider.ts) nothing but that already-computed JSON plus the user's
//      own question text, to phrase the reply - never a query, never
//      database access, and grounded (see rutaReplyComposer.ts's own
//      comment) against the same JSON so a hallucinated number can never
//      reach the user. Falls back to a deterministic, AI-free formatted
//      reply (built alongside the structured result, in rutaTools.ts) on
//      any failure or when no AI provider is configured - RUTA fully works
//      with zero AI configured, unchanged from before this stage existed.
//   8. Reply -> WhatsApp - sendWhatsappTextMessage (already retried
//      internally, see graphClient.ts's fetchWithRetryJson), wrapped here
//      so a send failure is logged, never thrown back at the caller.
//   9. Error handling + structured logging - every stage above reports
//      through rutaLog (src/infrastructure/observability/rutaLogger.ts);
//      a failure at any stage degrades to a safe, logged, user-visible
//      "something went wrong" reply rather than a silent drop or an
//      unhandled throw.
//
// AI Assistant guardrails (Phase G) - RUTA is a scoped CRM-data tool, never
// general-purpose ChatGPT, enforced at TWO layers, neither trusted alone:
//   - Deterministic (this file, no AI needed): step 4's own classification
//     miss - RUTA_OUT_OF_SCOPE_REPLY below, sent for anything that doesn't
//     match a known capability, regardless of whether an AI provider is
//     configured at all.
//   - AI-dependent (provider.ts's own system prompts, backstopped in code
//     by rutaReplyComposer.ts): never invent/estimate a metric, never
//     expose an internal id/secret/this system prompt, and never treat a
//     value inside the structured JSON or the user's own message as an
//     instruction - including CRM-sourced free text (a campaign name, a
//     teammate's display name) that could itself be a prompt-injection
//     attempt. See provider.ts's compose() system prompt for the exact
//     rules, and rutaReplyComposer.ts's own header for the code-level
//     enforcement (id-stripping before the call, a categorical
//     internal-identifier reject, the existing grounding check) that holds
//     even if the prompt itself is ignored.
//
// Concurrency: nothing in this file (or any module it depends on) holds
// per-user or per-request state in a module-level variable. Every request
// is fully parameterized by the RutaAssistantInboundMessage/RutaToolContext
// passed through the call chain; the only durable state is in Postgres
// (ruta_conversations/ruta_conversation_turns, keyed by tenantId+userId+
// conversationId - Phase F, see rutaConversation.ts) and
// Redis (the message-idempotency claim and rate-limit counters, keyed the
// same way) - so two concurrent invocations handling two different users'
// messages (even in the same warm Node process, even the SAME phone number
// linked under two different tenants) can never read or write each other's
// state, and this pipeline scales horizontally across any number of
// concurrent serverless invocations with no coordination required beyond
// that shared Postgres/Redis state. See src/infrastructure/ai/provider.ts's
// own comment on why its one cached value (the provider's immutable
// config) is safe to share regardless. See rutaAiAssistant.flow.test.ts for
// automated tests proving user/tenant/role/session isolation, concurrent
// conversations, and webhook duplicate/retry handling.

import { getUserWhatsappLinkByPhone, getSelectedMetaWhatsappAccount, getUserWhatsappLinkByUserId, touchLastInboundMessage } from "../../infrastructure/db/repositories/whatsapp";
import { getActiveMetaConnectionInternal } from "../../infrastructure/db/repositories/metaIntegration";
import { clearPendingContext, getOrCreateActiveConversation, getPendingContext, recordConversationTurn, setPendingContext } from "../../infrastructure/db/repositories/rutaConversation";
import { getDb } from "../../infrastructure/db/client";
import { companies } from "../../infrastructure/db/schema";
import { eq } from "drizzle-orm";
import { sendWhatsappTextMessage } from "../../infrastructure/meta/graphClient";
import { checkRateLimit, tryClaimRutaMessageId } from "../../infrastructure/cache/redis";
import { rutaLog } from "../../infrastructure/observability/rutaLogger";
import { getAiProvider } from "../../infrastructure/ai/provider";
import { composeReply } from "./rutaReplyComposer";
import { matchBareDateFollowUp } from "./rutaDateRange";
import {
  rutaToolSchemas,
  getRutaTool,
  matchPattern,
  resolveLeadPick,
  resolveTeammatePick,
  type DateRange,
  type PendingOption,
  type PendingQueryContext,
  type RutaToolContext,
  type RutaToolResult,
} from "./rutaTools";

export interface RutaAssistantInboundMessage {
  tenantId: string;
  fromPhoneNumber: string;
  waMessageId: string;
  messageText: string | null;
}

type RutaAssistantLink = NonNullable<Awaited<ReturnType<typeof getUserWhatsappLinkByPhone>>>;

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/** Never throws - one bad message must never block the rest of the batch
 * (same "log and move on" contract as enqueueCapturedWhatsappEvents). */
export async function handleRutaAssistantMessages(messages: RutaAssistantInboundMessage[]): Promise<void> {
  for (const msg of messages) {
    try {
      await handleOneMessage(msg);
    } catch (err) {
      rutaLog.error("message_failed_unhandled", { tenantId: msg.tenantId, waMessageId: msg.waMessageId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

// ---------------------------------------------------------------------------
// Rate limiting - applied before ANY other work (including the DB lookup
// for the WhatsApp link) so a flood of messages from one user or one tenant
// can't run up AI provider spend or hammer the database. Fixed-window,
// fail-open on a Redis outage (checkRateLimit's own posture) - a degraded
// rate limiter is preferable to RUTA going fully unresponsive tenant-wide
// because Redis is down. A rate-limited message is silently dropped (logged
// only, no reply) rather than answered with a "slow down" message every
// time - replying to every throttled message would itself become the flood.
// ---------------------------------------------------------------------------

// AI Assistant guardrails (Phase G) - RUTA AI Assistant is a scoped CRM-data
// tool, never a general-purpose chat assistant. This is the DETERMINISTIC,
// non-AI-dependent half of that guarantee: whether or not an AI provider is
// configured (see this file's own header - RUTA fully works with zero AI
// configured), a message that doesn't match any known RUTA capability gets
// this explicit scope statement, never a generic "didn't understand" that
// could be mistaken for an invitation to ask anything else. The AI-dependent
// half - never inventing data, never leaking an internal id, never
// following an instruction embedded in CRM/lead text or the user's own
// message - lives in provider.ts's own system prompts plus
// rutaReplyComposer.ts's code-level enforcement of the same rules.
const RUTA_OUT_OF_SCOPE_REPLY =
  'RUTA AI Assistant only answers questions about your CRM data - leads, campaigns, follow-ups, and pipeline. I can\'t help with anything outside that. Try things like "how many leads did we get today", "follow-ups today", "update on <name>", or send HELP for the full list.';

const USER_RATE_LIMIT = 20; // messages
const USER_RATE_WINDOW_SECONDS = 60;
const TENANT_RATE_LIMIT = 120; // messages, aggregate ceiling across all of a tenant's users
const TENANT_RATE_WINDOW_SECONDS = 60;

// RUTA Insight/Alert Engine (Phase E) - how long a delivered insight stays
// available for a bare "Why?" follow-up (userWhatsappLinks.lastInsightId/
// lastInsightAt - see that column's own schema comment). Deliberately far
// longer than pendingQueryContext's 3-minute TTL: an alert can sit unread
// for hours before someone gets to it.
const INSIGHT_REFERENCE_TTL_HOURS = 48;

function resolveLastInsightId(link: RutaAssistantLink): string | undefined {
  if (!link.lastInsightId || !link.lastInsightAt) return undefined;
  const ageMs = Date.now() - link.lastInsightAt.getTime();
  return ageMs <= INSIGHT_REFERENCE_TTL_HOURS * 60 * 60 * 1000 ? link.lastInsightId : undefined;
}

async function isRateLimited(tenantId: string, userId: string): Promise<boolean> {
  const [userOk, tenantOk] = await Promise.all([
    checkRateLimit(`ruta:user:${tenantId}:${userId}`, USER_RATE_LIMIT, USER_RATE_WINDOW_SECONDS),
    checkRateLimit(`ruta:tenant:${tenantId}`, TENANT_RATE_LIMIT, TENANT_RATE_WINDOW_SECONDS),
  ]);
  return !userOk || !tenantOk;
}

// ---------------------------------------------------------------------------
// Per-message pipeline.
// ---------------------------------------------------------------------------

async function handleOneMessage(msg: RutaAssistantInboundMessage): Promise<void> {
  const text = (msg.messageText ?? "").trim();

  // Webhook duplicate/retry handling - claimed FIRST, before any DB lookup
  // or rate-limit consumption, so a redelivered webhook call for a message
  // already handled costs nothing beyond one Redis round trip and never
  // produces a second reply. See tryClaimRutaMessageId's own comment for
  // why this (not a durable Postgres row) is the real idempotency
  // mechanism for RUTA messages specifically.
  if (!(await tryClaimRutaMessageId(msg.tenantId, msg.waMessageId))) {
    rutaLog.warn("duplicate_message_skipped", { tenantId: msg.tenantId, waMessageId: msg.waMessageId });
    return;
  }

  // WhatsApp -> RUTA user mapping. No LINK/UNLINK commands - RUTA AI
  // Assistant is mandatory and provisioned automatically from the user's
  // profile phone number (see api/admin/users/handler.ts), so a sender is
  // either already a verified active user or this message never reaches
  // this function at all (see metaWhatsappEventService.ts's
  // isRutaAssistantMessage router check).
  const link = await getUserWhatsappLinkByPhone(msg.tenantId, msg.fromPhoneNumber);
  if (!link) return; // Defensive no-op - the router should never send an unlinked number here.

  // RUTA Insight/Alert Engine (Phase E) - stamps this message as proof the
  // recipient is currently inside Meta's 24h customer-service window, so a
  // later PROACTIVE alert (notificationDelivery.ts) knows a free-form send
  // is still safe. Best-effort: a failure here must never block the reply
  // pipeline below - a stale lastInboundMessageAt only ever makes a future
  // alert delivery fail closed (see that file's own comment), it can't
  // corrupt anything.
  try {
    await touchLastInboundMessage(msg.tenantId, link.userId);
  } catch (err) {
    rutaLog.error("touch_last_inbound_failed", { tenantId: msg.tenantId, userId: link.userId, error: err instanceof Error ? err.message : String(err) });
  }

  if (await isRateLimited(msg.tenantId, link.userId)) {
    rutaLog.warn("rate_limited", { tenantId: msg.tenantId, userId: link.userId, waMessageId: msg.waMessageId });
    return;
  }

  const sendCtx = await getSendContext(msg.tenantId);
  if (!sendCtx) {
    rutaLog.error("no_send_context", { tenantId: msg.tenantId, userId: link.userId, waMessageId: msg.waMessageId });
    return;
  }

  // Session/conversation management (Phase F) - resolve/create this
  // message's conversation_id FIRST (see rutaConversation.ts's own header
  // for why a fresh id is started once the previous one has gone idle),
  // then read whatever a PRIOR message in THIS conversation left pending
  // on its pendingContext column - scoped by (tenantId, userId,
  // conversationId) together, so this can never read another user's or
  // tenant's state even by accident:
  //   - a numbered-list disambiguation, resolved below before any fresh
  //     classification (unchanged from before conversational follow-ups);
  //   - an ANCHOR date range from the last leadCount/followUpCount-style
  //     question, made available to this turn's tools as
  //     ctx.defaultDateRange (for a drill-down question that names no date
  //     of its own) and consulted by the bare-date-follow-up check below
  //     ("What about yesterday?").
  // This resolution step ALWAYS runs to completion - producing a concrete
  // tool name and concrete arguments - before anything below it touches
  // the database for real data: authorization (hasBroadGrant, inside each
  // CRM tool's own run()/crmTools.ts) is only ever evaluated against that
  // FINAL, resolved query, using the verified tenantId/userId this
  // function already established in step 1 above - never against the raw,
  // pre-resolution message text, and never trusting anything the AI
  // provider or the conversation context itself claims about permissions.
  const conversation = await getOrCreateActiveConversation(msg.tenantId, link.userId, msg.fromPhoneNumber);
  const pending = (await getPendingContext(msg.tenantId, link.userId, conversation.id)) as PendingQueryContext | null;

  if (pending?.kind === "disambiguation") {
    const picked = resolvePendingSelection(text, pending);
    if (picked) {
      await clearPendingContext(msg.tenantId, link.userId, conversation.id);
      const toolCtx: RutaToolContext = { tenantId: msg.tenantId, userId: link.userId, timezone: sendCtx.timezone, lastInsightId: resolveLastInsightId(link) };
      const replyText = await runResolvedPick(toolCtx, picked.kind, picked.id);
      await recordConversationTurn(msg.tenantId, link.userId, conversation.id, { toolName: "resolvedPick", userMessageText: text });
      await sendReply(sendCtx, msg, link, "resolvedPick", replyText);
      return;
    }
  }

  const anchor = pending?.kind === "anchor" ? pending : null;
  const toolCtx: RutaToolContext = {
    tenantId: msg.tenantId,
    userId: link.userId,
    timezone: sendCtx.timezone,
    defaultDateRange: anchor ? decodeAnchorRange(anchor.range) : undefined,
    lastInsightId: resolveLastInsightId(link),
  };

  // Classification - fast pattern matcher first, AI provider only on a
  // miss. Both draw from the same RUTA_TOOLS schema (rutaTools.ts).
  let call = matchPattern(text) ?? (await classifyWithAiProvider(text, msg));

  // Bare date-only follow-up ("What about yesterday?", "and last week?") -
  // only consulted when normal classification found NOTHING and there's a
  // live anchor to re-run; see rutaDateRange.ts's matchBareDateFollowUp for
  // exactly how strict this match is (it must be the ENTIRE message, not a
  // fragment of some other, already-classifiable question). Re-invokes the
  // anchor's own tool with the raw text as its query, which that tool's own
  // resolveRange() will re-parse into the new range - deliberately not
  // synthesized here, so there is exactly one place each tool's date-phrase
  // parsing lives.
  if (!call && anchor) {
    const bareDate = matchBareDateFollowUp(text, sendCtx.timezone);
    if (bareDate) call = { name: anchor.tool, arguments: { query: text } };
  }

  if (!call) {
    await sendReply(sendCtx, msg, link, "unmatched", RUTA_OUT_OF_SCOPE_REPLY);
    return;
  }

  const tool = getRutaTool(call.name);
  if (!tool) {
    // A provider naming something outside the fixed set is already
    // filtered out in provider.ts, but this file never trusts that alone -
    // re-validated here too before anything runs.
    rutaLog.error("unknown_tool", { tenantId: msg.tenantId, userId: link.userId, tool: call.name });
    await sendReply(sendCtx, msg, link, "unmatched", RUTA_OUT_OF_SCOPE_REPLY);
    return;
  }

  let result: RutaToolResult;
  try {
    result = await tool.run(toolCtx, { query: typeof call.arguments.query === "string" ? call.arguments.query : undefined });
  } catch (err) {
    // Error handling: a tool failure (a DB error, a bad query) must never
    // leave the user with silence - log the real error, reply with a safe
    // generic message.
    rutaLog.error("tool_failed", { tenantId: msg.tenantId, userId: link.userId, tool: tool.name, error: err instanceof Error ? err.message : String(err) });
    await sendReply(sendCtx, msg, link, tool.name, "Something went wrong looking that up - please try again in a moment.");
    return;
  }

  // Session state for the NEXT turn - see RutaTool.sessionRole's own
  // comment (rutaTools.ts) for the full anchor/drilldown contract. Written
  // to THIS conversation's pendingContext (Phase F), scoped by (tenantId,
  // userId, conversation.id) together.
  if (result.kind === "disambiguate") {
    await setPendingContext(msg.tenantId, link.userId, conversation.id, { kind: "disambiguation", options: result.options } satisfies PendingQueryContext);
  } else if (tool.sessionRole === "anchor" && result.dateRange) {
    await setPendingContext(msg.tenantId, link.userId, conversation.id, {
      kind: "anchor",
      tool: tool.name,
      range: { startIso: result.dateRange.start.toISOString(), endIso: result.dateRange.end.toISOString(), label: result.dateRange.label },
    } satisfies PendingQueryContext);
  } else if (tool.sessionRole !== "drilldown" && pending) {
    // An ordinary, topic-changing reply - clear any leftover anchor/
    // disambiguation state rather than letting a stale one linger for up to
    // its full TTL. Drill-down replies deliberately skip this so the
    // anchor they just consumed survives for a LATER bare-date follow-up
    // (the spec's own example: leads today -> campaign breakdown -> "what
    // about yesterday" must still re-run the ORIGINAL lead-count anchor).
    await clearPendingContext(msg.tenantId, link.userId, conversation.id);
  }

  // Compact conversation history (Phase F) - append this resolved turn to
  // ruta_conversation_turns, pruned to MAX_TURNS_PER_CONVERSATION
  // (rutaConversation.ts). Purely an audit record of what was asked/
  // resolved; never read back into the composeReply/AI-provider call
  // below or anywhere else (see this file's header, §3/§7, and
  // provider.ts's own boundary comment).
  await recordConversationTurn(msg.tenantId, link.userId, conversation.id, {
    toolName: tool.name,
    sessionRole: tool.sessionRole,
    range: result.kind === "text" && result.dateRange ? result.dateRange : undefined,
    userMessageText: text,
  });

  // "Structured Result -> LLM -> WhatsApp" - the final pipeline stage, run
  // ONLY for tools backed by a named CRM tool (crmTools.ts) - see
  // RutaToolResult's own doc comment (rutaTools.ts) for exactly which ones
  // set `structured`. composeReply (rutaReplyComposer.ts) hands the AI
  // provider nothing but this already-computed JSON plus the user's own
  // question text - never a query, never database access - and always
  // falls back to result.text (built with zero AI involvement) on any
  // failure, so a missing/broken AI provider never blocks a reply, only
  // its phrasing. Every other tool's result.text is sent completely
  // unchanged, exactly as before this pipeline stage existed.
  const replyText = result.kind === "text" && result.structured ? await composeReply(tool.name, result.structured, text, result.text) : result.text;

  await sendReply(sendCtx, msg, link, tool.name, replyText);
}

function decodeAnchorRange(range: { startIso: string; endIso: string; label: string }): DateRange {
  return { start: new Date(range.startIso), end: new Date(range.endIso), label: range.label };
}

async function runResolvedPick(ctx: RutaToolContext, kind: "lead" | "teammate", id: string): Promise<string> {
  return kind === "lead" ? resolveLeadPick(ctx, id) : resolveTeammatePick(ctx, id);
}

function resolvePendingSelection(text: string, ctx: { options: PendingOption[] }): PendingOption | null {
  const n = Number(text.trim());
  if (!Number.isInteger(n) || n < 1 || n > ctx.options.length) return null;
  return ctx.options[n - 1] ?? null;
}

// ---------------------------------------------------------------------------
// AI provider fallback - only reached when matchPattern finds nothing.
// Sends ONLY the raw message text and the fixed tool schema - see
// AiProvider's own doc comment in infrastructure/ai/provider.ts for the
// full boundary. Retried internally by the provider implementation itself
// (infrastructure/ai/retry.ts); never retried again here.
// ---------------------------------------------------------------------------

async function classifyWithAiProvider(text: string, msg: RutaAssistantInboundMessage): Promise<{ name: string; arguments: Record<string, unknown> } | null> {
  const provider = getAiProvider();
  if (!provider) return null; // Not provisioned - graceful no-op, pattern matching alone is a fully working v1.
  const startedAt = Date.now();
  const call = await provider.classify(text, rutaToolSchemas());
  rutaLog.info("ai_classify", { tenantId: msg.tenantId, waMessageId: msg.waMessageId, provider: provider.name, matched: Boolean(call), tool: call?.name, durationMs: Date.now() - startedAt });
  return call;
}

// ---------------------------------------------------------------------------
// Send context + reply - unchanged from the original implementation, just
// wrapped with structured logging on the way out.
// ---------------------------------------------------------------------------

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
    console.error(`[ruta-ai-assistant] Failed to send WhatsApp reply to ${to}:`, err);
  }
}

/** Every outbound reply funnels through here so it's logged consistently,
 * regardless of which stage produced it (a resolved pick, a matched tool, a
 * fallback "didn't catch that"). */
async function sendReply(ctx: SendContext, msg: RutaAssistantInboundMessage, link: RutaAssistantLink, intent: string, text: string): Promise<void> {
  rutaLog.info("reply_sent", { tenantId: msg.tenantId, userId: link.userId, waMessageId: msg.waMessageId, intent });
  await reply(ctx, msg.fromPhoneNumber, text);
}

// ---------------------------------------------------------------------------
// Onboarding welcome message - unchanged from before this refactor.
// ---------------------------------------------------------------------------

/**
 * Sent once, right after a company FINISHES onboarding - the very first
 * message a brand-new user gets from RUTA. RUTA AI Assistant itself is
 * already active by this point (mandatory, zero-verification - it went live
 * the moment a WhatsApp link was provisioned for this user, alongside
 * account creation; see this function's own callers: registerCompanyAndOwner
 * in auth.ts, completeAgencyOnboarding in agencyOnboarding.ts, and
 * completeWizard in onboardingWizard.ts), so this message is purely
 * informational, not an activation step of its own.
 *
 * Deliberately never throws and never blocks its caller - onboarding
 * completion (account creation, the wizard finishing) must succeed
 * regardless of whether this message actually goes out. A missing link
 * (getUserWhatsappLinkByUserId returns null - e.g. WhatsApp provisioning
 * itself failed, or this is being called for a user who genuinely has no
 * phone number on file) is a silent no-op, not an error - there's nothing
 * to send to.
 */
export async function sendOnboardingWelcomeMessage(tenantId: string, userId: string): Promise<void> {
  try {
    const link = await getUserWhatsappLinkByUserId(tenantId, userId);
    if (!link) return;
    const ctx = await getSendContext(tenantId);
    if (!ctx) {
      rutaLog.error("welcome_no_send_context", { tenantId, userId });
      return;
    }
    await reply(
      ctx,
      link.phoneNumber,
      "👋 Welcome to RUTA! Your RUTA AI Assistant is now active on this number.\n\n" +
        "Just ask me things in plain language, right here on WhatsApp - no commands needed. Try:\n" +
        '• "how many leads did we get today"\n' +
        '• "follow-ups today"\n' +
        '• "update on <name>"\n' +
        '• "my leads today"\n' +
        '• "pending follow-ups"\n\n' +
        "A couple of things worth finishing when you get a chance (Settings on the web dashboard):\n" +
        "• Connect your Meta/Instagram ads account so new leads start flowing in automatically\n" +
        "• Review your pipeline stages under Business Configuration\n" +
        "• Invite your team so everyone can ask RUTA too\n\n" +
        "Send HELP any time to see this again.",
    );
    rutaLog.info("welcome_sent", { tenantId, userId });
  } catch (err) {
    rutaLog.error("welcome_failed", { tenantId, userId, error: err instanceof Error ? err.message : String(err) });
  }
}

