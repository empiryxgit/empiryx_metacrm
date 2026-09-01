// Security tests for the agency "client switcher" (see
// src/application/agencyClientContext.ts): formalizes the hard requirement
// this feature was built under - "every client remains a separate tenant
// boundary... Client A must NEVER access Client B's Leads/Users/Campaigns/
// Meta connections/Forms/Settings/Reports/Integrations unless explicitly
// authorized through agency-level access. The agency relationship must
// grant controlled access, not merge the tenants."
//
// Same real-Postgres, no-mocking convention as tenantIsolation.test.ts
// (Phase 20) - every assertion here exercises the actual DB-backed
// checkAgencyCanManageClient/resolveActiveClientContext/
// withEffectiveCompanyContext functions a live request goes through, plus
// a real cross-tenant data read (listCampaigns) proving the effective
// companyId swap never leaks a second tenant's rows. Requires
// DATABASE_URL - see docs/TESTING.md; skips otherwise.

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { VercelRequest } from "@vercel/node";
import { describe, expect, it } from "vitest";
import { getDb } from "../infrastructure/db/client";
import { agencyClients, agencyClientAssignments } from "../infrastructure/db/schema";
import { createCampaign, listCampaigns } from "../infrastructure/db/repositories/campaigns";
import type { AuthContext } from "../infrastructure/auth/context";
import { CLIENT_CONTEXT_COOKIE_NAME } from "../infrastructure/auth/tokens";
import {
  checkAgencyCanManageClient,
  resolveActiveClientContext,
  withEffectiveCompanyContext,
} from "../application/agencyClientContext";
import { makeTenant } from "../testSupport/dbFixtures";

function fakeReq(cookieValue: string | undefined): VercelRequest {
  return {
    headers: { cookie: cookieValue ? `${CLIENT_CONTEXT_COOKIE_NAME}=${cookieValue}` : undefined },
  } as unknown as VercelRequest;
}

function authFor(companyId: string, userId: string, assignedClientIds: string[] = []): AuthContext {
  return {
    userId,
    sub: userId,
    companyId,
    roleId: randomUUID(), // unused by every function under test - never consulted for tenant scoping
    permissions: [],
    assignedClientIds,
  };
}

