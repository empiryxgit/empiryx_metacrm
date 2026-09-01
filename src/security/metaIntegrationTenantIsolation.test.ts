// Security/correctness tests for "Meta authentication belongs to the client
// organization" - a CRITICAL architecture requirement, directly analogous
// to (and building on) tenantIsolation.test.ts / agencyClientIsolation.test.ts:
//
//   "The agency itself should NOT automatically use one Meta connection for
//   every client. Each client must authorize its own Meta assets. The
//   agency may assist with setup only where the permission model allows it."
//
// api/webhooks/meta/handler.ts's Meta OAuth/integration handlers now run
// every request through withEffectiveCompanyContext (see that file's own
// header comment), exactly like dashboard/pipeline/leads/campaigns/forms
// already did - this is the regression suite proving that actually holds,
// end to end, through the real HTTP handler function (not just at the
// withEffectiveCompanyContext unit level, which agencyClientIsolation.test.ts
// already covers generically). Same real-Postgres, no-mocking convention
// (only Redis/QStash are mocked, globally, via vitest.setup.ts) as every
// other Security suite in this codebase.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import handler from "../../api/webhooks/meta/handler";
import { fakeReq, fakeRes } from "../testSupport/httpFixtures";
import { getDb } from "../infrastructure/db/client";
import { agencyClients, agencyClientAssignments } from "../infrastructure/db/schema";
import { signAccessToken, ACCESS_COOKIE_NAME, CLIENT_CONTEXT_COOKIE_NAME } from "../infrastructure/auth/tokens";
import { verifyOAuthState } from "../infrastructure/auth/oauthState";
import { upsertMetaConnection } from "../infrastructure/db/repositories/metaIntegration";
import { PERMISSIONS } from "../domain/permissions";
import { makeTenant } from "../testSupport/dbFixtures";

async function accessCookieFor(companyId: string, userId: string, assignedClientIds: string[] = []): Promise<string> {
  const token = await signAccessToken({
    sub: userId,
    companyId,
    roleId: randomUUID(),
    permissions: [PERMISSIONS.INTEGRATIONS_MANAGE],
    // assignedClientIds is JWT-baked (see resolveAgencyClientAccess's own
    // comment) - the agency_client_assignments row alone is not enough to
    // grant access at request time, exactly like a real login/refresh has
    // to bake it in. AGENCY_OWNER/AGENCY_CLIENTS_VIEW_ALL is deliberately
    // NOT used here so these tests exercise the assignment-scoped path
    // every non-owner agency tier actually goes through.
    assignedClientIds,
  });
  return `${ACCESS_COOKIE_NAME}=${token}`;
}

function cookieHeader(accessCookie: string, clientContextClientId?: string): string {
  return clientContextClientId ? `${accessCookie}; ${CLIENT_CONTEXT_COOKIE_NAME}=${clientContextClientId}` : accessCookie;
}

async function claimAndAssign(agencyCompanyId: string, clientCompanyId: string, userId: string, status: "active" | "suspended" = "active") {
  const db = await getDb();
  await db.insert(agencyClients).values({ agencyCompanyId, clientCompanyId, status });
  await db.insert(agencyClientAssignments).values({ agencyCompanyId, clientCompanyId, userId });
}

