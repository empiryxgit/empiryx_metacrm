// Phase 20 - Failure recovery tests: "No lead should silently disappear."
// For every failure mode named in the request, this asserts one of two
// things holds: a lead now exists, OR the durability record
// (meta_lead_events) is still present in a non-terminal, recoverable
// state (never deleted, never silently marked done). Requires
// DATABASE_URL - see docs/TESTING.md; skips otherwise.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../infrastructure/meta/graphClient";
import { completeMetaConnection } from "./metaOAuth";
import { selectPage } from "./metaSync/metaPageService";
import { captureLeadgenEvents, enqueueCapturedLeadgenEvents } from "./metaSync/metaLeadEventService";
import { processMetaLeadEvent } from "./metaSync/processMetaLeadEvent";
import { RetryableProcessingError } from "./processLead";
import { listMetaPages, getRelevantMetaConnectionView } from "../infrastructure/db/repositories/metaIntegration";
import { recordMetaLeadEvent, getMetaLeadEventByTenantAndLeadgenId, getUnenqueuedMetaLeadEvents } from "../infrastructure/db/repositories/metaLeadEvents";
import { getDb } from "../infrastructure/db/client";
import { leads } from "../infrastructure/db/schema";
import { makeTenant } from "../testSupport/dbFixtures";
import type { MetaLeadDetails } from "../domain/types";

vi.mock("../infrastructure/meta/graphClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infrastructure/meta/graphClient")>();
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
    getLeadDetails: vi.fn(),
  };
});

vi.mock("../infrastructure/db/repositories/metaLeadEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infrastructure/db/repositories/metaLeadEvents")>();
  return { ...actual, insertMetaSyncLead: vi.fn(actual.insertMetaSyncLead) };
});

const ALL_SCOPES = ["public_profile", "email", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "pages_manage_ads", "ads_read", "business_management", "instagram_basic"];

async function connectAndSubscribeOnePage(label: string): Promise<{ tenantId: string; userId: string; metaPageId: string }> {
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
  await selectPage(tenantId, page!.id);
  return { tenantId, userId, metaPageId };
}

function leadgenPayload(pageId: string, leadgenId: string): string {
  return JSON.stringify({ object: "page", entry: [{ id: pageId, changes: [{ field: "leadgen", value: { leadgen_id: leadgenId, page_id: pageId, form_id: "form-1" } }] }] });
}

async function leadRowByMetaLeadId(companyId: string, metaLeadId: string) {
  const db = await getDb();
  const [row] = await db.select().from(leads).where(and(eq(leads.companyId, companyId), eq(leads.metaLeadId, metaLeadId)));
  return row ?? null;
}