describe.skipIf(!process.env.DATABASE_URL)("Security: agency client-switcher tenant isolation", () => {
  it("an agency user assigned ONLY to Client A can never enter Client B's context, even though both are claimed by the SAME agency", async () => {
    const agency = await makeTenant("acx-agency1", "agency");
    const clientA = await makeTenant("acx-clientA1");
    const clientB = await makeTenant("acx-clientB1");
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values({
      agencyCompanyId: agency.tenantId,
      clientCompanyId: clientA.tenantId,
      userId: agency.userId,
    });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId]);

    expect((await checkAgencyCanManageClient(auth, clientA.tenantId)).ok).toBe(true);
    expect((await checkAgencyCanManageClient(auth, clientB.tenantId)).ok).toBe(false);

    // Same guarantee via the actual cookie-reading path a request takes.
    const ctxA = await resolveActiveClientContext(fakeReq(clientA.tenantId), auth);
    expect(ctxA?.clientCompanyId).toBe(clientA.tenantId);
    const ctxB = await resolveActiveClientContext(fakeReq(clientB.tenantId), auth);
    expect(ctxB).toBeNull(); // silent fallback, never an override to a client outside this user's own assignment
  });

  it("a client claimed by a DIFFERENT agency is never reachable, even for that other agency's Owner-equivalent (unrestricted) user", async () => {
    const agencyX = await makeTenant("acx-agencyX", "agency");
    const agencyY = await makeTenant("acx-agencyY", "agency");
    const clientOfY = await makeTenant("acx-clientOfY");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agencyY.tenantId, clientCompanyId: clientOfY.tenantId, status: "active" });

    // assignedClientIds intentionally empty AND resolveAgencyClientAccess
    // isn't even consulted here - checkAgencyCanManageClient must reject
    // on the agency-ownership mismatch alone, before assignment ever
    // matters, since agencyX has no claim on this client at all.
    const agencyXAuth = authFor(agencyX.tenantId, agencyX.userId, []);
    expect((await checkAgencyCanManageClient(agencyXAuth, clientOfY.tenantId)).ok).toBe(false);
  });

  it("a client company's OWN user can never enter any agency context - checkAgencyCanManageClient requires the caller's own company to actually BE an agency", async () => {
    const clientCompany = await makeTenant("acx-plainclient");
    const auth = authFor(clientCompany.tenantId, clientCompany.userId, []);
    // Even naming its own companyId as the "client" - there is no
    // legitimate case where a non-agency company's own user manages
    // anything through this mechanism.
    expect((await checkAgencyCanManageClient(auth, clientCompany.tenantId)).ok).toBe(false);
  });

  it("removed relationship revokes access; suspended does not", async () => {
    const agency = await makeTenant("acx-agency2", "agency");
    const client = await makeTenant("acx-client2");
    const db = await getDb();
    await db.insert(agencyClients).values({ agencyCompanyId: agency.tenantId, clientCompanyId: client.tenantId, status: "active" });
    await db.insert(agencyClientAssignments).values({ agencyCompanyId: agency.tenantId, clientCompanyId: client.tenantId, userId: agency.userId });
    const auth = authFor(agency.tenantId, agency.userId, [client.tenantId]);

    await db
      .update(agencyClients)
      .set({ status: "suspended" })
      .where(and(eq(agencyClients.agencyCompanyId, agency.tenantId), eq(agencyClients.clientCompanyId, client.tenantId)));
    expect((await checkAgencyCanManageClient(auth, client.tenantId)).ok).toBe(true);

    await db
      .update(agencyClients)
      .set({ status: "removed" })
      .where(and(eq(agencyClients.agencyCompanyId, agency.tenantId), eq(agencyClients.clientCompanyId, client.tenantId)));
    expect((await checkAgencyCanManageClient(auth, client.tenantId)).ok).toBe(false);
  });

  it("withEffectiveCompanyContext + a real data read never blends two clients' rows: only the ACTIVE context's own campaigns come back, even when both clients have campaigns and the agency is assigned to both", async () => {
    const agency = await makeTenant("acx-agency3", "agency");
    const clientA = await makeTenant("acx-clientA3");
    const clientB = await makeTenant("acx-clientB3");
    const db = await getDb();
    await db.insert(agencyClients).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, status: "active" },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, status: "active" },
    ]);
    await db.insert(agencyClientAssignments).values([
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientA.tenantId, userId: agency.userId },
      { agencyCompanyId: agency.tenantId, clientCompanyId: clientB.tenantId, userId: agency.userId },
    ]);
    const campaignA = await createCampaign({ companyId: clientA.tenantId, name: "Client A's own campaign", platform: "facebook", createdBy: clientA.userId });
    const campaignB = await createCampaign({ companyId: clientB.tenantId, name: "Client B's own campaign", platform: "facebook", createdBy: clientB.userId });

    const auth = authFor(agency.tenantId, agency.userId, [clientA.tenantId, clientB.tenantId]);

    // Enter Client A's context - this is the exact swap
    // api/campaigns/handler.ts (and dashboard/pipeline/leads/forms) applies
    // to `auth` right after requirePermission succeeds.
    const effectiveA = await withEffectiveCompanyContext(fakeReq(clientA.tenantId), auth);
    expect(effectiveA.companyId).toBe(clientA.tenantId);
    const campaignsSeenWhileInA = await listCampaigns(effectiveA.companyId);
    const idsSeenWhileInA = campaignsSeenWhileInA.map((c) => c.id);
    expect(idsSeenWhileInA).toContain(campaignA.id);
    expect(idsSeenWhileInA).not.toContain(campaignB.id); // Client B's campaign must never appear

    // Switch to Client B's context - the mirror image must also hold.
    const effectiveB = await withEffectiveCompanyContext(fakeReq(clientB.tenantId), auth);
    expect(effectiveB.companyId).toBe(clientB.tenantId);
    const campaignsSeenWhileInB = await listCampaigns(effectiveB.companyId);
    const idsSeenWhileInB = campaignsSeenWhileInB.map((c) => c.id);
    expect(idsSeenWhileInB).toContain(campaignB.id);
    expect(idsSeenWhileInB).not.toContain(campaignA.id); // Client A's campaign must never appear

    // No cookie at all - the agency's own company scope, never either client's.
    const effectiveNone = await withEffectiveCompanyContext(fakeReq(undefined), auth);
    expect(effectiveNone.companyId).toBe(agency.tenantId);

    // Authorization (permissions/role/userId) is untouched by the swap -
    // only the DATA SCOPE (companyId) changes, exactly as documented in
    // withEffectiveCompanyContext's own comment.
    expect(effectiveA.userId).toBe(auth.userId);
    expect(effectiveA.permissions).toBe(auth.permissions);
  });
});
