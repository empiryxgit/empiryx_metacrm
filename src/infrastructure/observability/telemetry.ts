// Structured observability for the RUTA pipeline (see rutaAiAssistant.ts's
// own pipeline header comment). The SINGLE place every AI request, tool
// call, DB query, WhatsApp send, and queue publish reports through, so a
// log platform reading Vercel's stdout/stderr can filter, aggregate, or
// reconstruct a trace by request_id/tenant_id/user_id/conversation_id/tool
// across every stage of one inbound message - and so metrics/dashboards can
// be built purely from these log lines, with no separate metrics backend
// required to get started.
//
// Three deliverables, one file, deliberately not three separate libraries:
//
//   - STRUCTURED LOGS. Every function below emits one consistently-shaped
//     JSON line via console.log/warn/error - the same "never throws,
//     fire-and-forget" contract rutaLogger.ts already established for its
//     own ad-hoc pipeline-stage events (kept, not replaced - rutaLog.info/
//     warn/error are still used elsewhere for those). This file adds the
//     handful of ALWAYS-the-same-shape events the spec calls out by name:
//     `ai_request` (one per classify()/compose() call, with EXACTLY the
//     request_id/tenant_id/user_id/conversation_id/tool/latency_ms/status/
//     error shape asked for), `tool_call`, `whatsapp_delivery_failure`, and
//     `queue_publish_failure`.
//
//   - METRICS. No dedicated metrics/APM vendor is configured in this
//     codebase today - same "flagged, not blocking" posture as the Azure
//     OpenAI resource and the WhatsApp message-template prerequisites
//     elsewhere in this project (see the project doc's Phase C/E
//     addenda). So metrics are emitted as their own structured log event
//     (`event: "metric"`, with metric/value/unit/tags) - "metrics as
//     structured logs" is a well-established, zero-dependency pattern for
//     exactly this situation: any log platform attached later (Vercel Log
//     Drains -> Datadog/Grafana/Axiom/BigQuery, or similar) can aggregate
//     these directly from stdout with no code change here. The moment a
//     real metrics backend IS wired up, point its collector at
//     `"event":"metric"` lines; nothing in this file needs to change for
//     that to start working.
//
//   - TRACING. Same reasoning again: no OpenTelemetry collector/exporter is
//     configured, so a new tracing SDK dependency would have nowhere to
//     send spans today. Instead, every inbound message gets one stable
//     `requestId` (generated once, in rutaAiAssistant.ts, via newRequestId
//     below) that is threaded through EVERY stage via AsyncLocalStorage
//     (runWithRutaContext/getRutaContext) - so every ai_request/tool_call/
//     metric line for one inbound message already carries the same
//     request_id, letting a log platform reconstruct the call tree for
//     that request from log lines alone (this is exactly how several
//     log-based tracing products, e.g. Axiom/BetterStack, build trace
//     views - no code change needed there either). If/when a real OTel
//     exporter is added later (e.g. `@vercel/otel` +
//     OTEL_EXPORTER_OTLP_ENDPOINT), `requestId` is already a stable enough
//     correlation id to bridge the two - "tracing where supported" is
//     honored today via this log-based mechanism, and stays compatible with
//     a real exporter being added later without redesigning this file.
//
// PII / sensitive-content safety (the spec's explicit "do not unnecessarily
// log sensitive WhatsApp content" instruction): NOTHING in this file ever
// accepts or logs a WhatsApp message body, a phone number, a lead's name,
// a campaign name, or any other free-text CRM content - only ids, fixed
// event/tool/stage names, counts, durations, and short technical error
// messages (the same `err.message` shape this codebase already logs
// everywhere else, e.g. "Azure OpenAI returned 500" - never anything
// derived from user-entered text). Every field accepted below is typed to
// make it awkward to pass anything else; callers are responsible for never
// forwarding raw message/lead text into `error` or a metric tag, exactly
// the same discipline rutaLogger.ts's own fields already require.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Request context - the one thing every stage of one inbound message shares.
// ---------------------------------------------------------------------------

export interface RutaRequestContext {
  requestId: string;
  tenantId: string;
  userId?: string;
  conversationId?: string;
}

