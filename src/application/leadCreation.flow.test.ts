// Phase 20 - Lead creation tests. Exercises processMetaLeadEvent (the
// tenant-level pipeline's Background Worker step) end to end against real
// Postgres - only getLeadDetails (the one Graph API call this step makes)
// is mocked. Requires DATABASE_URL - see docs/TESTING.md; skips otherwise.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../infrastructure/meta/graphClient";
import { completeMetaConnection } from "./metaOAuth";
import { selectPage } from "./metaSync/metaPageService";
import { processMetaLeadEvent } from "./metaSync/processMetaLeadEvent";
import { RetryableProcessingError } from "./processLead";
import { listMetaPages, listMetaAdAccounts, getRelevantMetaConnectionView } from "../infrastructure/db/repositories/metaIntegration";
import { replaceMetaForms } from "../infrastructure/db/repositories/metaSync";
import { ensureDefaultFieldMappings } from "../infrastructure/db/repositories/metaFormMappings";
import { recordMetaLeadEvent, getMetaLeadEventByTenantAndLeadgenId } from "../infrastructure/db/repositories/metaLeadEvents";
import { upsertMetaCampaign, mapMetaCampaignToCrmCampaign } from "../infrastructure/db/repositories/metaSync";
import { createCampaign } from "../infrastructure/db/repositories/campaigns";
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

const ALL_SCOPES = ["public_profile", "email", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "ads_read", "business_management", "instagram_basic"];

async function connectAndSubscribeOnePage(label: string): Promise<{ tenantId: string; userId: string; metaPageId: string; adAccountRowId: string }> {
  const { tenantId, userId } = await makeTenant(label);
  vi.mocked(graphClient.exchangeCodeForToken).mockResolvedValue({ accessToken: "short-lived", expiresInSeconds: 3600 });
  vi.mocked(graphClient.exchangeForLongLivedToken).mockResolvedValue({ accessToken: "long-lived", expiresInSeconds: 5_184_000 });
  vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(ALL_SCOPES.map((permission) => ({ permission, status: "granted" })));
  vi.mocked(graphClient.getAuthorizedMetaUser).mockResolvedValue({ id: `meta-${label}`, name: label });
  const metaPageId = `page-${label}-${randomUUID().slice(0, 8)}`;
  vi.mocked(graphClient.getUserPages).mockResolvedValue([{ id: metaPageId, name: `Page ${label}`, accessToken: "page-token" }]);
  vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([{ id: `act_${label}`, name: `Account ${label}` }]);
  vi.mocked(graphClient.ensureAppLeadgenSubscription).mockResolvedValue(undefined);
  vi.mocked(graphClient.subscribePageToLeadgen).mockResolvedValue(undefined);

  await completeMetaConnection(`code-${label}`, tenantId, userId);
  const [page] = await listMetaPages(tenantId);
  await selectPage(tenantId, page!.id);
  const [adAccount] = await listMetaAdAccounts(tenantId);
  return { tenantId, userId, metaPageId, adAccountRowId: adAccount!.id };
}

/** Captures one meta_lead_events row ready for processMetaLeadEvent, the
 * same durability record captureLeadgenEvents would have produced. */
async function makeCapturedEvent(tenantId: string, metaPageId: string, formId: string | null = "form-1"): Promise<{ leadEventId: string; leadgenId: string }> {
  const leadgenId = `leadgen-${randomUUID()}`;
  const leadEventId = (await recordMetaLeadEvent({ tenantId, leadgenId, pageId: metaPageId, formId, adId: null, adsetId: null, campaignId: null, rawPayload: {} }))!;
  return { leadEventId, leadgenId };
}

function leadDetails(overrides: Partial<MetaLeadDetails> & { fieldData: MetaLeadDetails["fieldData"] }): MetaLeadDetails {
  return {
    id: `meta-lead-${randomUUID()}`,
    formId: "form-1",
    createdTime: new Date().toISOString(),
    ...overrides,
  };
}

async function leadRowByMetaLeadId(companyId: string, metaLeadId: string) {
  const db = await getDb();
  const [row] = await db.select().from(leads).where(and(eq(leads.companyId, companyId), eq(leads.metaLeadId, metaLeadId)));
  return row ?? null;
}

