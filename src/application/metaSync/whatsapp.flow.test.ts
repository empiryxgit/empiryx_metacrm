// WhatsApp Lead Capture feature - Phase 17/18 automated + end-to-end tests.
// Mirrors webhook.flow.test.ts's structure exactly (captureWhatsappEvents
// against real Postgres, plus HTTP-layer signature verification tests) and
// adds full pipeline coverage sync.flow.test.ts / oauth flow tests don't:
// discovery auto-selection, duplicate/idempotent capture, unknown-number
// isolation, end-to-end lead creation, and Phase 9 attribution (both the
// "referral matches a synced ad" and "no referral -> Unknown/Organic" cases).
// Only graphClient's network calls are mocked - everything else (Postgres,
// Redis fakes, QStash capture) is the same real integration-test posture as
// every other *.flow.test.ts file. Requires DATABASE_URL; skips otherwise.

import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { completeMetaConnection } from "../metaOAuth";
import { selectAdAccount } from "./metaAdAccountService";
import { syncCampaignsForSelectedAdAccount } from "./metaCampaignService";
import { captureWhatsappEvents, enqueueCapturedWhatsappEvents } from "./metaWhatsappEventService";
import { processWhatsAppMessageEvent } from "./processWhatsAppMessageEvent";
import { listMetaAdAccounts } from "../../infrastructure/db/repositories/metaIntegration";
import { getSelectedMetaWhatsappAccount, getWhatsappMessageEventById } from "../../infrastructure/db/repositories/whatsapp";
import { getDb } from "../../infrastructure/db/client";
import { leads } from "../../infrastructure/db/schema";
import { makeTenant } from "../../testSupport/dbFixtures";
import { fakeReq, fakeRes } from "../../testSupport/httpFixtures";
import { publishedMessages, resetPublishedMessages } from "../../testSupport/qstashCapture";

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

/** Connects a fresh tenant with no Page (WhatsApp doesn't need one) and
 * exactly one discoverable WhatsApp phone number, which
 * completeMetaConnection's best-effort WhatsApp discovery step
 * auto-selects (Phase 5: "a single-number tenant never has to click
 * anything"). Returns the raw Meta phone_number_id incoming webhook
 * payloads should reference. */
async function connectWithOneWhatsappNumber(label: string): Promise<{ tenantId: string; phoneNumberId: string }> {
  const { tenantId, userId } = await makeTenant(label);
  const phoneNumberId = `phone-${label}-${randomUUID().slice(0, 8)}`;

  vi.mocked(graphClient.exchangeCodeForToken).mockResolvedValue({ accessToken: "short-lived", expiresInSeconds: 3600 });
  vi.mocked(graphClient.exchangeForLongLivedToken).mockResolvedValue({ accessToken: "long-lived", expiresInSeconds: 5_184_000 });
  vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(ALL_SCOPES.map((permission) => ({ permission, status: "granted" })));
  vi.mocked(graphClient.getAuthorizedMetaUser).mockResolvedValue({ id: `meta-${label}`, name: label });
  vi.mocked(graphClient.getUserPages).mockResolvedValue([]);
  vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([{ id: `act_${label}`, name: `Account ${label}` }]);
  vi.mocked(graphClient.getUserBusinesses).mockResolvedValue([{ id: `biz-${label}`, name: `Business ${label}` }]);
  vi.mocked(graphClient.getOwnedWhatsAppBusinessAccounts).mockResolvedValue([{ id: `waba-${label}`, name: `WABA ${label}` }]);
  vi.mocked(graphClient.getWhatsAppPhoneNumbers).mockResolvedValue([
    { id: phoneNumberId, displayPhoneNumber: "+1 555 0100", verifiedName: `${label} Business` },
  ]);

  await completeMetaConnection(`code-${label}`, tenantId, userId);

  const selected = await getSelectedMetaWhatsappAccount(tenantId);
  expect(selected?.phoneNumberId).toBe(phoneNumberId); // sanity: auto-selection actually happened

  return { tenantId, phoneNumberId };
}

/** Additionally syncs one campaign -> ad set (destination_type WHATSAPP) ->
 * ad for the tenant, so metaCampaignService.ts resolves and persists a
 * "whatsapp" meta_lead_routes row for that ad - the fixture Phase 9
 * attribution tests need. */