const als = new AsyncLocalStorage<RutaRequestContext>();

/** Generates a fresh correlation id for one inbound message/scheduled-job
 * iteration - call ONCE per unit of work (rutaAiAssistant.ts's
 * handleOneMessage), never reused across two different messages. */
export function newRequestId(): string {
  return randomUUID();
}

/** Runs `fn` with `seed` as the current request context for every nested
 * async call inside it (AsyncLocalStorage - this survives awaits, promise
 * chains, and calls into other modules without threading a context
 * parameter through every function signature in the pipeline). `seed` is
 * copied, not stored by reference, so two concurrent calls (two different
 * users' messages, even in the same warm process) can never share or
 * clobber each other's context object - same isolation guarantee every
 * other piece of RUTA state in this codebase already has. */
export function runWithRutaContext<T>(seed: RutaRequestContext, fn: () => Promise<T>): Promise<T> {
  return als.run({ ...seed }, fn);
}

/** The current call chain's request context, or undefined outside of any
 * runWithRutaContext (e.g. code paths not part of the RUTA pipeline at all -
 * every function below degrades gracefully, logging `null` ids rather than
 * throwing, when this is undefined). */
export function getRutaContext(): RutaRequestContext | undefined {
  return als.getStore();
}

/** Fills in a field on the CURRENT request's context once it becomes known
 * partway through the pipeline - userId after the WhatsApp-link lookup,
 * conversationId after Phase F's conversation resolution both happen AFTER
 * runWithRutaContext is entered (the requestId/tenantId pair is the only
 * thing known up front). Safe to mutate in place: runWithRutaContext gives
 * every call its own fresh, copied context object, so this only ever
 * touches the one object already scoped to the current async call chain -
 * never a shared/global one, never another concurrent request's. */
export function setRutaContextField(key: "userId" | "conversationId", value: string): void {
  const ctx = als.getStore();
  if (ctx) ctx[key] = value;
}

// ---------------------------------------------------------------------------
// Metrics-as-structured-logs. See this file's own header for why this
// shape, not a metrics-vendor SDK call, is the right thing to emit today.
// ---------------------------------------------------------------------------

export type MetricUnit = "ms" | "count" | "tokens" | "usd";

/** Tag values are restricted to primitives on purpose - never pass free
 * text (a message, a name, a label from CRM data) as a tag; a tool name,
 * stage name, status string, or short technical error CLASS (not the raw
 * message) is what belongs here. */
export type MetricTags = Record<string, string | number | boolean | undefined>;

function dropUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Emits one `event: "metric"` structured log line. Never throws - logging
 * a metric is fire-and-forget by construction (console.log/error are
 * synchronous and cannot fail in a way any caller needs to handle), so a
 * call to this function can never be the reason a request fails. */
export function recordMetric(name: string, value: number, unit: MetricUnit, tags: MetricTags = {}): void {
  const ctx = getRutaContext();
  const line = {
    ts: new Date().toISOString(),
    event: "metric",
    metric: name,
    value,
    unit,
    request_id: ctx?.requestId,
    tenant_id: ctx?.tenantId,
    ...dropUndefined(tags),
  };
  console.log(JSON.stringify(dropUndefined(line)));
}

// ---------------------------------------------------------------------------
// ai_request - the exact shape the spec asks for: "Every AI request should
// have: request_id / tenant_id / user_id / conversation_id / tool /
// latency / status / error." (`latency_ms`, not bare `latency`, so the
// unit is unambiguous in the log line itself - same reasoning
// rutaLogger.ts's own `durationMs` field already uses.) Called from
// EXACTLY the two places an AI provider is ever invoked - AzureOpenAiProvider's
// classify() and compose() (infrastructure/ai/provider.ts) - never from the
// orchestrator directly, so there is one canonical place per real AI call,
// with direct access to the raw provider response (token usage) neither
// rutaAiAssistant.ts nor rutaReplyComposer.ts ever see.
// ---------------------------------------------------------------------------

export interface AiTokenUsage {
  prompt?: number;
  completion?: number;
  total?: number;
}

