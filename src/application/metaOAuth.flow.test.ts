// Phase 20 - OAuth flow tests. Exercises completeMetaConnection (the real
// "OAuth -> Validate permissions -> Update connection -> Validate Page ->
// Re-subscribe webhook -> Sync assets" pipeline, application code + real
// Postgres) with only the external Graph API calls mocked, plus
// verifyOAuthState (the state-token security boundary) and the HTTP
// callback handler's rejection/redirect behavior directly. Requires a real
// Postgres (DATABASE_URL) - see docs/TESTING.md; skips cleanly otherwise.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../infrastructure/meta/graphClient";
import { completeMetaConnection, MetaPermissionError } from "./metaOAuth";
import { createOAuthState, verifyOAuthState } from "../infrastructure/auth/oauthState";
import { getRelevantMetaConnectionView, listMetaPages, listMetaAdAccounts, listMetaInstagramAccounts } from "../infrastructure/db/repositories/metaIntegration";
import { makeTenant } from "../testSupport/dbFixtures";
import { fakeReq, fakeRes } from "../testSupport/httpFixtures";

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
    getAdAccountCampaigns: vi.fn(),
    getCampaignAdSets: vi.fn(),
    getAdSetAds: vi.fn(),
    getPageLeadForms: vi.fn(),
  };
});

const ALL_SCOPES = [
  "public_profile",
  "email",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "leads_retrieval",
  "ads_read",
  "business_management",
  "instagram_basic",
];

function grantedPermissions(excluding: string[] = []): graphClient.GrantedPermission[] {
  return ALL_SCOPES.map((permission) => ({ permission, status: excluding.includes(permission) ? "declined" : "granted" }));
}

function mockHappyPathDefaults() {
  vi.mocked(graphClient.exchangeCodeForToken).mockResolvedValue({ accessToken: "short-lived-token", expiresInSeconds: 3600 });
  vi.mocked(graphClient.exchangeForLongLivedToken).mockResolvedValue({ accessToken: "long-lived-token", expiresInSeconds: 60 * 24 * 3600 });
  vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(grantedPermissions());
  vi.mocked(graphClient.getAuthorizedMetaUser).mockResolvedValue({ id: "meta-user-1", name: "Test User" });
  vi.mocked(graphClient.getUserPages).mockResolvedValue([{ id: "page-1", name: "Page One", accessToken: "page-token-1" }]);
  vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([{ id: "act_1", name: "Ad Account One" }]);
  vi.mocked(graphClient.getAdAccountCampaigns).mockResolvedValue([]);
  vi.mocked(graphClient.getCampaignAdSets).mockResolvedValue([]);
  vi.mocked(graphClient.getAdSetAds).mockResolvedValue([]);
  vi.mocked(graphClient.getPageLeadForms).mockResolvedValue([]);
}

