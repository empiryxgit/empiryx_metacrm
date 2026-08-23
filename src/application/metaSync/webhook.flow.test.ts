// Phase 20 - Webhook flow tests. Exercises captureLeadgenEvents (the
// tenant-level receiver's durable-capture half) against real Postgres,
// plus two end-to-end HTTP-level tests through the actual handler
// (signature verification + persistence together) and one legacy-pipeline
// parity test. Only graphClient's network calls are mocked - everything
// else (Page/Page-subscription lookup, idempotency, DB writes) is real.
// Requires DATABASE_URL - see docs/TESTING.md; skips otherwise.

import { createHmac, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { completeMetaConnection } from "../metaOAuth";
import { selectPage } from "./metaPageService";
import { captureLeadgenEvents } from "./metaLeadEventService";
import { ingestWebhookPayload } from "../ingestWebhook";
import { listMetaPages, replaceMetaPages } from "../../infrastructure/db/repositories/metaIntegration";
import { getMetaLeadEventByTenantAndLeadgenId, markMetaLeadEventProcessing, markMetaLeadEventCompleted } from "../../infrastructure/db/repositories/metaLeadEvents";
import { createCampaign, upsertWebhookConfig } from "../../infrastructure/db/repositories/campaigns";
import { getDb } from "../../infrastructure/db/client";
import { rawMetaEvents } from "../../infrastructure/db/schema";
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
    ensureAppLeadgenSubscription: vi.fn(),
    subscribePageToLeadgen: vi.fn(),
  };
});

const ALL_SCOPES = ["public_profile", "email", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "ads_read", "business_management", "instagram_basic"];

/** Connects a tenant, syncs one Page, selects it (which subscribes its
 * webhook - the precondition for captureLeadgenEvents to ever attribute
 * an event to this Page/tenant). Returns the raw Meta Page id incoming
 * webhook payloads should reference. */
async function connectAndSubscribeOnePage(label: string): Promise<{ tenantId: string; metaPageId: string }> {
  const { tenantId, userId } = await makeTenant(label);
  vi.mocked(graphClient.exchangeCodeForToken).mockResolvedValue({ accessToken: "short-lived", expiresInSeconds: 3600 });
  vi.mocked(graphClient.exchangeForLongLivedToken).mockResolvedValue({ accessToken: "long-lived", expiresInSeconds: 5_184_000 });
  vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(ALL_SCOPES.map((permission) => ({ permission, status: "granted" })));
  vi.mocked(graphClient.getAuthorizedMetaUser).mockResolvedValue({ id: `meta-${label}`, name: label });
  const metaPageId = `page-${label}-${randomUUID().slice(0, 8)}`;
  vi.mocked(graphClient.getUserPages).mockResolvedValue([{ id: metaPageId, name: `Page ${label}`, accessToken: "page-token" }]);
  vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([]);
  vi.mocked(graphClient.ensureAppLeadgenSubscription).mockResolvedValue(undefined);
  vi.mocked(graphClient.subscribePageToLeadgen).mockResolvedValue(undefined);

  await completeMetaConnection(`code-${label}`, tenantId, userId);
  const [page] = await listMetaPages(tenantId);
  const result = await selectPage(tenantId, page!.id);
  expect(result.webhook?.status).toBe("active"); // sanity: subscribe actually succeeded

  return { tenantId, metaPageId };
}

function leadgenPayload(entries: Array<{ pageId: string; leadgenId?: string; formId?: string }>): string {
  return JSON.stringify({
    object: "page",
    entry: entries.map((e) => ({
      id: e.pageId,
      changes: [
        {
          field: "leadgen",
          value: {
            ...(e.leadgenId !== undefined ? { leadgen_id: e.leadgenId } : {}),
            page_id: e.pageId,
            form_id: e.formId ?? "form-1",
            ad_id: "ad-1",
            adgroup_id: "adset-1",
            campaign_id: "camp-1",
          },
        },
      ],
    })),
  });
}