export interface AiRequestLogFields {
  /** The RUTA tool this call classified toward, or is composing a reply
   * for. "unmatched" for a classify() call that found no matching tool -
   * never omitted, so every ai_request line is filterable by tool. */
  tool: string;
  stage: "classify" | "compose";
  provider: string;
  latencyMs: number;
  status: "ok" | "error";
  /** A technical error message ONLY (e.g. "Azure OpenAI returned 500", a
   * network error's own .message) - never raw message/CRM text. */
  error?: string;
  tokens?: AiTokenUsage;
  costUsd?: number;
}

/** Emits the required `ai_request` log line plus its derived metrics
 * (ai.latency always; ai.tokens/ai.cost when usage was reported; ai.failures
 * on a non-ok status). Reads tenant_id/user_id/conversation_id from the
 * ambient RutaRequestContext (see runWithRutaContext above) rather than
 * taking them as parameters, since neither classify() nor compose() (their
 * only two callers) has, or should have, direct access to that identity -
 * AiProvider's own interface deliberately never receives a tenantId/userId
 * (see that file's header on why); this is how the log line gets them
 * without widening that interface. */
export function logAiRequest(fields: AiRequestLogFields): void {
  const ctx = getRutaContext();
  const status = fields.status;
  const line = {
    ts: new Date().toISOString(),
    level: status === "error" ? "error" : "info",
    layer: "ruta-ai-request",
    event: "ai_request",
    request_id: ctx?.requestId ?? null,
    tenant_id: ctx?.tenantId ?? null,
    user_id: ctx?.userId ?? null,
    conversation_id: ctx?.conversationId ?? null,
    tool: fields.tool,
    stage: fields.stage,
    provider: fields.provider,
    latency_ms: Math.round(fields.latencyMs),
    status,
    error: fields.error,
    tokens: fields.tokens,
    cost_usd: fields.costUsd,
  };
  (status === "error" ? console.error : console.log)(JSON.stringify(dropUndefined(line)));

  recordMetric("ai.latency", fields.latencyMs, "ms", { stage: fields.stage, provider: fields.provider, tool: fields.tool, status });
  if (fields.tokens?.total !== undefined) recordMetric("ai.tokens", fields.tokens.total, "tokens", { stage: fields.stage, provider: fields.provider, tool: fields.tool });
  if (fields.costUsd !== undefined) recordMetric("ai.cost", fields.costUsd, "usd", { stage: fields.stage, provider: fields.provider, tool: fields.tool });
  if (status === "error") recordMetric("ai.failures", 1, "count", { stage: fields.stage, provider: fields.provider, tool: fields.tool });
}

// ---------------------------------------------------------------------------
// tool_call - rutaAiAssistant.ts wraps its one `tool.run(...)` dispatch call
// with this, so every CRM/analytics tool execution (not just the AI-backed
// classify/compose steps) gets a latency + failure metric too.
// ---------------------------------------------------------------------------

export interface ToolCallLogFields {
  tool: string;
  latencyMs: number;
  status: "ok" | "error";
  error?: string;
}

export function logToolCall(fields: ToolCallLogFields): void {
  const ctx = getRutaContext();
  const line = {
    ts: new Date().toISOString(),
    level: fields.status === "error" ? "error" : "info",
    layer: "ruta-tool",
    event: "tool_call",
    request_id: ctx?.requestId ?? null,
    tenant_id: ctx?.tenantId ?? null,
    user_id: ctx?.userId ?? null,
    conversation_id: ctx?.conversationId ?? null,
    tool: fields.tool,
    latency_ms: Math.round(fields.latencyMs),
    status: fields.status,
    error: fields.error,
  };
  (fields.status === "error" ? console.error : console.log)(JSON.stringify(dropUndefined(line)));

  recordMetric("tool.latency", fields.latencyMs, "ms", { tool: fields.tool, status: fields.status });
  if (fields.status === "error") recordMetric("tool.failures", 1, "count", { tool: fields.tool });
}

// ---------------------------------------------------------------------------
// DB latency - see src/infrastructure/db/client.ts, which wraps the
// underlying driver call (the neon-http `sql` client function in
// production, `pool.query` for local/dev's node-postgres path) exactly
// once, centrally, rather than instrumenting every individual query call
// site across crmTools.ts/analyticsTools.ts/the repositories. NEVER given
// the query text or bind params - only timing and a coarse driver label -
// so a lead's name or phone number embedded in a query's parameters can
// never reach a log line through this path.
// ---------------------------------------------------------------------------

