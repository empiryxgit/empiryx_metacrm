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

  // -------------------------------------------------------------------
  // AI Assistant guardrails (Phase G).
  // -------------------------------------------------------------------

  it("strips id-shaped keys from the structured JSON before it ever reaches the provider's compose()", async () => {
    const withIds = {
      tool: "get_user_leads",
      totalCount: 3,
      users: [{ userId: "11111111-1111-1111-1111-111111111111", name: "Priya", count: 2 }],
    };
    const compose = vi.fn(async (_structured: Record<string, unknown>, _text: string) => "Priya has the most leads.");
    vi.mocked(getAiProvider).mockReturnValue({ name: "fake", classify: vi.fn(), compose });

    await composeReply("userLeadCounts", withIds, "who has the most leads", "Priya has 2 leads.");

    expect(compose).toHaveBeenCalledTimes(1);
    const [sentJson] = compose.mock.calls[0]!;
    expect(JSON.stringify(sentJson)).not.toContain("11111111-1111-1111-1111-111111111111");
    expect(JSON.stringify(sentJson)).not.toContain("userId");
    // The human-facing fields survive sanitization untouched.
    expect((sentJson as any).users[0].name).toBe("Priya");
    expect((sentJson as any).users[0].count).toBe(2);
  });

  it("rejects a composed reply that leaks an internal identifier, even though its own digits are technically grounded", async () => {
    const withIds = {
      tool: "get_user_leads",
      totalCount: 3,
      users: [{ userId: "22222222-2222-2222-2222-222222222222", name: "Priya", count: 2 }],
    };
    // A misbehaving model that echoes the id straight from the ORIGINAL
    // object it was never supposed to receive (simulated here since the
    // real provider never gets the id at all after sanitization) - proves
    // the categorical id-shaped-token reject, not just sanitization, is a
    // real independent backstop.
    vi.mocked(getAiProvider).mockReturnValue({
      name: "fake",
      classify: vi.fn(),
      compose: vi.fn(async () => "Priya (id 22222222-2222-2222-2222-222222222222) has the most leads."),
    });

    const text = await composeReply("userLeadCounts", withIds, "who has the most leads", "Priya has 2 leads.");
    expect(text).toBe("Priya has 2 leads."); // discarded - fallback used, id never reaches WhatsApp.
  });

  it("passes through the exact 'not enough data' guardrail reply verbatim (no digits, no id - nothing to reject)", async () => {
    vi.mocked(getAiProvider).mockReturnValue({
      name: "fake",
      classify: vi.fn(),
      compose: vi.fn(async () => "I don't have enough RUTA data to answer that yet."),
    });
    const text = await composeReply("get_lead_count", structured, "what's my company's total revenue", fallbackText);
    expect(text).toBe("I don't have enough RUTA data to answer that yet.");
  });
});