describe.skipIf(!process.env.DATABASE_URL)("Lead creation flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Normal lead: full field data creates a complete lead", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-normal");
    const { leadEventId } = await makeCapturedEvent(tenantId, metaPageId);
    const details = leadDetails({
      fieldData: [
        { name: "full_name", values: ["Jane Doe"] },
        { name: "email", values: ["jane@example.com"] },
        { name: "phone_number", values: ["+15551234567"] },
      ],
    });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValue(details);

    const outcome = await processMetaLeadEvent(leadEventId, details.id, tenantId);
    expect(outcome).toBe("processed");

    const lead = await leadRowByMetaLeadId(tenantId, details.id);
    expect(lead?.fullName).toBe("Jane Doe");
    expect(lead?.email).toBe("jane@example.com");
    expect(lead?.phoneNumber).toBe("+15551234567");
  });

  it("Missing email: lead is still created, email left empty", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-no-email");
    const { leadEventId } = await makeCapturedEvent(tenantId, metaPageId);
    const details = leadDetails({ fieldData: [{ name: "full_name", values: ["No Email Guy"] }, { name: "phone_number", values: ["+15550000000"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValue(details);

    expect(await processMetaLeadEvent(leadEventId, details.id, tenantId)).toBe("processed");
    const lead = await leadRowByMetaLeadId(tenantId, details.id);
    expect(lead?.fullName).toBe("No Email Guy");
    expect(lead?.email == null).toBe(true);
  });

  it("Missing phone: lead is still created, phone left empty", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-no-phone");
    const { leadEventId } = await makeCapturedEvent(tenantId, metaPageId);
    const details = leadDetails({ fieldData: [{ name: "full_name", values: ["No Phone Gal"] }, { name: "email", values: ["nophone@example.com"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValue(details);

    expect(await processMetaLeadEvent(leadEventId, details.id, tenantId)).toBe("processed");
    const lead = await leadRowByMetaLeadId(tenantId, details.id);
    expect(lead?.email).toBe("nophone@example.com");
    expect(lead?.phoneNumber == null).toBe(true);
  });

  it("Custom fields: a question mapped to a custom field lands in leads.customFields, driven by the form's own persisted mapping", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-custom");
    const [formRow] = await replaceMetaForms(tenantId, metaPageId, [
      { formId: "form-custom", formName: "Custom Form", status: "ACTIVE", questions: [{ key: "property_size_sqft", label: "Property size (sqft)", type: "SHORT_ANSWER" }] },
    ]);
    await ensureDefaultFieldMappings(tenantId, formRow!.id, formRow!.questions as { key: string; label: string; type: string }[]);

    const { leadEventId } = await makeCapturedEvent(tenantId, metaPageId, "form-custom");
    const details = leadDetails({ formId: "form-custom", fieldData: [{ name: "property_size_sqft", values: ["1800"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValue(details);

    expect(await processMetaLeadEvent(leadEventId, details.id, tenantId)).toBe("processed");
    const lead = await leadRowByMetaLeadId(tenantId, details.id);
    expect(lead?.customFields).toMatchObject({ propertySizeSqft: "1800" });
    expect(lead?.formName).toBe("Custom Form");
  });

  it("Different forms: two forms with different questions resolve independently on the same tenant", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-diff-forms");
    const [formA] = await replaceMetaForms(tenantId, metaPageId, [{ formId: "form-a", formName: "Form A", status: "ACTIVE", questions: [{ key: "budget", label: "Budget", type: "SHORT_ANSWER" }] }]);
    const [formB] = await replaceMetaForms(tenantId, metaPageId, [{ formId: "form-b", formName: "Form B", status: "ACTIVE", questions: [{ key: "property_type", label: "Property Type", type: "SHORT_ANSWER" }] }]);
    await ensureDefaultFieldMappings(tenantId, formA!.id, formA!.questions as { key: string; label: string; type: string }[]);
    await ensureDefaultFieldMappings(tenantId, formB!.id, formB!.questions as { key: string; label: string; type: string }[]);

    const eventA = await makeCapturedEvent(tenantId, metaPageId, "form-a");
    const detailsA = leadDetails({ formId: "form-a", fieldData: [{ name: "budget", values: ["500000"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValueOnce(detailsA);
    expect(await processMetaLeadEvent(eventA.leadEventId, detailsA.id, tenantId)).toBe("processed");

    const eventB = await makeCapturedEvent(tenantId, metaPageId, "form-b");
    const detailsB = leadDetails({ formId: "form-b", fieldData: [{ name: "property_type", values: ["Apartment"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValueOnce(detailsB);
    expect(await processMetaLeadEvent(eventB.leadEventId, detailsB.id, tenantId)).toBe("processed");

    const leadA = await leadRowByMetaLeadId(tenantId, detailsA.id);
    const leadB = await leadRowByMetaLeadId(tenantId, detailsB.id);
    expect(leadA?.formName).toBe("Form A");
    expect(leadA?.customFields).toMatchObject({ budget: "500000" });
    expect(leadB?.formName).toBe("Form B");
    expect(leadB?.customFields).toMatchObject({ propertyType: "Apartment" });
  });

  it("Different campaign: a lead from a mapped Meta campaign gets crmCampaignId; an unmapped one stays unattributed, never dropped", async () => {
    const { tenantId, userId, metaPageId, adAccountRowId } = await connectAndSubscribeOnePage("lead-diff-campaign");
    const crmCampaign = await createCampaign({ companyId: tenantId, name: "Mapped CRM Campaign", platform: "facebook", createdBy: userId });
    const metaCampaign = await upsertMetaCampaign(tenantId, adAccountRowId, { metaCampaignId: "camp-mapped", name: "Mapped Meta Campaign", metaStatus: "ACTIVE" });
    await mapMetaCampaignToCrmCampaign(tenantId, metaCampaign.id, crmCampaign.id);

    const mappedEvent = await makeCapturedEvent(tenantId, metaPageId);
    const mappedDetails = leadDetails({ campaignId: "camp-mapped", fieldData: [{ name: "full_name", values: ["Mapped Lead"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValueOnce(mappedDetails);
    expect(await processMetaLeadEvent(mappedEvent.leadEventId, mappedDetails.id, tenantId)).toBe("processed");
    expect((await leadRowByMetaLeadId(tenantId, mappedDetails.id))?.crmCampaignId).toBe(crmCampaign.id);

    const unmappedEvent = await makeCapturedEvent(tenantId, metaPageId);
    const unmappedDetails = leadDetails({ campaignId: "camp-never-synced", fieldData: [{ name: "full_name", values: ["Unmapped Lead"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValueOnce(unmappedDetails);
    expect(await processMetaLeadEvent(unmappedEvent.leadEventId, unmappedDetails.id, tenantId)).toBe("processed");
    const unmappedLead = await leadRowByMetaLeadId(tenantId, unmappedDetails.id);
    expect(unmappedLead).not.toBeNull(); // captured, not dropped
    expect(unmappedLead?.crmCampaignId == null).toBe(true);
  });

  it("Duplicate lead: the same underlying Meta lead delivered via two different events only ever creates one lead", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-duplicate");
    const metaLeadId = `meta-lead-dup-${randomUUID()}`;
    const details = leadDetails({ id: metaLeadId, fieldData: [{ name: "full_name", values: ["Dup Lead"] }] });
    vi.mocked(graphClient.getLeadDetails).mockResolvedValue(details);

    const event1 = await makeCapturedEvent(tenantId, metaPageId);
    expect(await processMetaLeadEvent(event1.leadEventId, metaLeadId, tenantId)).toBe("processed");

    // Redis fast-path: the claim from the first success is still held.
    const event2 = await makeCapturedEvent(tenantId, metaPageId);
    expect(await processMetaLeadEvent(event2.leadEventId, metaLeadId, tenantId)).toBe("duplicate");

    // Postgres authoritative fallback: even if the Redis claim had expired,
    // the unique index on leads.meta_lead_id still catches it.
    const event3 = await makeCapturedEvent(tenantId, metaPageId);
    const { releaseLeadIdClaim } = await import("../infrastructure/cache/redis");
    await releaseLeadIdClaim(metaLeadId);
    expect(await processMetaLeadEvent(event3.leadEventId, metaLeadId, tenantId)).toBe("duplicate");

    const db = await getDb();
    const rows = await db.select().from(leads).where(and(eq(leads.companyId, tenantId), eq(leads.metaLeadId, metaLeadId)));
    expect(rows).toHaveLength(1);
  });

  it("Meta API timeout: fails retryably, no lead created, and a later retry with a healthy Meta API recovers it", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-timeout");
    const { leadEventId, leadgenId } = await makeCapturedEvent(tenantId, metaPageId);
    const metaLeadId = `meta-lead-${randomUUID()}`;
    vi.mocked(graphClient.getLeadDetails).mockRejectedValueOnce(new Error("ETIMEDOUT: Meta API request timed out"));

    await expect(processMetaLeadEvent(leadEventId, metaLeadId, tenantId)).rejects.toThrow(RetryableProcessingError);
    expect(await leadRowByMetaLeadId(tenantId, metaLeadId)).toBeNull();
    const eventAfterFailure = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(eventAfterFailure?.status).toBe("retrying");

    // A later retry (QStash redelivering the same message) with Meta healthy again.
    vi.mocked(graphClient.getLeadDetails).mockResolvedValueOnce(leadDetails({ id: metaLeadId, fieldData: [{ name: "full_name", values: ["Recovered Lead"] }] }));
    expect(await processMetaLeadEvent(leadEventId, metaLeadId, tenantId)).toBe("processed");
    expect((await leadRowByMetaLeadId(tenantId, metaLeadId))?.fullName).toBe("Recovered Lead");
  });

  it("Invalid token: an expired-token failure flags the connection needs_reauth, and still fails retryably rather than dropping the lead", async () => {
    const { tenantId, metaPageId } = await connectAndSubscribeOnePage("lead-invalid-token");
    const { leadEventId, leadgenId } = await makeCapturedEvent(tenantId, metaPageId);
    const metaLeadId = `meta-lead-${randomUUID()}`;
    vi.mocked(graphClient.getLeadDetails).mockRejectedValue(new graphClient.MetaApiError("Error validating access token", 401, "expired_token", 190, 463));

    await expect(processMetaLeadEvent(leadEventId, metaLeadId, tenantId)).rejects.toThrow(RetryableProcessingError);
    expect(await leadRowByMetaLeadId(tenantId, metaLeadId)).toBeNull();
    const eventAfterFailure = await getMetaLeadEventByTenantAndLeadgenId(tenantId, leadgenId);
    expect(eventAfterFailure?.status).toBe("retrying");

    const connection = await getRelevantMetaConnectionView(tenantId);
    expect(connection?.status).toBe("needs_reauth");
  });
});
