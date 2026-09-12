// AzureOpenAiProvider's classify()/compose() - no real network call (fetch
// is mocked). Focused on Phase H observability: every call emits exactly
// one `ai_request` structured log line (via telemetry.ts's logAiRequest)
// with tool/stage/status/latency and, on success, token usage - and NEVER
// includes the raw message text/CRM content anywhere in that line, only
// ids, tool names, and (on failure) a short technical error string.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AzureOpenAiProvider, type AiToolSchema } from "./provider";
import { runWithRutaContext } from "../observability/telemetry";

const TOOLS: AiToolSchema[] = [{ name: "leadCount", description: "How many leads", parameters: { type: "object", properties: {} } }];

/** A fresh instance per test, with fake credentials - deliberately NOT
 * getAiProvider() (see AzureOpenAiProvider's own export comment). */
function newTestProvider(): AzureOpenAiProvider {
  return new AzureOpenAiProvider("https://fake.openai.azure.com", "fake-key", "fake-deployment");
}

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

describe("AzureOpenAiProvider - AI request observability", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  function loggedAiRequestLines(): Record<string, unknown>[] {
    const fromLog = logSpy.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.event === "ai_request");
    const fromError = errorSpy.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.event === "ai_request");
    return [...fromLog, ...fromError];
  }

  it("classify(): a matched tool call logs one ai_request with tool/stage/status/tokens, and never the message text", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        choices: [{ message: { tool_calls: [{ function: { name: "leadCount", arguments: "{}" } }] } }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      }),
    );

    const provider = newTestProvider();
    await runWithRutaContext({ requestId: "req-1", tenantId: "tenant-1", userId: "user-1", conversationId: "conv-1" }, async () => {
      const call = await provider.classify("how many leads did we get today from the sneaky campaign", TOOLS);
      expect(call).toEqual({ name: "leadCount", arguments: {} });
    });

    const lines = loggedAiRequestLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      request_id: "req-1",
      tenant_id: "tenant-1",
      user_id: "user-1",
      conversation_id: "conv-1",
      tool: "leadCount",
      stage: "classify",
      status: "ok",
      tokens: { prompt: 50, completion: 5, total: 55 },
    });
    expect(typeof lines[0]?.latency_ms).toBe("number");
    // The raw message text must never leak into the log line, in any field.
    expect(JSON.stringify(lines[0])).not.toContain("sneaky campaign");
  });

  it("classify(): no matching function call logs tool:'unmatched', status ok (a real, if empty-handed, AI call)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: {} }] }));
    const provider = newTestProvider();
    const call = await provider.classify("what's the weather", TOOLS);
    expect(call).toBeNull();
    const lines = loggedAiRequestLines();
    expect(lines[0]).toMatchObject({ tool: "unmatched", stage: "classify", status: "ok" });
  });

  it("classify(): an HTTP error response logs status:'error' with a technical error string, never a retry-storm for a 4xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "bad request" }));
    const provider = newTestProvider();
    const call = await provider.classify("how many leads today", TOOLS);
    expect(call).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1); // 4xx is never retried
    const lines = loggedAiRequestLines();
    expect(lines[0]).toMatchObject({ tool: "unmatched", stage: "classify", status: "error", error: "http_400" });
  });

  it("classify(): a thrown network error logs status:'error' with only the error's own .message", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const provider = newTestProvider();
    const call = await provider.classify("how many leads today", TOOLS);
    expect(call).toBeNull();
    const lines = loggedAiRequestLines();
    expect(lines[0]).toMatchObject({ stage: "classify", status: "error", error: "getaddrinfo ENOTFOUND" });
  });

  it("compose(): success logs stage:'compose' tagged with the caller-supplied toolName, plus token usage/cost when pricing env vars are set", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "You got 87 leads today." } }], usage: { prompt_tokens: 200, completion_tokens: 10, total_tokens: 210 } }));
    vi.stubEnv("AZURE_OPENAI_PROMPT_PRICE_PER_1K", "0.005");
    vi.stubEnv("AZURE_OPENAI_COMPLETION_PRICE_PER_1K", "0.015");

    const provider = newTestProvider();
    const text = await provider.compose?.({ tool: "get_lead_count", count: 87 }, "how many leads today", "get_lead_count");
    expect(text).toBe("You got 87 leads today.");

    const lines = loggedAiRequestLines();
    expect(lines[0]).toMatchObject({ tool: "get_lead_count", stage: "compose", status: "ok", tokens: { prompt: 200, completion: 10, total: 210 } });
    // 200/1000*0.005 + 10/1000*0.015 = 0.001 + 0.00015 = 0.00115
    expect(lines[0]?.cost_usd).toBeCloseTo(0.00115, 6);
  });

  it("compose(): cost is OMITTED (not guessed at zero) when pricing env vars are unset - tokens are still logged", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }));
    const provider = newTestProvider();
    await provider.compose?.({ tool: "get_lead_count", count: 1 }, "q", "get_lead_count");
    const lines = loggedAiRequestLines();
    expect(lines[0]?.tokens).toEqual({ prompt: 10, completion: 1, total: 11 });
    expect(lines[0]).not.toHaveProperty("cost_usd");
  });

  it("compose(): without a toolName, tags the request 'unknown' rather than throwing", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { choices: [{ message: { content: "ok" } }] }));
    const provider = newTestProvider();
    await provider.compose?.({ tool: "x" }, "q");
    const lines = loggedAiRequestLines();
    expect(lines[0]).toMatchObject({ tool: "unknown", stage: "compose", status: "ok" });
  });
});