describe.skipIf(!process.env.DATABASE_URL)("Failure recovery", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Meta API unavailable: fails retryably, releases its claim, and a later attempt (once Meta is back) recovers the same lead", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("fr-meta-down");
    const leadgenId = `leadgen-${randomUUID()}`;
    const leadEventId = (await recordMetaLeadEvent({ tenantId, leadgenId, pageId: metaPageId, formId: "form-1", adId: null, adsetId: null, campaignId: null, rawPayload: {} }))!;
    const metaLeadId = `meta-lead-${randomUUID()}`;

    vi.mocked(graphClient.getLeadDetails).mockRejectedValueOnce(new Error("fetch failed: Meta API is unreachable"));
    await expect(processMetaLeadEvent(leadEventId, metaLeadId, tenantId)).rejects.toThrow(RetryableProcessingError);

    expect(await leadRowByMetaLeadId(tenantId, metaLeadId)).toBeNull();
    const stuck = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(stuck?.status).toBe("retrying"); // present and recoverable, not deleted, not silently terminal

    vi.mocked(graphClient.getLeadDetails).mockResolvedValueOnce({ id: metaLeadId, formId: "form-1", createdTime: new Date().toISOString(), fieldData: [{ name: "full_name", values: ["Recovered"] }] } as MetaLeadDetails);
    expect(await processMetaLeadEvent(leadEventId, metaLeadId, tenantId)).toBe("processed");
    expect(await leadRowByMetaLeadId(tenantId, metaLeadId)).not.toBeNull();
  });

  it("Database temporarily unavailable: an insert failure fails retryably, releases its claim, and a later attempt recovers the lead", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("fr-db-down");
    const leadgenId = `leadgen-${randomUUID()}`;
    const leadEventId = (await recordMetaLeadEvent({ tenantId, leadgenId, pageId: metaPageId, formId: "form-1", adId: null, adsetId: null, campaignId: null, rawPayload: {} }))!;
    const metaLeadId = `meta-lead-${randomUUID()}`;
    const details = { id: metaLeadId, formId: "form-1", createdTime: new Date().toISOString(), fieldData: [{ name: "full_name", values: ["DB Blip"] }] } as MetaLeadDetails;
    vi.mocked(graphClient.getLeadDetails).mockResolvedValue(details);

    const metaLeadEventsRepo = await import("../infrastructure/db/repositories/metaLeadEvents");
    vi.mocked(metaLeadEventsRepo.insertMetaSyncLead).mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    await expect(processMetaLeadEvent(leadEventId, metaLeadId, tenantId)).rejects.toThrow(RetryableProcessingError);
    expect(await leadRowByMetaLeadId(tenantId, metaLeadId)).toBeNull();
    const stuck = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(stuck?.status).toBe("retrying");

    // Database is back - the real implementation runs this time (only mockRejectedValueOnce fired above).
    expect(await processMetaLeadEvent(leadEventId, metaLeadId, tenantId)).toBe("processed");
    expect(await leadRowByMetaLeadId(tenantId, metaLeadId)).not.toBeNull();
  });

  it("Worker unavailable: a captured event whose enqueue can't reach the queue stays durably 'received', ready for reconciliation to pick up", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("fr-worker-down");
    const leadgenId = `leadgen-${randomUUID()}`;
    const captureResult = await captureLeadgenEvents(leadgenPayload(metaPageId, leadgenId));
    expect(captureResult.captured).toBe(1);

    const qstash = await import("../infrastructure/queue/qstash");
    vi.mocked(qstash.publishTenantLeadReceived).mockRejectedValueOnce(new Error("QStash unreachable"));
    await enqueueCapturedLeadgenEvents(captureResult.toEnqueue); // logs and swallows, never throws back to the webhook response

    const event = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(event?.status).toBe("received"); // never advanced, never lost

    const unenqueued = await getUnenqueuedMetaLeadEvents(0);
    expect(unenqueued.some((e) => e.id === event!.id)).toBe(true); // reconciliation would find and retry it
  });

  it("Token invalid: the connection is flagged, but a NEW webhook for the same tenant is still captured durably, never dropped", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("fr-token-invalid");
    const firstEventId = (await recordMetaLeadEvent({ tenantId, leadgenId: `leadgen-${randomUUID()}`, pageId: metaPageId, formId: "form-1", adId: null, adsetId: null, campaignId: null, rawPayload: {} }))!;
    vi.mocked(graphClient.getLeadDetails).mockRejectedValueOnce(new graphClient.MetaApiError("Session invalidated", 401, "revoked", 190, 461));
    await expect(processMetaLeadEvent(firstEventId, `meta-lead-${randomUUID()}`, tenantId)).rejects.toThrow(RetryableProcessingError);
    expect((await getRelevantMetaConnectionView(tenantId))?.status).toBe("needs_reauth");

    // A brand new webhook for this same (now-flagged) tenant still lands safely.
    const newLeadgenId = `leadgen-${randomUUID()}`;
    const result = await captureLeadgenEvents(leadgenPayload(metaPageId, newLeadgenId));
    expect(result.captured).toBe(1);
    const newEvent = await getMetaLeadEventByTenantAndLeadgenId(tenantId, newLeadgenId);
    expect(newEvent?.status).toBe("received");
  });

  it("Webhook duplicated: redelivering an already-completed lead's webhook never creates a second lead", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("fr-webhook-dup");
    const leadgenId = `leadgen-${randomUUID()}`;
    const metaLeadId = `meta-lead-${randomUUID()}`;
    vi.mocked(graphClient.getLeadDetails).mockResolvedValue({ id: metaLeadId, formId: "form-1", createdTime: new Date().toISOString(), fieldData: [{ name: "full_name", values: ["Once Only"] }] } as MetaLeadDetails);

    const first = await captureLeadgenEvents(leadgenPayload(metaPageId, leadgenId));
    expect(first.captured).toBe(1);
    const event = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(await processMetaLeadEvent(event!.id, metaLeadId, tenantId)).toBe("processed");

    // Meta redelivers the exact same webhook notification.
    const redelivery = await captureLeadgenEvents(leadgenPayload(metaPageId, leadgenId));
    expect(redelivery.captured).toBe(0);
    expect(redelivery.reprocessed).toBe(0); // already completed - correctly ignored, not reprocessed

    const db = await getDb();
    const rows = await db.select().from(leads).where(and(eq(leads.companyId, tenantId), eq(leads.metaLeadId, metaLeadId)));
    expect(rows).toHaveLength(1);
  });
});
