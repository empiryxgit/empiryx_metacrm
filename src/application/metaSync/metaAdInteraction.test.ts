// "Meta Campaign Destination Detection" reframing, Phase 17/18 tests -
// metaAdInteractionService.ts. Mirrors whatsapp.flow.test.ts's real-Postgres
// integration-test posture (only graphClient's network calls are mocked).
// The one non-negotiable assertion running through every test here: this
// service must NEVER create a Lead, or anything else, from an aggregate
// Meta metric - it only ever reads and sums insight numbers. Requires
// DATABASE_URL; skips otherwise.

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { completeMetaConnection } from "../metaOAuth";
import { selectAdAccount } from "./metaAdAccountService";
import { syncCampaignsForSelectedAdAccount } from "./metaCampaignService";
import { getWhatsappAdInteractionSummary } from "./metaAdInteractionService";
import { listMetaAdAccounts } from "../../infrastructure/db/repositories/metaIntegration";
import { getDb } from "../../infrastructure/db/client";
import { leads } from "../../infrastructure/db/schema";
import { makeTenant } from "../../testSupport/dbFixtures";

vi.mock("../../infrastructure/meta/graphClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/meta/graphClient")>();
  return {
    ...actual,
    exchangeCodeForToken: vi.fn(),
    exchangeForLongLivedToken: vi.fn(),
    getAuthorizedMetaUser: vi.fn(),
    getGrantedPermissions: vi.fn(),
    getUserPages: vi.fn(),
    getUserAdAccounts: vi.fn(),
    getAdAccountCampaigns: vi.fn(),
    getCampaignAdSets: vi.fn(),
    getAdSetAds: vi.fn(),
    getAdCreativeLeadFormId: vi.fn(),
    getPageLeadForms: vi.fn(),
    ensureAppLeadgenSubscription: vi.fn(),
    subscribePageToLeadgen: vi.fn(),
    getUserBusinesses: vi.fn(),
    getOwnedWhatsAppBusinessAccounts: vi.fn(),
    getWhatsAppPhoneNumbers: vi.fn(),
    ensureAppWhatsappMessagesSubscription: vi.fn(),
    subscribeWabaToApp: vi.fn(),
    getAdInsights: vi.fn(),
  };
});

const ALL_SCOPES = [
  "public_profile",
  "email",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "leads_retrieval",
  "pages_manage_ads",
  "ads_read",
  "business_management",
  "instagram_basic",
  "whatsapp_business_management",
];

/** Connects a fresh tenant, no Page, one auto-selected WhatsApp number, and
 * `adCount` WhatsApp-destination ads under one campaign/ad set - enough for
 * metaAdInteractionService.ts to have real meta_lead_routes rows to sum
 * over. Mirrors whatsapp.flow.test.ts's own connectWithOneWhatsappNumber +
 * syncOneWhatsappRoutedAd helpers (kept local to that file, so
 * reconstructed here rather than imported). */
async function connectTenantWithWhatsappAds(label: string, adCount: number): Promise<{ tenantId: string; adIds: string[] }> {
  const { tenantId, userId } = await makeTenant(label);

  vi.mocked(graphClient.exchangeCodeForToken).mockResolvedValue({ accessToken: "short-lived", expiresInSeconds: 3600 });
  vi.mocked(graphClient.exchangeForLongLivedToken).mockResolvedValue({ accessToken: "long-lived", expiresInSeconds: 5_184_000 });
  vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(ALL_SCOPES.map((permission) => ({ permission, status: "granted" })));
  vi.mocked(graphClient.getAuthorizedMetaUser).mockResolvedValue({ id: `meta-${label}`, name: label });
  vi.mocked(graphClient.getUserPages).mockResolvedValue([]);
  vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([{ id: `act_${label}`, name: `Account ${label}` }]);
  vi.mocked(graphClient.getUserBusinesses).mockResolvedValue([{ id: `biz-${label}`, name: `Business ${label}` }]);
  vi.mocked(graphClient.getOwnedWhatsAppBusinessAccounts).mockResolvedValue([{ id: `waba-${label}`, name: `WABA ${label}` }]);
  vi.mocked(graphClient.getWhatsAppPhoneNumbers).mockResolvedValue([
    { id: `phone-${label}`, displayPhoneNumber: "+1 555 0100", verifiedName: `${label} Business` },
  ]);

  await completeMetaConnection(`code-${label}`, tenantId, userId);

  const adIds = Array.from({ length: adCount }, (_, i) => `ad-${label}-${i}-${randomUUID().slice(0, 6)}`);

  vi.mocked(graphClient.getAdAccountCampaigns).mockResolvedValue([{ id: `camp-${label}`, name: `Campaign ${label}`, status: "ACTIVE", startTime: null, stopTime: null }]);
  vi.mocked(graphClient.getCampaignAdSets).mockResolvedValue([{ id: `adset-${label}`, name: `Ad Set ${label}`, status: "ACTIVE", destinationType: "WHATSAPP" }]);
  vi.mocked(graphClient.getAdSetAds).mockResolvedValue(adIds.map((id) => ({ id, name: `Ad ${id}`, status: "ACTIVE" })));
  vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue(null);

  const [adAccount] = await listMetaAdAccounts(tenantId);
  await selectAdAccount(tenantId, adAccount!.id);
  const result = await syncCampaignsForSelectedAdAccount(tenantId, "long-lived");
  expect(result.leadApproachCounts.whatsapp).toBe(adCount); // sanity: every ad resolved to WHATSAPP

  return { tenantId, adIds };
}