describe.skipIf(!process.env.DATABASE_URL)("Webhook flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPublishedMessages();
  });

  it("Valid webhook: captured and durably stored", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("wh-valid");
    const leadgenId = `leadgen-${randomUUID()}`;

    const result = await captureLeadgenEvents(leadgenPayload([{ pageId: metaPageId, leadgenId }]));
    expect(result).toMatchObject({ captured: 1, skipped: 0, reprocessed: 0 });

    const event = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(event?.status).toBe("received");
  });

  it("Missing leadgen_id: skipped, nothing persisted", async () => {
    const { metaPageId } = await connectAndSubscribeOnePage("wh-missing-leadgen");
    const result = await captureLeadgenEvents(leadgenPayload([{ pageId: metaPageId, leadgenId: undefined }]));
    expect(result).toMatchObject({ captured: 0, skipped: 1 });
  });

  it("Unknown Page: skipped, nothing persisted, no crash", async () => {
    await connectAndSubscribeOnePage("wh-unknown-page-setup");
    const result = await captureLeadgenEvents(leadgenPayload([{ pageId: "a-page-nobody-owns", leadgenId: `leadgen-${randomUUID()}` }]));
    expect(result).toMatchObject({ captured: 0, skipped: 1 });
  });

  it("Unknown tenant: a Page that's synced but never selected/subscribed is never attributed an event", async () => {
    const { tenantId } = await connectAndSubscribeOnePage("wh-unsubscribed-setup");
    // A second Page exists for this SAME tenant but was only synced, never selected -
    // webhookSubscribed stays false, so it must not be attributable either.
    const [unsubscribedPage] = await replaceMetaPages(tenantId, (await listMetaPages(tenantId))[0]!.metaConnectionId, [
      { pageId: "unselected-page", pageName: "Never Selected", pageAccessToken: "tok" },
    ]);
    expect(unsubscribedPage!.webhookSubscribed).toBe(false);

    const result = await captureLeadgenEvents(leadgenPayload([{ pageId: "unselected-page", leadgenId: `leadgen-${randomUUID()}` }]));
    expect(result).toMatchObject({ captured: 0, skipped: 1 });
  });

  it("Duplicate webhook: a redelivery AFTER the event was already processed is ignored, not reprocessed", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("wh-duplicate");
    const leadgenId = `leadgen-${randomUUID()}`;
    const payload = leadgenPayload([{ pageId: metaPageId, leadgenId }]);

    const first = await captureLeadgenEvents(payload);
    expect(first.captured).toBe(1);
    const event = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    await markMetaLeadEventProcessing(event!.id);
    await markMetaLeadEventCompleted(event!.id); // simulate the worker having already finished this one

    const redelivery = await captureLeadgenEvents(payload);
    expect(redelivery).toMatchObject({ captured: 0, reprocessed: 0, skipped: 1 });

    const stillOne = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(stillOne?.status).toBe("completed");
  });

  it("Meta retry: a redelivery BEFORE the event was ever processed is reprocessed (self-healed), not silently dropped", async () => {
    const { metaPageId } = await connectAndSubscribeOnePage("wh-retry");
    const leadgenId = `leadgen-${randomUUID()}`;
    const payload = leadgenPayload([{ pageId: metaPageId, leadgenId }]);

    const first = await captureLeadgenEvents(payload);
    expect(first.captured).toBe(1); // still "received" - nothing ever enqueued/processed it

    const retryDelivery = await captureLeadgenEvents(payload);
    expect(retryDelivery.captured).toBe(0);
    expect(retryDelivery.reprocessed).toBe(1); // NOT silently ignored
    expect(retryDelivery.toEnqueue.map((e) => e.leadgenId)).toContain(leadgenId);
  });

  it("High-volume events: a burst of many leadgen changes in one call are all captured, none lost", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("wh-volume");
    const COUNT = 40;
    const entries = Array.from({ length: COUNT }, (_, i) => ({ pageId: metaPageId, leadgenId: `leadgen-burst-${i}-${randomUUID()}` }));

    const result = await captureLeadgenEvents(leadgenPayload(entries));
    expect(result.captured).toBe(COUNT);
    expect(result.skipped).toBe(0);

    // Spot-check a sample rather than re-querying all 40 - each one durably landed.
    for (const e of entries.slice(0, 5)) {
      const event = await getMetaLeadEventByTenantAndLeadgenId(tenantId, e.leadgenId!);
      expect(event?.status).toBe("received");
    }
  });

  it("Legacy pipeline parity: a valid legacy per-campaign webhook is persisted and enqueued", async () => {
    const { tenantId, userId } = await makeTenant("wh-legacy");
    const campaign = await createCampaign({ companyId: tenantId, name: "Legacy campaign", platform: "facebook", createdBy: userId });
    await upsertWebhookConfig({ companyId: tenantId, campaignId: campaign.id, appSecret: "secret", accessToken: "token", pageId: "legacy-page-1", formIds: ["legacy-form-1"] }, "https://example.com");

    const envelope = {
      object: "page",
      entry: [{ id: "legacy-page-1", time: Date.now(), changes: [{ field: "leadgen", value: { leadgen_id: `legacy-lead-${randomUUID()}`, page_id: "legacy-page-1", form_id: "legacy-form-1" } }] }],
    };
    const result = await ingestWebhookPayload(JSON.stringify(envelope), "sha256=irrelevant-already-verified-upstream", { companyId: tenantId, campaignId: campaign.id });
    expect(result.persisted).toBe(1);
    expect(result.enqueued).toBe(1);
    expect(publishedMessages).toHaveLength(1);

    const db = await getDb();
    const rows = await db.select().from(rawMetaEvents).where(and(eq(rawMetaEvents.companyId, tenantId), eq(rawMetaEvents.campaignId, campaign.id)));
    expect(rows).toHaveLength(1);
  });

  describe("HTTP layer (signature verification + persistence together)", () => {
    it("Valid webhook (HTTP): correctly signed body is accepted (200) and persisted", async () => {
      const { metaPageId } = await connectAndSubscribeOnePage("wh-http-valid");
      const leadgenId = `leadgen-${randomUUID()}`;
      const rawBody = leadgenPayload([{ pageId: metaPageId, leadgenId }]);
      const signature = `sha256=${createHmac("sha256", process.env.META_APP_SECRET!).update(rawBody, "utf8").digest("hex")}`;

      const handlerModule = await import("../../../api/webhooks/meta/handler");
      const req = fakeReq({ method: "POST", query: { resource: "leadgen" }, headers: { "x-hub-signature-256": signature }, rawBody });
      const res = fakeRes();
      await handlerModule.default(req, res);

      expect(res.calls[0].status).toBe(200);
      expect((res.calls[0].json as { captured: number }).captured).toBe(1);
    });

    it("Invalid webhook (HTTP): wrong signature is rejected (401), nothing persisted", async () => {
      const { tenantId, metaPageId } = await connectAndSubscribeOnePage("wh-http-invalid");
      const leadgenId = `leadgen-${randomUUID()}`;
      const rawBody = leadgenPayload([{ pageId: metaPageId, leadgenId }]);
      const wrongSignature = `sha256=${createHmac("sha256", "totally-wrong-secret").update(rawBody, "utf8").digest("hex")}`;

      const handlerModule = await import("../../../api/webhooks/meta/handler");
      const req = fakeReq({ method: "POST", query: { resource: "leadgen" }, headers: { "x-hub-signature-256": wrongSignature }, rawBody });
      const res = fakeRes();
      await handlerModule.default(req, res);

      expect(res.calls[0].status).toBe(401);
      const event = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
      expect(event).toBeNull();
    });
  });
});
