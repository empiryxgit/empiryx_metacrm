// Phase 20 - Security tests: "Tenant A -> Tenant B data must always return
// unauthorized/not found." Formalizes the Phase 19 tenant-isolation audit's
// manual verification script into a permanent, repeatable test covering
// all eight Meta record types (Meta Connection, Page, Instagram Account,
// Ad Account, Campaign, Form, Lead Event, Lead). Every assertion is a real
// two-tenant read/write against real Postgres - no mocking. Requires
// DATABASE_URL - see docs/TESTING.md; skips otherwise.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../infrastructure/db/client";
import { createCampaign, upsertWebhookConfig, getWebhookConfigByCampaignIdInternal } from "../infrastructure/db/repositories/campaigns";
import { updateLeadPipelineStage, insertLead, saveRawEvent } from "../infrastructure/db/repositories";
import {
  upsertMetaConnection,
  getRelevantMetaConnectionView,
  replaceMetaPages,
  replaceMetaAdAccounts,
  replaceMetaInstagramAccounts,
  getMetaPageInternal,
  selectMetaPage,
  selectMetaAdAccount,
  selectMetaInstagramAccount,
} from "../infrastructure/db/repositories/metaIntegration";
import { upsertMetaCampaign, getMetaCampaignWithMappingByRowId, mapMetaCampaignToCrmCampaign, replaceMetaForms } from "../infrastructure/db/repositories/metaSync";
import { getMetaFormById, getFieldMappingsByMetaFormId } from "../infrastructure/db/repositories/metaFormMappings";
import { recordMetaLeadEvent, getMetaLeadEventById } from "../infrastructure/db/repositories/metaLeadEvents";
import { leads } from "../infrastructure/db/schema";
import { LeadPlatform } from "../domain/types";
import { makeTenant } from "../testSupport/dbFixtures";

