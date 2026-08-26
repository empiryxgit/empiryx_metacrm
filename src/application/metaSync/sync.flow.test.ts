// Phase 20 - Sync flow tests. Exercises runMetaSync end to end (real
// Postgres, only graphClient's network calls mocked) - campaign/ad-set/ad
// sync, form + field-mapping sync, idempotency on a repeated run, and that
// paused/archived (i.e. not currently active, but not literally deleted
// from Meta's answer) campaigns are still synced rather than silently
// dropped. Requires DATABASE_URL - see docs/TESTING.md; skips otherwise.

import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { completeMetaConnection } from "../metaOAuth";
import { runMetaSync } from "./runMetaSync";
import { selectPage } from "./metaPageService";
import { selectAdAccount } from "./metaAdAccountService";
import { listMetaPages, listMetaAdAccounts } from "../../infrastructure/db/repositories/metaIntegration";
import { listMetaCampaignsWithMapping, listAdSetsForCampaigns } from "../../infrastructure/db/repositories/metaSync";
import { listMetaFormsWithMappingCounts } from "../../infrastructure/db/repositories/metaFormMappings";
import { getDb } from "../../infrastructure/db/client";
import { metaAds } from "../../infrastructure/db/schema";
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
    getPageLeadForms: vi.fn(),
    ensureAppLeadgenSubscription: vi.fn(),
    subscribePageToLeadgen: vi.fn(),
  };
});