describe.skipIf(!process.env.DATABASE_URL)("Security: Meta integration tenant isolation (client-owned Meta authentication)", () => {
  it("GET /api/integrations/meta/connect while managing a client seals the CLIENT's own company id into the OAuth state - never the agency's", async () => {
    const agency = await makeTenant("meta-agency1", "agency");
    const client = await makeTenant("meta-client1");
    await claimAndAssign(agency.tenantId, client.tenantId, agency.userId);

    const cookie = cookieHeader(await accessCookieFor(agency.tenantId, agency.userId, [client.tenantId]), client.tenantId);
    const req = fakeReq({ method: "GET", query: { resource: "oauth-connect" }, headers: { cookie } });
    const res = fakeRes();

    await handler(req, res);

    expect(res.calls).toHaveLength(1);
    expect(res.calls[0]?.redirectStatus).toBe(302);
    const location = new URL(res.calls[0]!.redirectUrl!);
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();

    const claims = await verifyOAuthState(state!);
    expect(claims).not.toBeNull();
    // THE assertion this whole requirement rests on: the connection this
    // flow is about to create belongs to the CLIENT, not the agency,
    // even though the agency user is the one clicking "Connect".
    expect(claims!.tenantId).toBe(client.tenantId);
    expect(claims!.tenantId).not.toBe(agency.tenantId);
    // Who actually performed the connect stays the real agency user - "the
    // agency may assist with setup" is an audit fact, not an ownership one.
    expect(claims!.userId).toBe(agency.userId);
  });

  it("GET /api/integrations/meta/connect with no active client context seals the caller's OWN company - agency users connecting for themselves are unaffected", async () => {
    const agency = await makeTenant("meta-agency2", "agency");
    const cookie = cookieHeader(await accessCookieFor(agency.tenantId, agency.userId));
    const req = fakeReq({ method: "GET", query: { resource: "oauth-connect" }, headers: { cookie } });
    const res = fakeRes();

    await handler(req, res);

    const location = new URL(res.calls[0]!.redirectUrl!);
    const claims = await verifyOAuthState(location.searchParams.get("state")!);
    expect(claims!.tenantId).toBe(agency.tenantId);
  });

  it("a client-context cookie naming a client this caller can no longer manage falls back to the caller's own company - never attributes a connection to an unauthorized client", async () => {
    const agency = await makeTenant("meta-agency3", "agency");
    const otherAgency = await makeTenant("meta-otheragency3", "agency");
    const foreignClient = await makeTenant("meta-foreignclient3");
    // Claimed by a DIFFERENT agency entirely - agency3 has no relationship
    // to it at all, yet a forged/stale cookie names it anyway.
    await claimAndAssign(otherAgency.tenantId, foreignClient.tenantId, otherAgency.userId);

    const cookie = cookieHeader(await accessCookieFor(agency.tenantId, agency.userId), foreignClient.tenantId);
    const req = fakeReq({ method: "GET", query: { resource: "oauth-connect" }, headers: { cookie } });
    const res = fakeRes();

    await handler(req, res);

    const location = new URL(res.calls[0]!.redirectUrl!);
    const claims = await verifyOAuthState(location.searchParams.get("state")!);
    expect(claims!.tenantId).toBe(agency.tenantId);
    expect(claims!.tenantId).not.toBe(foreignClient.tenantId);
  });

  it("GET /api/integrations/meta/oauth-status while managing a client returns THAT CLIENT's own Meta connection - the agency's own separate connection is never shown, and is untouched by reading it", async () => {
    const agency = await makeTenant("meta-agency4", "agency");
    const client = await makeTenant("meta-client4");
    await claimAndAssign(agency.tenantId, client.tenantId, agency.userId);

    // Two genuinely separate connections in the same database - exactly the
    // architecture diagram this requirement is built from (Agency's own
    // connection vs Client A's own connection, never merged/shared).
    await upsertMetaConnection({
      tenantId: agency.tenantId,
      metaUserId: "agency-own-meta-user",
      metaUserName: "Agency Meta Account",
      accessToken: "agency-plaintext-token",
      tokenExpiresAt: null,
    });
    await upsertMetaConnection({
      tenantId: client.tenantId,
      metaUserId: "client-own-meta-user",
      metaUserName: "Client Meta Account",
      accessToken: "client-plaintext-token",
      tokenExpiresAt: null,
    });

    const accessCookie = await accessCookieFor(agency.tenantId, agency.userId, [client.tenantId]);

    // While managing the client - must see the CLIENT's connection.
    const inContextReq = fakeReq({ method: "GET", query: { resource: "oauth-status" }, headers: { cookie: cookieHeader(accessCookie, client.tenantId) } });
    const inContextRes = fakeRes();
    await handler(inContextReq, inContextRes);
    const inContextBody = inContextRes.calls[0]?.json as { connection: { metaUserName: string } | null };
    expect(inContextBody.connection?.metaUserName).toBe("Client Meta Account");

    // Back in its own agency context - must see the AGENCY's own connection,
    // completely unaffected by having just read the client's.
    const ownReq = fakeReq({ method: "GET", query: { resource: "oauth-status" }, headers: { cookie: cookieHeader(accessCookie) } });
    const ownRes = fakeRes();
    await handler(ownReq, ownRes);
    const ownBody = ownRes.calls[0]?.json as { connection: { metaUserName: string } | null };
    expect(ownBody.connection?.metaUserName).toBe("Agency Meta Account");
  });

  it("a client's own user (no agency relationship at all) always sees and manages only its own Meta connection, regardless of any cookie", async () => {
    const client = await makeTenant("meta-plainclient5");
    await upsertMetaConnection({
      tenantId: client.tenantId,
      metaUserId: "plain-client-meta-user",
      metaUserName: "Plain Client Meta Account",
      accessToken: "plain-client-plaintext-token",
      tokenExpiresAt: null,
    });

    // A client-context cookie is meaningless for a non-agency company - even
    // if one were somehow present, checkAgencyCanManageClient's own
    // agencyCompany.accountType !== "agency" check rejects it outright.
    const cookie = cookieHeader(await accessCookieFor(client.tenantId, client.userId), randomUUID());
    const req = fakeReq({ method: "GET", query: { resource: "oauth-status" }, headers: { cookie } });
    const res = fakeRes();
    await handler(req, res);

    const body = res.calls[0]?.json as { connection: { metaUserName: string } | null };
    expect(body.connection?.metaUserName).toBe("Plain Client Meta Account");
  });
});