describe.skipIf(!process.env.DATABASE_URL)("Security: tenant isolation (Tenant A -> Tenant B data)", () => {
  it("Meta Connection: Tenant B sees nothing of Tenant A's connection", async () => {
    const A = await makeTenant("secA-conn");
    const B = await makeTenant("secB-conn");
    await upsertMetaConnection({ tenantId: A.tenantId, metaUserId: "meta_a", metaUserName: "A", accessToken: "atok", tokenExpiresAt: null });
    expect(await getRelevantMetaConnectionView(B.tenantId)).toBeNull();
  });

  it("Page: Tenant B cannot read or select Tenant A's Page by row id", async () => {
    const A = await makeTenant("secA-page");
    const B = await makeTenant("secB-page");
    const connA = await upsertMetaConnection({ tenantId: A.tenantId, metaUserId: "meta_a2", metaUserName: "A", accessToken: "atok2", tokenExpiresAt: null });
    const [pageA] = await replaceMetaPages(A.tenantId, connA.id, [{ pageId: "PAGE_A1", pageName: "A's Page", pageAccessToken: "ptok_a" }]);

    expect(await getMetaPageInternal(B.tenantId, pageA!.id)).toBeNull();
    expect(await selectMetaPage(B.tenantId, pageA!.id)).toBeNull();
  });

  it("Ad Account: Tenant B cannot select Tenant A's Ad Account", async () => {
    const A = await makeTenant("secA-adacct");
    const B = await makeTenant("secB-adacct");
    const connA = await upsertMetaConnection({ tenantId: A.tenantId, metaUserId: "meta_a3", metaUserName: "A", accessToken: "atok3", tokenExpiresAt: null });
    const [adAcctA] = await replaceMetaAdAccounts(A.tenantId, connA.id, [{ adAccountId: "act_a1", name: "A Ad Account" }]);

    expect(await selectMetaAdAccount(B.tenantId, adAcctA!.id)).toBeNull();
  });

  it("Instagram Account: Tenant B cannot select Tenant A's Instagram account", async () => {
    const A = await makeTenant("secA-ig");
    const B = await makeTenant("secB-ig");
    const connA = await upsertMetaConnection({ tenantId: A.tenantId, metaUserId: "meta_a4", metaUserName: "A", accessToken: "atok4", tokenExpiresAt: null });
    const [igA] = await replaceMetaInstagramAccounts(A.tenantId, connA.id, [{ pageId: "PAGE_A1", instagramAccountId: "ig_a1", username: "a_ig" }]);

    expect(await selectMetaInstagramAccount(B.tenantId, igA!.id)).toBeNull();
  });

  it("Campaign: Tenant B cannot read Tenant A's Meta campaign, or map it to one of Tenant B's CRM campaigns", async () => {
    const A = await makeTenant("secA-camp");
    const B = await makeTenant("secB-camp");
    const connA = await upsertMetaConnection({ tenantId: A.tenantId, metaUserId: "meta_a5", metaUserName: "A", accessToken: "atok5", tokenExpiresAt: null });
    const [adAcctA] = await replaceMetaAdAccounts(A.tenantId, connA.id, [{ adAccountId: "act_a2", name: "A Ad Account 2" }]);
    const metaCampaignA = await upsertMetaCampaign(A.tenantId, adAcctA!.id, { metaCampaignId: "camp_a1", name: "A Campaign", metaStatus: "ACTIVE" });

    expect(await getMetaCampaignWithMappingByRowId(B.tenantId, metaCampaignA.id)).toBeNull();

    const crmCampaignB = await createCampaign({ companyId: B.tenantId, name: "B's CRM campaign", platform: "facebook", createdBy: B.userId });
    expect(await mapMetaCampaignToCrmCampaign(B.tenantId, metaCampaignA.id, crmCampaignB.id)).toBeNull();
  });

  it("Form: Tenant B cannot read Tenant A's Form by row id or by Meta's form id", async () => {
    const A = await makeTenant("secA-form");
    const B = await makeTenant("secB-form");
    const [formA] = await replaceMetaForms(A.tenantId, "PAGE_A1", [{ formId: "form_a1", formName: "A Form", status: "ACTIVE", questions: [{ key: "full_name", label: "Full name", type: "FULL_NAME" }] }]);

    expect(await getMetaFormById(B.tenantId, formA!.id)).toBeNull();
    const crossFormMappings = await getFieldMappingsByMetaFormId(B.tenantId, "form_a1");
    expect(crossFormMappings.formName).toBeNull();
    expect(crossFormMappings.mappings).toHaveLength(0);
  });

  it("Lead Event: Tenant B cannot read Tenant A's lead event by id", async () => {
    const A = await makeTenant("secA-event");
    const B = await makeTenant("secB-event");
    const eventAId = await recordMetaLeadEvent({ tenantId: A.tenantId, leadgenId: `leadgen_a1_${randomUUID()}`, pageId: "PAGE_A1", formId: "form_a1", adId: null, adsetId: null, campaignId: "camp_a1", rawPayload: { hello: "world" } });

    expect(await getMetaLeadEventById(B.tenantId, eventAId!)).toBeNull();
    const ownRead = await getMetaLeadEventById(A.tenantId, eventAId!);
    expect(ownRead?.id).toBe(eventAId);
  });

  it("Legacy webhook config: Tenant B cannot fetch Tenant A's Meta access token via getWebhookConfigByCampaignIdInternal", async () => {
    const A = await makeTenant("secA-webhook");
    const B = await makeTenant("secB-webhook");
    const campaignA = await createCampaign({ companyId: A.tenantId, name: "A's legacy campaign", platform: "facebook", createdBy: A.userId });
    await upsertWebhookConfig({ companyId: A.tenantId, campaignId: campaignA.id, appSecret: "secret_a", accessToken: "token_a", pageId: "PAGE_A1", formIds: ["form_a1"] }, "https://example.com");

    expect(await getWebhookConfigByCampaignIdInternal(B.tenantId, campaignA.id)).toBeNull();
    const ownConfig = await getWebhookConfigByCampaignIdInternal(A.tenantId, campaignA.id);
    expect(ownConfig?.accessToken).toBe("token_a");
  });

  it("Lead: Tenant B cannot update Tenant A's lead pipeline stage", async () => {
    const A = await makeTenant("secA-lead");
    const B = await makeTenant("secB-lead");
    const campaignA = await createCampaign({ companyId: A.tenantId, name: "A's campaign", platform: "facebook", createdBy: A.userId });
    const rawEventA = await saveRawEvent({ companyId: A.tenantId, campaignId: campaignA.id, objectType: "page", rawPayload: {}, signatureHeader: null, metaLeadId: `meta_lead_a_${randomUUID()}`, pageId: "PAGE_A1", formId: "form_a1" });
    const leadA = await insertLead({
      companyId: A.tenantId,
      branchId: null,
      crmCampaignId: campaignA.id,
      metaLeadId: `meta_lead_a_${randomUUID()}`,
      platform: LeadPlatform.Facebook,
      pageId: "PAGE_A1",
      formId: "form_a1",
      formName: "A Form",
      customFields: {},
      formResponses: {},
      metaCreatedAt: new Date(),
      rawEventId: rawEventA.id,
    });
    if (leadA.outcome !== "inserted") throw new Error("expected a fresh lead insert");

    expect(await updateLeadPipelineStage(B.tenantId, leadA.id, "contacted")).toBe(false);
    expect(await updateLeadPipelineStage(A.tenantId, leadA.id, "contacted")).toBe(true);

    const db = await getDb();
    const [row] = await db.select({ pipelineStage: leads.pipelineStage }).from(leads).where(and(eq(leads.id, leadA.id), eq(leads.companyId, A.tenantId)));
    expect(row?.pipelineStage).toBe("contacted");
  });
});