describe.skipIf(!process.env.DATABASE_URL)("WhatsApp ad interaction summary (destination-detection reframing, Phase 17)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("No active Meta connection: available=false, never throws", async () => {
    const summary = await getWhatsappAdInteractionSummary(randomUUID(), "2026-01-01", "2026-01-31");
    expect(summary).toMatchObject({ available: false, linkClicks: 0, conversationsStarted: 0, byAd: [] });
  });

  it("Connected tenant with zero WhatsApp-routed ads: available=false (nothing reliable to show)", async () => {
    // A tenant with only Instant Form ads (no WHATSAPP destination_type
    // anywhere) never gets a WhatsApp route at all - reuse the ordinary
    // connect helper's shape but with zero WhatsApp ads.
    const { tenantId, userId } = await makeTenant("wa-interact-none");
    vi.mocked(graphClient.exchangeCodeForToken).mockResolvedValue({ accessToken: "short-lived", expiresInSeconds: 3600 });
    vi.mocked(graphClient.exchangeForLongLivedToken).mockResolvedValue({ accessToken: "long-lived", expiresInSeconds: 5_184_000 });
    vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(ALL_SCOPES.map((permission) => ({ permission, status: "granted" })));
    vi.mocked(graphClient.getAuthorizedMetaUser).mockResolvedValue({ id: "meta-none", name: "none" });
    vi.mocked(graphClient.getUserPages).mockResolvedValue([]);
    vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([]);
    vi.mocked(graphClient.getUserBusinesses).mockResolvedValue([]);
    await completeMetaConnection("code-none", tenantId, userId);

    const summary = await getWhatsappAdInteractionSummary(tenantId, "2026-01-01", "2026-01-31");
    expect(summary.available).toBe(false);
    expect(graphClient.getAdInsights).not.toHaveBeenCalled();
  });

  it("Sums link clicks and conversations-started across every WhatsApp-routed ad, aggregate only - never creates a Lead", async () => {
    const { tenantId, adIds } = await connectTenantWithWhatsappAds("wa-interact-sum", 2);
    vi.mocked(graphClient.getAdInsights).mockImplementation(async (adId: string) => {
      const idx = adIds.indexOf(adId);
      return { linkClicks: 10 * (idx + 1), messagingConversationsStarted: 3 * (idx + 1) };
    });

    const db = await getDb();
    const summary = await getWhatsappAdInteractionSummary(tenantId, "2026-01-01", "2026-01-31");

    expect(summary).toMatchObject({ available: true, linkClicks: 10 + 20, conversationsStarted: 3 + 6, adsConsidered: 2, adsFailed: 0, truncated: false });
    expect(summary.byAd).toHaveLength(2);
    expect(graphClient.getAdInsights).toHaveBeenCalledTimes(2);

    // The non-negotiable assertion: an aggregate ad-metric summary must
    // never manufacture a Lead. This tenant received zero WhatsApp
    // messages in this test, so it must have zero leads regardless of how
    // many "conversations started" the aggregate metric reports.
    const rows = await db.select().from(leads).where(eq(leads.companyId, tenantId));
    expect(rows).toHaveLength(0);
  });

  it("One ad's insights call failing never fails the whole summary - excluded and counted in adsFailed", async () => {
    const { tenantId, adIds } = await connectTenantWithWhatsappAds("wa-interact-partial-fail", 2);
    vi.mocked(graphClient.getAdInsights).mockImplementation(async (adId: string) => {
      if (adId === adIds[0]) throw new Error("simulated Graph API failure");
      return { linkClicks: 7, messagingConversationsStarted: 2 };
    });

    const summary = await getWhatsappAdInteractionSummary(tenantId, "2026-01-01", "2026-01-31");
    expect(summary).toMatchObject({ available: true, linkClicks: 7, conversationsStarted: 2, adsConsidered: 2, adsFailed: 1 });
    expect(summary.byAd).toHaveLength(1);
  });

  it("Tenant isolation: tenant A's ad interaction summary never includes tenant B's ads", async () => {
    const a = await connectTenantWithWhatsappAds("wa-interact-iso-a", 1);
    const b = await connectTenantWithWhatsappAds("wa-interact-iso-b", 1);
    vi.mocked(graphClient.getAdInsights).mockResolvedValue({ linkClicks: 5, messagingConversationsStarted: 1 });

    const summaryA = await getWhatsappAdInteractionSummary(a.tenantId, "2026-01-01", "2026-01-31");
    expect(summaryA.byAd.map((r) => r.adName)).not.toEqual(expect.arrayContaining([expect.stringContaining(b.adIds[0]!)]));
    expect(summaryA.adsConsidered).toBe(1);
  });
});
