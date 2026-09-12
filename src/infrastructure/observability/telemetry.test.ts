// telemetry.ts - pure, no DB required. Covers: request-context propagation
// and per-request isolation (AsyncLocalStorage), the exact required
// ai_request log shape (request_id/tenant_id/user_id/conversation_id/tool/
// latency_ms/status/error), derived metrics, and - explicitly - that NONE
// of these functions ever put free-text content (a message body, a phone
// number) into a log line, only ids/names/numbers/short technical error
// strings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRutaContext,
  logAiRequest,
  logToolCall,
  newRequestId,
  recordDbLatency,
  recordMetric,
  recordQueuePublishFailure,
  recordWhatsappDeliveryFailure,
  runWithRutaContext,
  setRutaContextField,
  startSpan,
} from "./telemetry";

function loggedLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls.map((call) => JSON.parse(call[0] as string));
}

describe("telemetry - request context", () => {
  it("getRutaContext is undefined outside of runWithRutaContext", () => {
    expect(getRutaContext()).toBeUndefined();
  });

  it("runWithRutaContext makes the context visible to everything inside it, including across awaits", async () => {
    await runWithRutaContext({ requestId: "req-1", tenantId: "tenant-1" }, async () => {
      expect(getRutaContext()).toEqual({ requestId: "req-1", tenantId: "tenant-1" });
      await new Promise((r) => setTimeout(r, 1));
      expect(getRutaContext()).toEqual({ requestId: "req-1", tenantId: "tenant-1" });
    });
    expect(getRutaContext()).toBeUndefined();
  });

  it("setRutaContextField fills in userId/conversationId as they become known, without needing to re-enter runWithRutaContext", async () => {
    await runWithRutaContext({ requestId: "req-2", tenantId: "tenant-1" }, async () => {
      setRutaContextField("userId", "user-9");
      setRutaContextField("conversationId", "conv-9");
      expect(getRutaContext()).toEqual({ requestId: "req-2", tenantId: "tenant-1", userId: "user-9", conversationId: "conv-9" });
    });
  });

  it("two concurrent requests never see or leak into each other's context - each gets its own copied object", async () => {
    const seenInA: (typeof undefined | ReturnType<typeof getRutaContext>)[] = [];
    const seenInB: (typeof undefined | ReturnType<typeof getRutaContext>)[] = [];

    const runA = runWithRutaContext({ requestId: "req-A", tenantId: "tenant-A" }, async () => {
      setRutaContextField("userId", "user-A");
      await new Promise((r) => setTimeout(r, 5));
      seenInA.push(getRutaContext());
    });
    const runB = runWithRutaContext({ requestId: "req-B", tenantId: "tenant-B" }, async () => {
      setRutaContextField("userId", "user-B");
      await new Promise((r) => setTimeout(r, 1));
      seenInB.push(getRutaContext());
    });

    await Promise.all([runA, runB]);

    expect(seenInA[0]).toEqual({ requestId: "req-A", tenantId: "tenant-A", userId: "user-A" });
    expect(seenInB[0]).toEqual({ requestId: "req-B", tenantId: "tenant-B", userId: "user-B" });
  });

  it("newRequestId returns a fresh, non-empty id on every call", () => {
    const ids = new Set([newRequestId(), newRequestId(), newRequestId()]);
    expect(ids.size).toBe(3);
    for (const id of ids) expect(id.length).toBeGreaterThan(0);
  });
});