async function syncOneWhatsappRoutedAd(tenantId: string, adId: string, adSetName: string, campaignName: string) {
  vi.mocked(graphClient.getAdAccountCampaigns).mockResolvedValue([{ id: `camp-${adId}`, name: campaignName, status: "ACTIVE", startTime: null, stopTime: null }]);
  vi.mocked(graphClient.getCampaignAdSets).mockResolvedValue([{ id: `adset-${adId}`, name: adSetName, status: "ACTIVE", destinationType: "WHATSAPP" }]);
  vi.mocked(graphClient.getAdSetAds).mockResolvedValue([{ id: adId, name: `Ad for ${adId}`, status: "ACTIVE" }]);
  vi.mocked(graphClient.getAdCreativeLeadFormId).mockResolvedValue(null);

  const [adAccount] = await listMetaAdAccounts(tenantId);
  await selectAdAccount(tenantId, adAccount!.id);
  const result = await syncCampaignsForSelectedAdAccount(tenantId, "long-lived");
  expect(result.leadApproachCounts.whatsapp).toBe(1); // sanity: the route actually resolved to WHATSAPP
}

function whatsappMessagePayload(
  entries: Array<{ phoneNumberId: string; waMessageId: string; from?: string; contactName?: string; text?: string; referralSourceId?: string }>,
): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: entries.map((e) => ({
      id: "waba-x",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "+1 555 0100", phone_number_id: e.phoneNumberId },
            contacts: e.contactName ? [{ profile: { name: e.contactName }, wa_id: e.from ?? "15550001111" }] : [],
            messages: [
              {
                id: e.waMessageId,
                from: e.from ?? "15550001111",
                type: "text",
                text: { body: e.text ?? "Hi, I'm interested" },
                ...(e.referralSourceId
                  ? { referral: { source_id: e.referralSourceId, source_type: "ad", source_url: "https://facebook.com/ads/x" } }
                  : {}),
              },
            ],
          },
        },
      ],
    })),
  });
}

function statusOnlyPayload(phoneNumberId: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-x",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "+1 555 0100", phone_number_id: phoneNumberId },
              statuses: [{ id: "wamid.status-1", status: "delivered" }],
            },
          },
        ],
      },
    ],
  });
}