export function recordDbLatency(latencyMs: number, status: "ok" | "error", driver: "neon-http" | "node-postgres"): void {
  recordMetric("db.latency", latencyMs, "ms", { status, driver });
  if (status === "error") recordMetric("db.failures", 1, "count", { driver });
}

// ---------------------------------------------------------------------------
// WhatsApp delivery failures - both the (Phase E) proactive-alert send in
// notificationDelivery.ts and the ordinary reply send in
// rutaAiAssistant.ts's own `reply()` call this on a failed
// sendWhatsappTextMessage call.
// ---------------------------------------------------------------------------

export interface WhatsappDeliveryFailureFields {
  stage: "reply" | "proactive_notification";
  tenantId?: string;
  /** A technical error message ONLY (Meta API error text is already
   * sanitized/structured by graphClient.ts's MetaApiError - never the
   * outbound message body itself, which this function never even accepts a
   * parameter for). */
  error?: string;
}

export function recordWhatsappDeliveryFailure(fields: WhatsappDeliveryFailureFields): void {
  const ctx = getRutaContext();
  const tenantId = fields.tenantId ?? ctx?.tenantId ?? null;
  const line = {
    ts: new Date().toISOString(),
    level: "error",
    layer: "ruta-whatsapp",
    event: "whatsapp_delivery_failure",
    request_id: ctx?.requestId ?? null,
    tenant_id: tenantId,
    user_id: ctx?.userId ?? null,
    stage: fields.stage,
    error: fields.error,
  };
  console.error(JSON.stringify(dropUndefined(line)));
  recordMetric("whatsapp.delivery_failures", 1, "count", { stage: fields.stage });
}

// ---------------------------------------------------------------------------
// Queue publish failures - a QStash publishJSON call itself throwing (the
// publish never even got durably accepted), as distinct from a delivery
// FAILURE CALLBACK after QStash exhausted its own retries (that is already
// a recorded, terminal row status - see notificationDelivery.ts/schema.ts -
// not something this counter needs to duplicate).
// ---------------------------------------------------------------------------

export interface QueuePublishFailureFields {
  queue: string;
  tenantId?: string;
  error?: string;
}

export function recordQueuePublishFailure(fields: QueuePublishFailureFields): void {
  const ctx = getRutaContext();
  const tenantId = fields.tenantId ?? ctx?.tenantId ?? null;
  const line = {
    ts: new Date().toISOString(),
    level: "error",
    layer: "ruta-queue",
    event: "queue_publish_failure",
    request_id: ctx?.requestId ?? null,
    tenant_id: tenantId,
    queue: fields.queue,
    error: fields.error,
  };
  console.error(JSON.stringify(dropUndefined(line)));
  recordMetric("queue.publish_failures", 1, "count", { queue: fields.queue });
}

// ---------------------------------------------------------------------------
// Lightweight manual tracing span - see this file's header ("TRACING").
// Optional: nothing in this segment's instrumentation requires a caller to
// use this directly (ai_request/tool_call above already carry their own
// latency+status), but it's exposed for any future stage that wants a
// start/end pair without duplicating the same three lines each time.
// ---------------------------------------------------------------------------

export interface Span {
  end(status: "ok" | "error", extra?: MetricTags): void;
}

export function startSpan(name: string): Span {
  const ctx = getRutaContext();
  const spanId = randomUUID();
  const startedAt = performance.now();
  return {
    end(status, extra = {}) {
      const durationMs = performance.now() - startedAt;
      const line = {
        ts: new Date().toISOString(),
        event: "span",
        name,
        request_id: ctx?.requestId ?? null,
        span_id: spanId,
        tenant_id: ctx?.tenantId ?? null,
        duration_ms: Math.round(durationMs),
        status,
        ...dropUndefined(extra),
      };
      (status === "error" ? console.error : console.log)(JSON.stringify(dropUndefined(line)));
    },
  };
}
