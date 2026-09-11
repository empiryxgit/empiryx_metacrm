// AI provider abstraction for the RUTA AI Assistant's classification
// fallback (src/application/metaSync/rutaAiAssistant.ts) - only reached
// when the fast-tier pattern matcher (matchPattern, in that file) finds no
// match. Every provider implementation gets nothing but the one message's
// raw text plus the fixed tool schema (src/application/metaSync/
// rutaTools.ts's RUTA_TOOLS) - it can select at most one tool by name and,
// for tools that take arguments, extract them; it can never see database
// content, another user's data, or prior conversation turns, and it can
// never itself produce the final answer (see AiProvider's own doc comment
// below). That boundary is what keeps a wrong/hallucinated model response
// bounded to "picked the wrong tool" or "picked nothing" - every actual
// answer is still assembled entirely from real Drizzle query results in
// rutaTools.ts, regardless of which provider is active.
//
// Swapping providers (Azure OpenAI today; OpenAI/Anthropic/etc. later) is a
// single change in getAiProvider() below - nothing else in the orchestrator
// needs to know which one is active, since every implementation speaks the
// same AiProvider interface.

import { withRetry } from "./retry";
import { rutaLog } from "../observability/rutaLogger";
import { getEnv } from "../env";

export interface AiToolSchema {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface AiToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A provider's ONLY job: given one message's raw text and the fixed set of
 * tools it's allowed to pick from, return at most one tool call (name +
 * extracted arguments) or null if nothing fits. Implementations must never
 * return a tool name outside the `tools` list they were given - the
 * orchestrator additionally re-validates this itself (never trusts a
 * provider's output blindly), but a well-behaved implementation should
 * enforce it up front too (e.g. via function-calling / tool-use APIs that
 * constrain the model's output to the given schema, rather than free-form
 * text parsing).
 */
export interface AiProvider {
  readonly name: string;
  classify(text: string, tools: AiToolSchema[]): Promise<AiToolCall | null>;
}

// ---------------------------------------------------------------------------
// Azure OpenAI implementation - function-calling only, temperature 0, a
// short hard timeout, and now (unlike the original single-shot version)
// retried up to twice more on a transient failure (network error, timeout,
// or 5xx/429 from Azure) using the same backoff shape every other outbound
// call in this codebase uses (see infrastructure/ai/retry.ts). A genuine
// 4xx (bad deployment name, bad API key, malformed request) is never
// retried - retrying it would just burn the same failure three times for no
// benefit.
// ---------------------------------------------------------------------------

class AzureOpenAiProvider implements AiProvider {
  readonly name = "azure-openai";

  constructor(
    private readonly endpoint: string,
    private readonly apiKey: string,
    private readonly deployment: string,
  ) {}

  async classify(text: string, tools: AiToolSchema[]): Promise<AiToolCall | null> {
    const url = `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(this.deployment)}/chat/completions?api-version=2024-06-01`;

    try {
      const response = await withRetry(
        async () => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 8000);
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json", "api-key": this.apiKey },
              signal: controller.signal,
              body: JSON.stringify({
                messages: [
                  { role: "system", content: "Classify the user's WhatsApp message into exactly one of the provided functions. If none fit, do not call any function." },
                  { role: "user", content: text },
                ],
                tools: tools.map((t) => ({ type: "function", function: t })),
                tool_choice: "auto",
                temperature: 0,
                max_tokens: 200,
              }),
            });
            if (!res.ok && res.status >= 500) {
              throw new Error(`Azure OpenAI returned ${res.status}`);
            }
            return res;
          } finally {
            clearTimeout(timeout);
          }
        },
        {
          attempts: 3,
          label: "azure-openai classify",
          // Only a genuine transport/5xx failure is worth another attempt -
          // an AbortError (our own 8s timeout) is transient too, everything
          // else (thrown by our own body-parsing below) is not retried.
          shouldRetry: (err) => err instanceof Error && (err.name === "AbortError" || err.message.includes("Azure OpenAI returned 5")),
        },
      );

      if (!response.ok) {
        rutaLog.error("ai_provider_http_error", { provider: this.name, status: response.status });
        return null;
      }
      const data = (await response.json()) as {
        choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>;
      };
      const call = data.choices?.[0]?.message?.tool_calls?.[0]?.function;
      if (!call?.name) return null;
      const schema = tools.find((t) => t.name === call.name);
      if (!schema) return null; // Model named something outside the fixed set - never trusted.
      const args = call.arguments ? (JSON.parse(call.arguments) as Record<string, unknown>) : {};
      return { name: schema.name, arguments: args };
    } catch (err) {
      rutaLog.warn("ai_provider_failed", { provider: this.name, error: err instanceof Error ? err.message : String(err) });
      return null; // Fails closed to "didn't catch that" - never blocks the reply, never throws to the caller.
    }
  }
}

// ---------------------------------------------------------------------------
// Provider selection. AI_PROVIDER lets a future provider be switched on
// without touching the orchestrator; unset/unrecognized defaults to
// "azure-openai" (today's only implementation) for backward compatibility
// with every deployment that predates this env var existing. Returns null -
// same as the original single-provider version always did when its own env
// vars were unset - when the selected provider isn't actually configured,
// which the orchestrator treats as "no AI fallback available, pattern
// matching is a fully working v1 on its own," never an error.
// ---------------------------------------------------------------------------

// Safe to cache across a warm invocation (same convention as
// src/infrastructure/db/client.ts's dbPromise): this holds only immutable
// deployment CONFIG (endpoint/key/deployment name from env vars), never any
// per-user or per-request data, so reusing one instance across concurrent
// invocations in the same warm Node process can never leak state between
// two different users' or tenants' messages - every classify() call is
// independently parameterized by whatever text/tools its own caller passes
// in, nothing is remembered between calls.
let cachedProvider: AiProvider | null | undefined;

export function getAiProvider(): AiProvider | null {
  if (cachedProvider !== undefined) return cachedProvider;

  const selected = (getEnv("AI_PROVIDER") || "azure-openai").toLowerCase();
  if (selected === "azure-openai") {
    const endpoint = getEnv("AZURE_OPENAI_ENDPOINT");
    const apiKey = getEnv("AZURE_OPENAI_API_KEY");
    const deployment = getEnv("AZURE_OPENAI_DEPLOYMENT_NAME");
    cachedProvider = endpoint && apiKey && deployment ? new AzureOpenAiProvider(endpoint, apiKey, deployment) : null;
    return cachedProvider;
  }

  rutaLog.warn("ai_provider_unrecognized", { requested: selected });
  cachedProvider = null;
  return cachedProvider;
}