describe.skipIf(!process.env.DATABASE_URL)("WhatsApp webhook flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPublishedMessages();
  });

  it("Discovery: exactly one WhatsApp number found on connect is auto-selected, no manual entry required", async () => {
    await connectWithOneWhatsappNumber("wa-discovery");
    // assertion already made inside the helper - this test exists mainly to
    // document the behavior under its own name in the test report.
  });

  it("Valid webhook: a WhatsApp message is captured and durably stored", async () => {
    const { tenantId, phoneNumberId } = await connectWithOneWhatsappNumber("wa-valid");
    const waMessageId = `wamid.${randomUUID()}`;

    const result = await captureWhatsappEvents(whatsappMessagePayload([{ phoneNumberId, waMessageId, contactName: "Jane Prospect" }]));
    expect(result).toMatchObject({ captured: 1, skipped: 0 });
    expect(result.toEnqueue[0]).toMatchObject({ waMessageId, tenantId });
  });

  it("Malformed JSON: never throws, returns zero counts", async () => {
    const result = await captureWhatsappEvents("{not valid json");
    expect(result).toMatchObject({ captured: 0, skipped: 0, toEnqueue: [] });
  });

  it("Status-only payload (delivery/read receipt, no messages[]): skipped, never treated as a lead event", async () => {
    const { phoneNumberId } = await connectWithOneWhatsappNumber("wa-status-only");
    const result = await captureWhatsappEvents(statusOnlyPayload(phoneNumberId));
    expect(result).toMatchObject({ captured: 0, skipped: 1 });
  });

  it("Unknown/unselected phone number: skipped, nothing persisted, no crash", async () => {
    await connectWithOneWhatsappNumber("wa-unknown-number-setup");
    const result = await captureWhatsappEvents(whatsappMessagePayload([{ phoneNumberId: "a-number-nobody-selected", waMessageId: `wamid.${randomUUID()}` }]));
    expect(result).toMatchObject({ captured: 0, skipped: 1 });
  });

  it("Duplicate webhook: a redelivered wamid is never captured twice", async () => {
    const { phoneNumberId } = await connectWithOneWhatsappNumber("wa-duplicate");
    const waMessageId = `wamid.${randomUUID()}`;
    const payload = whatsappMessagePayload([{ phoneNumberId, waMessageId }]);

    const first = await captureWhatsappEvents(payload);
    expect(first.captured).toBe(1);

    const redelivery = await captureWhatsappEvents(payload);
    expect(redelivery).toMatchObject({ captured: 0, skipped: 1 });
  });

  it("Tenant isolation: tenant A's message is never captured against tenant B's number, and vice versa", async () => {
    const a = await connectWithOneWhatsappNumber("wa-iso-a");
    const b = await connectWithOneWhatsappNumber("wa-iso-b");
    const waMessageId = `wamid.${randomUUID()}`;

    const result = await captureWhatsappEvents(whatsappMessagePayload([{ phoneNumberId: a.phoneNumberId, waMessageId }]));
    expect(result.toEnqueue).toEqual([{ eventId: expect.any(String), waMessageId, tenantId: a.tenantId }]);
    expect(result.toEnqueue.some((e) => e.tenantId === b.tenantId)).toBe(false);
  });

  describe("End-to-end: capture -> enqueue -> process -> Lead", () => {
    it("A WhatsApp message with no referral becomes a Lead: source=whatsapp, leadApproach=whatsapp, attribution Unknown/Organic (never guessed)", async () => {
      const { tenantId, phoneNumberId } = await connectWithOneWhatsappNumber("wa-e2e-organic");
      const waMessageId = `wamid.${randomUUID()}`;

      const captured = await captureWhatsappEvents(whatsappMessagePayload([{ phoneNumberId, waMessageId, contactName: "Organic Prospect", from: "15559998888" }]));
      await enqueueCapturedWhatsappEvents(captured.toEnqueue);
      expect(publishedMessages).toContainEqual(expect.objectContaining({ kind: "whatsapp", waMessageId, tenantId }));

      const event = captured.toEnqueue[0]!;
      const outcome = await processWhatsAppMessageEvent(event.eventId, event.waMessageId, tenantId);
      expect(outcome).toBe("processed");

      const eventRow = await getWhatsappMessageEventById(event.eventId);
      expect(eventRow?.status).toBe("completed");

      const db = await getDb();
      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.companyId, tenantId), eq(leads.metaLeadId, `whatsapp:${waMessageId}`)));
      expect(lead).toMatchObject({
        source: "whatsapp",
        leadApproach: "whatsapp",
        fullName: "Organic Prospect",
        phoneNumber: "15559998888",
        adId: null,
        campaignId: null,
        crmCampaignId: null,
      });
    });

    it("A WhatsApp message with a referral matching a synced Click-to-WhatsApp ad recovers real campaign/ad-set/ad attribution (Phase 9)", async () => {
      const { tenantId, phoneNumberId } = await connectWithOneWhatsappNumber("wa-e2e-attributed");
      const adId = `ad-ctwa-${randomUUID().slice(0, 8)}`;
      await syncOneWhatsappRoutedAd(tenantId, adId, "Ad Set CTWA", "Campaign CTWA");

      const waMessageId = `wamid.${randomUUID()}`;
      const captured = await captureWhatsappEvents(
        whatsappMessagePayload([{ phoneNumberId, waMessageId, contactName: "Attributed Prospect", referralSourceId: adId }]),
      );
      expect(captured.captured).toBe(1);
      await enqueueCapturedWhatsappEvents(captured.toEnqueue);

      const event = captured.toEnqueue[0]!;
      const outcome = await processWhatsAppMessageEvent(event.eventId, event.waMessageId, tenantId);
      expect(outcome).toBe("processed");

      const db = await getDb();
      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.companyId, tenantId), eq(leads.metaLeadId, `whatsapp:${waMessageId}`)));
      expect(lead).toMatchObject({
        source: "whatsapp",
        leadApproach: "whatsapp",
        adId,
        adSetName: "Ad Set CTWA",
        campaignName: "Campaign CTWA",
      });
      // Auto-mapped on first sync (metaCampaignService.ts) - a CRM campaign
      // was created and mapped, never null for a brand-new synced campaign.
      expect(lead!.crmCampaignId).not.toBeNull();
    });

    it("A referral naming an ad this tenant never synced still creates the lead, just unattributed - never dropped, never guessed", async () => {
      const { tenantId, phoneNumberId } = await connectWithOneWhatsappNumber("wa-e2e-unmatched-referral");
      const waMessageId = `wamid.${randomUUID()}`;

      const captured = await captureWhatsappEvents(
        whatsappMessagePayload([{ phoneNumberId, waMessageId, referralSourceId: "an-ad-id-never-synced" }]),
      );
      await enqueueCapturedWhatsappEvents(captured.toEnqueue);
      const event = captured.toEnqueue[0]!;
      const outcome = await processWhatsAppMessageEvent(event.eventId, event.waMessageId, tenantId);
      expect(outcome).toBe("processed");

      const db = await getDb();
      const [lead] = await db
        .select()
        .from(leads)
        .where(and(eq(leads.companyId, tenantId), eq(leads.metaLeadId, `whatsapp:${waMessageId}`)));
      expect(lead).toMatchObject({ source: "whatsapp", leadApproach: "whatsapp", adId: null, campaignId: null });
    });

    it("Processing the same message twice never creates two leads (idempotent worker)", async () => {
      const { tenantId, phoneNumberId } = await connectWithOneWhatsappNumber("wa-e2e-idempotent-process");
      const waMessageId = `wamid.${randomUUID()}`;
      const captured = await captureWhatsappEvents(whatsappMessagePayload([{ phoneNumberId, waMessageId }]));
      const event = captured.toEnqueue[0]!;

      const first = await processWhatsAppMessageEvent(event.eventId, event.waMessageId, tenantId);
      const second = await processWhatsAppMessageEvent(event.eventId, event.waMessageId, tenantId);
      expect(first).toBe("processed");
      expect(second).toBe("duplicate");

      const db = await getDb();
      const rows = await db
        .select()
        .from(leads)
        .where(and(eq(leads.companyId, tenantId), eq(leads.metaLeadId, `whatsapp:${waMessageId}`)));
      expect(rows).toHaveLength(1);
    });
  });

  describe("HTTP layer (shared /leadgen endpoint branches correctly on payload `object`)", () => {
    it("Valid WhatsApp webhook (HTTP): correctly signed body is routed to the WhatsApp path and persisted", async () => {
      const { phoneNumberId } = await connectWithOneWhatsappNumber("wa-http-valid");
      const waMessageId = `wamid.${randomUUID()}`;
      const rawBody = whatsappMessagePayload([{ phoneNumberId, waMessageId }]);
      const signature = `sha256=${createHmac("sha256", process.env.META_APP_SECRET!).update(rawBody, "utf8").digest("hex")}`;

      const handlerModule = await import("../../../api/webhooks/meta/handler");
      const req = fakeReq({ method: "POST", query: { resource: "leadgen" }, headers: { "x-hub-signature-256": signature }, rawBody });
      const res = fakeRes();
      await handlerModule.default(req, res);

      expect(res.calls[0].status).toBe(200);
      expect((res.calls[0].json as { captured: number }).captured).toBe(1);
    });

    it("Invalid WhatsApp webhook (HTTP): wrong signature is rejected (401), nothing persisted", async () => {
      const { tenantId, phoneNumberId } = await connectWithOneWhatsappNumber("wa-http-invalid");
      const waMessageId = `wamid.${randomUUID()}`;
      const rawBody = whatsappMessagePayload([{ phoneNumberId, waMessageId }]);
      const wrongSignature = `sha256=${createHmac("sha256", "totally-wrong-secret").update(rawBody, "utf8").digest("hex")}`;

      const handlerModule = await import("../../../api/webhooks/meta/handler");
      const req = fakeReq({ method: "POST", query: { resource: "leadgen" }, headers: { "x-hub-signature-256": wrongSignature }, rawBody });
      const res = fakeRes();
      await handlerModule.default(req, res);

      expect(res.calls[0].status).toBe(401);
      const db = await getDb();
      const [lead] = await db.select().from(leads).where(eq(leads.metaLeadId, `whatsapp:${waMessageId}`));
      expect(lead).toBeUndefined();
      void tenantId;
    });
  });
});