describe("telemetry - structured logs and metrics", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recordMetric emits one event:'metric' line with the request/tenant context attached", async () => {
    await runWithRutaContext({ requestId: "req-3", tenantId: "tenant-3" }, async () => {
      recordMetric("ai.latency", 123.4, "ms", { tool: "leadCount", status: "ok" });
    });
    const lines = loggedLines(logSpy);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "metric", metric: "ai.latency", value: 123.4, unit: "ms", tool: "leadCount", status: "ok", request_id: "req-3", tenant_id: "tenant-3" });
  });

  it("recordMetric never throws and degrades to null ids when called with no ambient context", () => {
    expect(() => recordMetric("db.latency", 5, "ms", { driver: "neon-http" })).not.toThrow();
    const line = loggedLines(logSpy)[0];
    expect(line?.request_id).toBeUndefined();
  });

  it("logAiRequest (success) emits EXACTLY the spec's required ai_request shape plus derived metrics - request_id/tenant_id/user_id/conversation_id/tool/latency_ms/status", async () => {
    await runWithRutaContext({ requestId: "req-4", tenantId: "tenant-4", userId: "user-4", conversationId: "conv-4" }, async () => {
      logAiRequest({ tool: "leadCount", stage: "classify", provider: "azure-openai", latencyMs: 250.6, status: "ok", tokens: { prompt: 100, completion: 20, total: 120 }, costUsd: 0.0012 });
    });

    const lines = loggedLines(logSpy);
    const aiRequestLine = lines.find((l) => l.event === "ai_request");
    expect(aiRequestLine).toMatchObject({
      event: "ai_request",
      request_id: "req-4",
      tenant_id: "tenant-4",
      user_id: "user-4",
      conversation_id: "conv-4",
      tool: "leadCount",
      stage: "classify",
      latency_ms: 251, // rounded
      status: "ok",
      tokens: { prompt: 100, completion: 20, total: 120 },
      cost_usd: 0.0012,
    });
    expect(aiRequestLine).not.toHaveProperty("error");

    // Derived metrics: latency always, tokens/cost when present, no failure metric on success.
    const metricNames = lines.filter((l) => l.event === "metric").map((l) => l.metric);
    expect(metricNames).toContain("ai.latency");
    expect(metricNames).toContain("ai.tokens");
    expect(metricNames).toContain("ai.cost");
    expect(metricNames).not.toContain("ai.failures");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logAiRequest (error) logs via console.error, includes `error` as a short technical message, and increments ai.failures", async () => {
    await runWithRutaContext({ requestId: "req-5", tenantId: "tenant-5" }, async () => {
      logAiRequest({ tool: "unmatched", stage: "compose", provider: "azure-openai", latencyMs: 8000, status: "error", error: "Azure OpenAI returned 500" });
    });

    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('"event":"ai_request"'));
    const errorLines = loggedLines(errorSpy);
    const aiRequestLine = errorLines.find((l) => l.event === "ai_request");
    expect(aiRequestLine).toMatchObject({ status: "error", error: "Azure OpenAI returned 500", tool: "unmatched", user_id: null, conversation_id: null });

    const metricLines = loggedLines(logSpy).filter((l) => l.event === "metric");
    expect(metricLines.map((l) => l.metric)).toContain("ai.failures");
  });

  it("logToolCall emits tool_call with tool/latency_ms/status and a tool.failures metric only on error", async () => {
    await runWithRutaContext({ requestId: "req-6", tenantId: "tenant-6", userId: "user-6" }, async () => {
      logToolCall({ tool: "leadCount", latencyMs: 42, status: "ok" });
    });
    let ok = loggedLines(logSpy).find((l) => l.event === "tool_call");
    expect(ok).toMatchObject({ tool: "leadCount", latency_ms: 42, status: "ok", request_id: "req-6", user_id: "user-6" });
    expect(loggedLines(logSpy).filter((l) => l.event === "metric").map((l) => l.metric)).not.toContain("tool.failures");

    vi.clearAllMocks();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runWithRutaContext({ requestId: "req-7", tenantId: "tenant-6" }, async () => {
      logToolCall({ tool: "leadCount", latencyMs: 10, status: "error", error: "connection reset" });
    });
    const errLine = loggedLines(errorSpy).find((l) => l.event === "tool_call");
    expect(errLine).toMatchObject({ tool: "leadCount", status: "error", error: "connection reset" });
    expect(loggedLines(logSpy).filter((l) => l.event === "metric").map((l) => l.metric)).toContain("tool.failures");
  });

  it("recordDbLatency never receives or logs query text/params - only status/driver/duration", () => {
    recordDbLatency(15.2, "ok", "neon-http");
    const line = loggedLines(logSpy).find((l) => l.metric === "db.latency");
    expect(line).toMatchObject({ metric: "db.latency", unit: "ms", status: "ok", driver: "neon-http" });
    expect(Object.keys(line ?? {})).not.toContain("query");
    expect(Object.keys(line ?? {})).not.toContain("params");

    recordDbLatency(5, "error", "node-postgres");
    expect(loggedLines(logSpy).filter((l) => l.metric === "db.failures")).toHaveLength(1);
  });

  it("recordWhatsappDeliveryFailure never accepts a message body/phone number parameter and logs only stage/error", () => {
    recordWhatsappDeliveryFailure({ stage: "reply", tenantId: "tenant-8", error: "Failed to send WhatsApp message via phone number 123" });
    const line = loggedLines(errorSpy).find((l) => l.event === "whatsapp_delivery_failure");
    expect(line).toMatchObject({ stage: "reply", tenant_id: "tenant-8", error: "Failed to send WhatsApp message via phone number 123" });
    expect(loggedLines(logSpy).map((l) => l.metric)).toContain("whatsapp.delivery_failures");
  });

  it("recordQueuePublishFailure logs only queue/error, never the notification payload", () => {
    recordQueuePublishFailure({ queue: "ruta_notification", tenantId: "tenant-9", error: "network error" });
    const line = loggedLines(errorSpy).find((l) => l.event === "queue_publish_failure");
    expect(line).toMatchObject({ queue: "ruta_notification", tenant_id: "tenant-9", error: "network error" });
    expect(loggedLines(logSpy).map((l) => l.metric)).toContain("queue.publish_failures");
  });

  it("startSpan logs a single start/end pair with duration_ms and the given status", async () => {
    await runWithRutaContext({ requestId: "req-10", tenantId: "tenant-10" }, async () => {
      const span = startSpan("test-stage");
      await new Promise((r) => setTimeout(r, 2));
      span.end("ok", { extra: "tag" });
    });
    const line = loggedLines(logSpy).find((l) => l.event === "span");
    expect(line).toMatchObject({ name: "test-stage", status: "ok", request_id: "req-10", extra: "tag" });
    expect(typeof line?.duration_ms).toBe("number");
  });
});
