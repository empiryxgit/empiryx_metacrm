// Real-Postgres integration tests for Settings -> Business Configuration ->
// Industry/Template (api/onboarding/handler.ts's "business-config" action).
// Same real-Postgres, no-mocking convention as src/security/
// tenantIsolation.test.ts / campaignTenantIsolation.test.ts.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import handler from "../../api/onboarding/handler";
import { fakeReq, fakeRes } from "../testSupport/httpFixtures";
import { makeTenant } from "../testSupport/dbFixtures";
import { signAccessToken, ACCESS_COOKIE_NAME } from "../infrastructure/auth/tokens";
import { PERMISSIONS } from "../domain/permissions";
import { getCompanyById } from "../infrastructure/db/repositories/tenancy";

async function cookieFor(companyId: string, userId: string, permissions: string[]): Promise<string> {
  const token = await signAccessToken({ sub: userId, companyId, roleId: randomUUID(), permissions });
  return `${ACCESS_COOKIE_NAME}=${token}`;
}

function req(opts: { method: string; cookie: string; body?: unknown }) {
  const r = fakeReq({ method: opts.method, query: { action: "business-config" }, headers: { cookie: opts.cookie } });
  if (opts.body !== undefined) r.body = opts.body;
  return r;
}

const VALID_CUSTOM_CONFIG = {
  name: "My Sales Process",
  pipelineName: "Sales Pipeline",
  stages: [
    { key: "new", label: "New", isInitial: true },
    { key: "won", label: "Won", isClosed: true, isWon: true },
  ],
  fields: [{ key: "budget", label: "Budget", type: "currency" }],
};

describe.skipIf(!process.env.DATABASE_URL)("Business Configuration API (api/onboarding/handler.ts?action=business-config)", () => {
  it("GET requires company.manage - a user without it is rejected", async () => {
    const tenant = await makeTenant("bizcfg-noperm");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, []);
    const res = fakeRes();
    await handler(req({ method: "GET", cookie }), res);
    expect(res.calls[0]?.status).toBe(403);
  });

  it("GET returns the current config, effective template and built-in catalog for a brand-new company (defaults to 'general')", async () => {
    const tenant = await makeTenant("bizcfg-get1");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, [PERMISSIONS.COMPANY_MANAGE]);
    const res = fakeRes();
    await handler(req({ method: "GET", cookie }), res);
    expect(res.calls[0]?.status).toBe(200);
    const body = res.calls[0]?.json as any;
    expect(body.current.industryTemplate).toBe("general");
    expect(body.current.customTemplateConfig).toBeNull();
    expect(body.effectiveTemplate.key).toBe("general");
    expect(Array.isArray(body.builtInTemplates)).toBe(true);
    expect(body.builtInTemplates.some((t: any) => t.key === "custom")).toBe(false);
    expect(body.industryKeys).toContain("custom");
  });

  it("PUT rejects an unrecognized industryTemplate", async () => {
    const tenant = await makeTenant("bizcfg-bad1");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, [PERMISSIONS.COMPANY_MANAGE]);
    const res = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "not_a_real_key" } }), res);
    expect(res.calls[0]?.status).toBe(400);
  });

  it("PUT requires company.manage - a user without it is rejected", async () => {
    const tenant = await makeTenant("bizcfg-noperm2");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, []);
    const res = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "solar" } }), res);
    expect(res.calls[0]?.status).toBe(403);
  });

  it("PUT switches to a built-in template and persists it - round-trips correctly on a subsequent GET", async () => {
    const tenant = await makeTenant("bizcfg-switch1");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, [PERMISSIONS.COMPANY_MANAGE]);

    const putRes = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "solar" } }), putRes);
    expect(putRes.calls[0]?.status).toBe(200);
    expect((putRes.calls[0]?.json as any).effectiveTemplate.key).toBe("solar");

    const company = await getCompanyById(tenant.tenantId);
    expect(company?.industryTemplate).toBe("solar");

    const getRes = fakeRes();
    await handler(req({ method: "GET", cookie }), getRes);
    expect((getRes.calls[0]?.json as any).current.industryTemplate).toBe("solar");
  });

  it("PUT rejects switching to 'custom' with no config supplied and none saved yet", async () => {
    const tenant = await makeTenant("bizcfg-customreject");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, [PERMISSIONS.COMPANY_MANAGE]);
    const res = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "custom" } }), res);
    expect(res.calls[0]?.status).toBe(400);
  });

  it("PUT rejects an invalid customTemplateConfig with the validator's specific error, regardless of the chosen industryTemplate", async () => {
    const tenant = await makeTenant("bizcfg-invalidcfg");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, [PERMISSIONS.COMPANY_MANAGE]);
    const res = fakeRes();
    // Previewing "solar" while still submitting a broken custom draft - the
    // draft must be rejected even though it isn't the active template.
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "solar", customTemplateConfig: { name: "" } } }), res);
    expect(res.calls[0]?.status).toBe(400);
    expect(typeof (res.calls[0]?.json as any).error).toBe("string");

    const company = await getCompanyById(tenant.tenantId);
    expect(company?.industryTemplate).toBe("general"); // unchanged - the whole request was rejected
  });

  it("PUT accepts switching to 'custom' with a valid config supplied in the same request, and builds the effective template from it", async () => {
    const tenant = await makeTenant("bizcfg-customok");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, [PERMISSIONS.COMPANY_MANAGE]);
    const res = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "custom", customTemplateConfig: VALID_CUSTOM_CONFIG } }), res);
    expect(res.calls[0]?.status).toBe(200);
    const effective = (res.calls[0]?.json as any).effectiveTemplate;
    expect(effective.name).toBe("My Sales Process");
    expect(effective.stages.map((s: any) => s.key)).toEqual(["new", "won"]);

    const company = await getCompanyById(tenant.tenantId);
    expect(company?.industryTemplate).toBe("custom");
    expect((company?.customTemplateConfig as any)?.name).toBe("My Sales Process");
  });

  it("a customTemplateConfig draft can be saved WITHOUT switching industryTemplate to 'custom' - previewing another template first", async () => {
    const tenant = await makeTenant("bizcfg-draft1");
    const cookie = await cookieFor(tenant.tenantId, tenant.userId, [PERMISSIONS.COMPANY_MANAGE]);

    const res = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "healthcare", customTemplateConfig: VALID_CUSTOM_CONFIG } }), res);
    expect(res.calls[0]?.status).toBe(200);

    const company = await getCompanyById(tenant.tenantId);
    expect(company?.industryTemplate).toBe("healthcare"); // active template is what was chosen, not "custom"
    expect((company?.customTemplateConfig as any)?.name).toBe("My Sales Process"); // draft still saved

    // The draft survives switching to a THIRD built-in template without
    // touching customTemplateConfig at all in that request.
    const res2 = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "ecommerce" } }), res2);
    expect(res2.calls[0]?.status).toBe(200);
    const company2 = await getCompanyById(tenant.tenantId);
    expect(company2?.industryTemplate).toBe("ecommerce");
    expect((company2?.customTemplateConfig as any)?.name).toBe("My Sales Process"); // still there

    // ...and can now be activated directly, since a valid config is already saved.
    const res3 = fakeRes();
    await handler(req({ method: "PUT", cookie, body: { industryTemplate: "custom" } }), res3);
    expect(res3.calls[0]?.status).toBe(200);
    expect((res3.calls[0]?.json as any).effectiveTemplate.name).toBe("My Sales Process");
  });
});
