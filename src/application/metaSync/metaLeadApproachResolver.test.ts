// "Meta Campaign Destination Detection" reframing, Phase 18 tests -
// resolveLeadApproachForAd, in isolation. Pure logic + one mocked Graph API
// call (getAdCreativeLeadFormId) - no Postgres needed, so this always runs
// (no DATABASE_URL skip), unlike the *.flow.test.ts integration suites.
// Exercises the exact three-way split the reframed spec's Phase 4/18 asks
// for: Instant Form / WhatsApp / Unknown - and the priority rule between
// the two signals, entirely from real Meta configuration fields, never a
// name.

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { resolveLeadApproachForAd } from "./metaLeadApproachResolver";

vi.mock("../../infrastructure/meta/graphClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/meta/graphClient")>();
  return { ...actual, getAdCreativeLeadFormId: vi.fn() };
});

describe("resolveLeadApproachForAd", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Ad -> Instant Form: creative has a linked lead_gen_form_id", async () => {
    vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue("form-123");
    const result = await resolveLeadApproachForAd({ metaAdId: "ad-1", adSetDestinationType: null }, "token");
    expect(result).toMatchObject({ approach: "meta_instant_form", confidence: "DETERMINED", formId: "form-123" });
  });

  it("Ad -> WhatsApp: no linked form, ad set destination_type is exactly WHATSAPP", async () => {
    vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue(null);
    const result = await resolveLeadApproachForAd({ metaAdId: "ad-2", adSetDestinationType: "WHATSAPP" }, "token");
    expect(result).toMatchObject({ approach: "whatsapp", confidence: "DETERMINED", formId: null });
  });

  it("Ad -> Unknown: no linked form, no WhatsApp destination_type - never guessed", async () => {
    vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue(null);
    const result = await resolveLeadApproachForAd({ metaAdId: "ad-3", adSetDestinationType: null }, "token");
    expect(result).toMatchObject({ approach: "unknown", confidence: "UNDETERMINED", formId: null });
    expect(result.reason).toContain("No destination_type");
  });

  it("Ad -> Unknown: a real but currently-unclassified destination_type (e.g. WEBSITE/APP/MESSENGER) is Unknown, never assumed to be WhatsApp or Instant Form", async () => {
    vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue(null);
    const result = await resolveLeadApproachForAd({ metaAdId: "ad-4", adSetDestinationType: "MESSENGER" }, "token");
    expect(result).toMatchObject({ approach: "unknown", confidence: "UNDETERMINED" });
    expect(result.reason).toContain('"MESSENGER"');
  });

  it("Priority rule: a linked lead form wins even if the ad set ALSO happens to report destination_type WHATSAPP", async () => {
    vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue("form-999");
    const result = await resolveLeadApproachForAd({ metaAdId: "ad-5", adSetDestinationType: "WHATSAPP" }, "token");
    expect(result).toMatchObject({ approach: "meta_instant_form", formId: "form-999" });
  });

  it("A failed creative lookup falls back to destination_type rather than throwing and aborting the sync", async () => {
    vi.mocked(graphClient.getAdCreativeLeadFormId).mockRejectedValue(new Error("simulated Graph API failure"));
    const result = await resolveLeadApproachForAd({ metaAdId: "ad-6", adSetDestinationType: "WHATSAPP" }, "token");
    expect(result).toMatchObject({ approach: "whatsapp", confidence: "DETERMINED" });
  });

  it("Never determines an approach from the ad id/name string, even one that looks like 'whatsapp'", async () => {
    vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue(null);
    const result = await resolveLeadApproachForAd({ metaAdId: "ad-named-whatsapp-promo-123", adSetDestinationType: null }, "token");
    expect(result.approach).toBe("unknown"); // no destination_type present -> still Unknown, name is never consulted
  });
});