const ALL_SCOPES = ["public_profile", "email", "pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "pages_manage_ads", "ads_read", "business_management", "instagram_basic"];

/** Connects a fresh tenant with one Page + one Ad Account, both selected -
 * the prerequisite state syncCampaignsForSelectedAdAccount/
 * syncFormsForSelectedPage need before they'll do anything but "skipped". */
async function connectAndSelect(label: string) {
  const { tenantId, userId } = await makeTenant(label);
  vi.mocked(graphClient.exchangeCodeForToken).mockResolvedValue({ accessToken: "short-lived", expiresInSeconds: 3600 });
  vi.mocked(graphClient.exchangeForLongLivedToken).mockResolvedValue({ accessToken: "long-lived", expiresInSeconds: 5_184_000 });
  vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(ALL_SCOPES.map((permission) => ({ permission, status: "granted" })));
  vi.mocked(graphClient.getAuthorizedMetaUser).mockResolvedValue({ id: `meta-${label}`, name: label });
  vi.mocked(graphClient.getUserPages).mockResolvedValue([{ id: `page-${label}`, name: `Page ${label}`, accessToken: "page-token" }]);
  vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([{ id: `act_${label}`, name: `Account ${label}` }]);
  vi.mocked(graphClient.getAdAccountCampaigns).mockResolvedValue([]);
  vi.mocked(graphClient.getCampaignAdSets).mockResolvedValue([]);
  vi.mocked(graphClient.getAdSetAds).mockResolvedValue([]);
  vi.mocked(graphClient.getPageLeadForms).mockResolvedValue([]);
  vi.mocked(graphClient.ensureAppLeadgenSubscription).mockResolvedValue(undefined);
  vi.mocked(graphClient.subscribePageToLeadgen).mockResolvedValue(undefined);

  await completeMetaConnection(`code-${label}`, tenantId, userId);
  const [page] = await listMetaPages(tenantId);
  const [adAccount] = await listMetaAdAccounts(tenantId);
  await selectPage(tenantId, page!.id);
  await selectAdAccount(tenantId, adAccount!.id);
  return { tenantId };
}

async function countAdsForTenant(tenantId: string): Promise<number> {
  const db = await getDb();
  const rows = await db.select({ id: metaAds.id }).from(metaAds).where(eq(metaAds.tenantId, tenantId));
  return rows.length;
}

describe.skipIf(!process.env.DATABASE_URL)("Sync flow", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Campaign sync + Ad sync: campaigns, ad sets, and ads are all persisted from one run", async () => {
    const { tenantId } = await connectAndSelect("sync-campaign");
    vi.mocked(graphClient.getAdAccountCampaigns).mockResolvedValue([{ id: "camp-1", name: "Campaign One", status: "ACTIVE", startTime: null, stopTime: null }]);
    vi.mocked(graphClient.getCampaignAdSets).mockResolvedValue([{ id: "adset-1", name: "Ad Set One", status: "ACTIVE" }]);
    vi.mocked(graphClient.getAdSetAds).mockResolvedValue([{ id: "ad-1", name: "Ad One", status: "ACTIVE" }]);

    const result = await runMetaSync(tenantId);
    expect(result.ok).toBe(true);

    const campaigns = await listMetaCampaignsWithMapping(tenantId);
    expect(campaigns).toHaveLength(1);
    expect(campaigns[0]!.metaCampaignId).toBe("camp-1");

    const adSets = await listAdSetsForCampaigns(tenantId, campaigns.map((c) => c.id));
    expect(adSets).toHaveLength(1);
    expect(await countAdsForTenant(tenantId)).toBe(1);
  });

  it("Form sync: forms and their default field mappings are persisted", async () => {
    const { tenantId } = await connectAndSelect("sync-form");
    vi.mocked(graphClient.getPageLeadForms).mockResolvedValue([
      {
        id: "form-1",
        name: "Contact Form",
        status: "ACTIVE",
        questions: [
          { key: "full_name", label: "Full name", type: "FULL_NAME" },
          { key: "email", label: "Email", type: "EMAIL" },
        ],
      },
    ]);

    const result = await runMetaSync(tenantId);
    expect(result.ok).toBe(true);

    const forms = await listMetaFormsWithMappingCounts(tenantId);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.formId).toBe("form-1");
    expect(forms[0]!.questionCount).toBe(2);
    // ensureDefaultFieldMappings seeded a mapping for every question already.
    expect(forms[0]!.mappedCount).toBe(2);
  });

  it("Repeated sync / Duplicate prevention: running sync twice with identical Meta data never doubles rows", async () => {
    const { tenantId } = await connectAndSelect("sync-repeat");
    vi.mocked(graphClient.getAdAccountCampaigns).mockResolvedValue([{ id: "camp-r1", name: "Repeat Campaign", status: "ACTIVE", startTime: null, stopTime: null }]);
    vi.mocked(graphClient.getCampaignAdSets).mockResolvedValue([{ id: "adset-r1", name: "Repeat Ad Set", status: "ACTIVE" }]);
    vi.mocked(graphClient.getAdSetAds).mockResolvedValue([{ id: "ad-r1", name: "Repeat Ad", status: "ACTIVE" }]);
    vi.mocked(graphClient.getPageLeadForms).mockResolvedValue([{ id: "form-r1", name: "Repeat Form", status: "ACTIVE", questions: [{ key: "phone_number", label: "Phone", type: "PHONE" }] }]);

    await runMetaSync(tenantId);
    await runMetaSync(tenantId); // identical data, second run

    const campaigns = await listMetaCampaignsWithMapping(tenantId);
    expect(campaigns).toHaveLength(1); // not 2
    const adSets = await listAdSetsForCampaigns(tenantId, campaigns.map((c) => c.id));
    expect(adSets).toHaveLength(1);
    expect(await countAdsForTenant(tenantId)).toBe(1);
    const forms = await listMetaFormsWithMappingCounts(tenantId);
    expect(forms).toHaveLength(1);
    expect(forms[0]!.mappedCount).toBe(1); // re-sync never duplicates an existing mapping either
  });

  it("Deleted/paused Meta campaigns: a paused or archived campaign is still synced, never silently dropped", async () => {
    const { tenantId } = await connectAndSelect("sync-paused");
    vi.mocked(graphClient.getAdAccountCampaigns).mockResolvedValue([
      { id: "camp-paused", name: "Paused Campaign", status: "PAUSED", startTime: null, stopTime: null },
      { id: "camp-archived", name: "Archived (Deleted) Campaign", status: "ARCHIVED", startTime: null, stopTime: null },
    ]);

    const result = await runMetaSync(tenantId);
    expect(result.ok).toBe(true);

    const campaigns = await listMetaCampaignsWithMapping(tenantId);
    const byId = new Map(campaigns.map((c) => [c.metaCampaignId, c]));
    expect(byId.get("camp-paused")?.status).toBe("paused");
    expect(byId.get("camp-archived")?.status).toBe("archived");
  });
});