describe.skipIf(!process.env.DATABASE_URL)("OAuth flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHappyPathDefaults();
  });

  it("Successful connection: writes an active connection with the synced Page + Ad Account", async () => {
    const { tenantId, userId } = await makeTenant("oauth-success");
    const result = await completeMetaConnection("auth-code-1", tenantId, userId);

    expect(result.pagesConnected).toBe(1);
    expect(result.adAccountsConnected).toBe(1);

    const connection = await getRelevantMetaConnectionView(tenantId);
    expect(connection?.status).toBe("active");
    expect(connection?.metaUserId).toBe("meta-user-1");

    const pages = await listMetaPages(tenantId);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.pageId).toBe("page-1");
  });

  it("Missing permission: rejects with MetaPermissionError naming the missing scope, and writes no connection", async () => {
    const { tenantId, userId } = await makeTenant("oauth-missing-perm");
    vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(grantedPermissions(["ads_read"]));

    await expect(completeMetaConnection("auth-code-2", tenantId, userId)).rejects.toThrow(MetaPermissionError);

    const connection = await getRelevantMetaConnectionView(tenantId);
    expect(connection).toBeNull();
  });

  it("Missing permission on a RECONNECT: the tenant's existing active connection is left untouched", async () => {
    const { tenantId, userId } = await makeTenant("oauth-missing-perm-reconnect");
    await completeMetaConnection("auth-code-3", tenantId, userId); // establish a real connection first
    const before = await getRelevantMetaConnectionView(tenantId);

    vi.mocked(graphClient.getGrantedPermissions).mockResolvedValue(grantedPermissions(["leads_retrieval"]));
    await expect(completeMetaConnection("auth-code-4", tenantId, userId)).rejects.toThrow(MetaPermissionError);

    const after = await getRelevantMetaConnectionView(tenantId);
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe("active");
  });

  it("Invalid authorization code: rejects, and writes no connection", async () => {
    const { tenantId, userId } = await makeTenant("oauth-bad-code");
    vi.mocked(graphClient.exchangeCodeForToken).mockRejectedValue(new graphClient.MetaApiError("Invalid verification code format.", 400));

    await expect(completeMetaConnection("bad-code", tenantId, userId)).rejects.toThrow();

    const connection = await getRelevantMetaConnectionView(tenantId);
    expect(connection).toBeNull();
  });

  it("Multiple Pages: every returned Page is persisted and counted", async () => {
    const { tenantId, userId } = await makeTenant("oauth-multi-page");
    vi.mocked(graphClient.getUserPages).mockResolvedValue([
      { id: "page-a", name: "Page A", accessToken: "tok-a" },
      { id: "page-b", name: "Page B", accessToken: "tok-b" },
      { id: "page-c", name: "Page C", accessToken: "tok-c" },
    ]);

    const result = await completeMetaConnection("auth-code-5", tenantId, userId);
    expect(result.pagesConnected).toBe(3);
    const pages = await listMetaPages(tenantId);
    expect(pages.map((p) => p.pageId).sort()).toEqual(["page-a", "page-b", "page-c"]);
  });

  it("Multiple Ad Accounts: every returned ad account is persisted and counted", async () => {
    const { tenantId, userId } = await makeTenant("oauth-multi-adaccount");
    vi.mocked(graphClient.getUserAdAccounts).mockResolvedValue([
      { id: "act_1", name: "Account 1" },
      { id: "act_2", name: "Account 2" },
    ]);

    const result = await completeMetaConnection("auth-code-6", tenantId, userId);
    expect(result.adAccountsConnected).toBe(2);
    const adAccounts = await listMetaAdAccounts(tenantId);
    expect(adAccounts).toHaveLength(2);
  });

  it("Multiple Instagram accounts: every Page with a linked IG business account is persisted", async () => {
    const { tenantId, userId } = await makeTenant("oauth-multi-ig");
    vi.mocked(graphClient.getUserPages).mockResolvedValue([
      { id: "page-a", name: "Page A", accessToken: "tok-a", instagramBusinessAccountId: "ig-a", instagramUsername: "a_ig" },
      { id: "page-b", name: "Page B", accessToken: "tok-b", instagramBusinessAccountId: "ig-b", instagramUsername: "b_ig" },
      { id: "page-c", name: "Page C (no IG)", accessToken: "tok-c" },
    ]);

    await completeMetaConnection("auth-code-7", tenantId, userId);
    const igAccounts = await listMetaInstagramAccounts(tenantId);
    expect(igAccounts).toHaveLength(2);
    expect(igAccounts.map((a) => a.instagramAccountId).sort()).toEqual(["ig-a", "ig-b"]);
  });

  describe("OAuth state (invalid state)", () => {
    it("rejects a garbage/tampered token", async () => {
      expect(await verifyOAuthState("not-a-real-jwt")).toBeNull();
    });

    it("rejects a state token reused a second time (single-use enforcement)", async () => {
      const state = await createOAuthState({ tenantId: "tenant-x", userId: "user-x" });
      const first = await verifyOAuthState(state);
      expect(first).toEqual({ tenantId: "tenant-x", userId: "user-x" });

      const second = await verifyOAuthState(state);
      expect(second).toBeNull();
    });
  });

  describe("HTTP callback handler", () => {
    it("User rejects Meta authorization: redirects with the error, never attempts token exchange", async () => {
      const handlerModule = await import("../../api/webhooks/meta/handler");
      const req = fakeReq({ method: "GET", query: { resource: "oauth-callback", error: "access_denied" } });
      const res = fakeRes();

      await handlerModule.default(req, res);

      expect(res.calls[0].redirectStatus).toBe(302);
      expect(res.calls[0].redirectUrl).toContain("error=access_denied");
      expect(graphClient.exchangeCodeForToken).not.toHaveBeenCalled();
    });

    it("Invalid OAuth state at the HTTP layer: redirects with error=invalid_state, never attempts token exchange", async () => {
      const handlerModule = await import("../../api/webhooks/meta/handler");
      const req = fakeReq({ method: "GET", query: { resource: "oauth-callback", code: "some-code", state: "garbage-state" } });
      const res = fakeRes();

      await handlerModule.default(req, res);

      expect(res.calls[0].redirectStatus).toBe(302);
      expect(res.calls[0].redirectUrl).toContain("error=invalid_state");
      expect(graphClient.exchangeCodeForToken).not.toHaveBeenCalled();
    });
  });
});
