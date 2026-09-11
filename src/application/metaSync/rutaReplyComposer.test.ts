// rutaReplyComposer.ts's composeReply - the "Structured Result -> LLM ->
// WhatsApp" pipeline stage. No DB, no real network call: getAiProvider
// (infrastructure/ai/provider.ts) is mocked with a controllable fake
// AiProvider so every branch (no provider configured, no compose() method,
// a successful composition, a failed/timed-out one, and - most
// importantly - a HALLUCINATED number the grounding check must catch) can
// be exercised deterministically.

import { describe, expect, it, vi } from "vitest";
import { composeReply } from "./rutaReplyComposer";
import { getAiProvider } from "../../infrastructure/ai/provider";

vi.mock("../../infrastructure/ai/provider", () => ({
  getAiProvider: vi.fn(),
}));

const structured = { tool: "get_lead_count", scope: "company", count: 87, range: { label: "today" } };
const fallbackText = "You received 87 leads today.";

describe("composeReply", () => {
  it("falls back to the deterministic text when no AI provider is configured", async () => {
    vi.mocked(getAiProvider).mockReturnValue(null);
    const text = await composeReply("get_lead_count", structured, "how many leads today", fallbackText);
    expect(text).toBe(fallbackText);
  });

  it("falls back when the configured provider has no compose() method", async () => {
    vi.mocked(getAiProvider).mockReturnValue({ name: "no-compose", classify: vi.fn() });
    const text = await composeReply("get_lead_count", structured, "how many leads today", fallbackText);
    expect(text).toBe(fallbackText);
  });

  it("uses the provider's composed reply when every number in it is grounded in the structured data", async () => {
    vi.mocked(getAiProvider).mockReturnValue({ name: "fake", classify: vi.fn(), compose: vi.fn(async () => "You got 87 leads today!") });
    const text = await composeReply("get_lead_count", structured, "how many leads today", fallbackText);
    expect(text).toBe("You got 87 leads today!");
  });

  it("rejects a composed reply that invents a number not present anywhere in the structured JSON (hallucination guard)", async () => {
    vi.mocked(getAiProvider).mockReturnValue({ name: "fake", classify: vi.fn(), compose: vi.fn(async () => "You got 999 leads today!") });
    const text = await composeReply("get_lead_count", structured, "how many leads today", fallbackText);
    expect(text).toBe(fallbackText); // 999 never appears in `structured` - discarded, safe fallback used.
  });

  it("accepts a composed reply with no numbers at all (nothing to have invented)", async () => {
    vi.mocked(getAiProvider).mockReturnValue({ name: "fake", classify: vi.fn(), compose: vi.fn(async () => "No leads recorded for that period.") });
    const text = await composeReply("get_lead_count", { tool: "get_lead_count", count: 0 }, "how many leads today", "You received 0 leads today.");
    expect(text).toBe("No leads recorded for that period.");
  });

  it("falls back when compose() throws", async () => {
    vi.mocked(getAiProvider).mockReturnValue({
      name: "fake",
      classify: vi.fn(),
      compose: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const text = await composeReply("get_lead_count", structured, "how many leads today", fallbackText);
    expect(text).toBe(fallbackText);
  });

  it("falls back when compose() resolves to null or an empty string", async () => {
    vi.mocked(getAiProvider).mockReturnValue({ name: "fake", classify: vi.fn(), compose: vi.fn(async () => null) });
    expect(await composeReply("get_lead_count", structured, "q", fallbackText)).toBe(fallbackText);

    vi.mocked(getAiProvider).mockReturnValue({ name: "fake", classify: vi.fn(), compose: vi.fn(async () => "   ") });
    expect(await composeReply("get_lead_count", structured, "q", fallbackText)).toBe(fallbackText);
  });
});
