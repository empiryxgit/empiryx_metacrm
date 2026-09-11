// RUTA AI Assistant - isolation, concurrency, and webhook-duplicate
// acceptance tests. Same real-Postgres, no-mocking convention as every
// other *.flow.test.ts file in this codebase (see webhook.flow.test.ts /
// whatsapp.flow.test.ts) - only graphClient's network call
// (sendWhatsappTextMessage) is mocked; Postgres, Redis fakes (via
// vitest.setup.ts), and every layer of the real orchestrator
// (rutaAiAssistant.ts / rutaTools.ts / rutaDateRange.ts) run for real.
// Requires DATABASE_URL - see docs/TESTING.md; skips otherwise.
//
// Proves the six properties required of the WhatsApp orchestration layer:
//   1. User isolation       - "User isolation"
//   2. Tenant isolation     - "Tenant isolation"
//   3. Role/permission isolation - "Role/permission isolation"
//   4. Session isolation    - "Session isolation"
//   5. Concurrent conversations  - "Concurrent conversations"
//   6. Webhook duplicate/retry handling - "Webhook duplicate/retry handling"
//
// Fixtures deliberately bypass the full Meta OAuth/discovery flow
// (connectWithOneWhatsappNumber in whatsapp.flow.test.ts) - that flow is
// already covered elsewhere and isn't what these tests are about. Instead
// makeRutaTenant inserts the minimal metaConnections/metaWhatsappAccounts
// rows getSendContext (rutaAiAssistant.ts) actually reads, which keeps
// each test focused and fast while still exercising 100% real DB reads.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { getDb } from "../../infrastructure/db/client";
import { companies, leads, metaConnections, metaWhatsappAccounts, roles, users } from "../../infrastructure/db/schema";
import { encryptSecret } from "../../infrastructure/security/encryption";
import { upsertUserWhatsappLink } from "../../infrastructure/db/repositories/whatsapp";
import { PERMISSIONS } from "../../domain/permissions";
import { handleRutaAssistantMessages, type RutaAssistantInboundMessage } from "./rutaAiAssistant";
import { dayOffsetRange, todayRange } from "./rutaDateRange";

vi.mock("../../infrastructure/meta/graphClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infrastructure/meta/graphClient")>();
  return { ...actual, sendWhatsappTextMessage: vi.fn(async () => {}) };
});

const TZ = "Asia/Kolkata";

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** A fresh tenant with a real, minimal, SELECTED WhatsApp send context -
 * exactly the rows getSendContext (rutaAiAssistant.ts) reads, inserted
 * directly rather than driving the full OAuth/discovery flow (already
 * covered by whatsapp.flow.test.ts). */
async function makeRutaTenant(label: string): Promise<string> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Ruta ${label}`, slug: unique(`ruta-${label}`), accountType: "individual", timezone: TZ }).returning();
  const [conn] = await db
    .insert(metaConnections)
    .values({ tenantId: company!.id, metaUserId: unique("meta-user"), accessTokenEncrypted: encryptSecret("fake-access-token") })
    .returning();
  await db.insert(metaWhatsappAccounts).values({ tenantId: company!.id, metaConnectionId: conn!.id, wabaId: unique("waba"), phoneNumberId: unique("phone"), isSelected: true });
  return company!.id;
}

async function makeRutaRole(tenantId: string, broadGrant: boolean): Promise<string> {
  const db = await getDb();
  const [role] = await db
    .insert(roles)
    .values({ companyId: tenantId, name: broadGrant ? "Broad" : "Restricted", permissions: broadGrant ? [PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY] : [], isSystem: true })
    .returning();
  return role!.id;
}

async function makeRutaUser(tenantId: string, roleId: string, label: string, phoneNumber: string): Promise<string> {
  const db = await getDb();
  const [user] = await db.insert(users).values({ companyId: tenantId, roleId, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: label, phoneNumber }).returning();
  const result = await upsertUserWhatsappLink(tenantId, user!.id, phoneNumber);
  expect(result.ok).toBe(true); // sanity: the link actually took
  return user!.id;
}

async function insertLead(tenantId: string, opts: { ownerId?: string | null; fullName?: string; source?: string; campaignName?: string; crmCampaignId?: string | null; metaCreatedAt?: Date } = {}): Promise<void> {
  const db = await getDb();
  await db.insert(leads).values({
    companyId: tenantId,
    metaLeadId: unique("lead"),
    metaCreatedAt: opts.metaCreatedAt ?? new Date(),
    ownerId: opts.ownerId ?? null,
    fullName: opts.fullName ?? null,
    source: opts.source ?? "meta_lead_ads",
    campaignName: opts.campaignName ?? null,
    crmCampaignId: opts.crmCampaignId ?? null,
  });
}

function inboundMessage(tenantId: string, fromPhoneNumber: string, messageText: string, waMessageId = `wamid.${randomUUID()}`): RutaAssistantInboundMessage {
  return { tenantId, fromPhoneNumber, waMessageId, messageText };
}

/** Sends one message through the REAL pipeline and returns the body of the
 * ONE reply it produced (if any) - reads only the calls made DURING this
 * call, so sequential tests never need to worry about earlier calls in the
 * same test file bleeding into a later assertion. */
async function sendAndGetReply(tenantId: string, fromPhoneNumber: string, text: string, waMessageId?: string): Promise<string | undefined> {
  const before = vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls.length;
  await handleRutaAssistantMessages([inboundMessage(tenantId, fromPhoneNumber, text, waMessageId)]);
  const calls = vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls.slice(before);
  return calls[0]?.[3];
}

function replyCallCount(): number {
  return vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls.length;
}

describe.skipIf(!process.env.DATABASE_URL)("RUTA AI Assistant - isolation, concurrency, webhook duplicates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------
  // 1. User isolation
  // ---------------------------------------------------------------------
  it("User isolation: a personal query never returns another user's data, even inside the same tenant", async () => {
    const tenantId = await makeRutaTenant("user-iso");
    const roleId = await makeRutaRole(tenantId, false);
    const phoneA = unique("ph-a");
    const phoneB = unique("ph-b");
    const userA = await makeRutaUser(tenantId, roleId, "Alice UserIso", phoneA);
    const userB = await makeRutaUser(tenantId, roleId, "Bob UserIso", phoneB);

    await insertLead(tenantId, { ownerId: userA, fullName: "Alice Lead One" });
    await insertLead(tenantId, { ownerId: userA, fullName: "Alice Lead Two" });
    await insertLead(tenantId, { ownerId: userB, fullName: "Bob Lead One" });

    const replyA = await sendAndGetReply(tenantId, phoneA, "my leads today");
    expect(replyA).toContain("2 leads today");
    expect(replyA).not.toContain("Bob Lead"); // never another user's rows

    const replyB = await sendAndGetReply(tenantId, phoneB, "my leads today");
    expect(replyB).toContain("1 lead today");
    expect(replyB).not.toContain("Alice Lead");

    // A second, independently-scoped tool (updateOnX, non-broad role): A
    // can look up A's own lead by name, but the SAME search from B (who
    // does not own it, and has no broad-query grant) must find nothing.
    const foundByOwner = await sendAndGetReply(tenantId, phoneA, "update on Alice Lead One");
    expect(foundByOwner).toContain("Alice Lead One");
    const notFoundByOther = await sendAndGetReply(tenantId, phoneB, "update on Alice Lead One");
    expect(notFoundByOther).toContain("No lead or teammate found");
  });

  // ---------------------------------------------------------------------
  // 2. Tenant isolation
  // ---------------------------------------------------------------------
  it("Tenant isolation: identical WhatsApp identity, linked to two different tenants, never leaks either tenant's data into the other", async () => {
    const tenantA = await makeRutaTenant("tenant-iso-a");
    const tenantB = await makeRutaTenant("tenant-iso-b");
    const roleA = await makeRutaRole(tenantA, false);
    const roleB = await makeRutaRole(tenantB, false);
    // The SAME raw phone number, deliberately linked in BOTH tenants -
    // userWhatsappLinks' unique index is (tenantId, phoneNumber), so this
    // is a legitimate, supported shape (the same salesperson working two
    // client accounts), and the sharpest possible tenant-isolation test.
    const sharedPhone = unique("ph-shared");
    await makeRutaUser(tenantA, roleA, "Shared User A-side", sharedPhone);
    await makeRutaUser(tenantB, roleB, "Shared User B-side", sharedPhone);

    for (let i = 0; i < 3; i++) await insertLead(tenantA, { campaignName: "Campaign A" });
    for (let i = 0; i < 5; i++) await insertLead(tenantB, { campaignName: "Campaign B" });

    const replyA = await sendAndGetReply(tenantA, sharedPhone, "how many leads today");
    expect(replyA).toContain("3 leads today");
    const replyB = await sendAndGetReply(tenantB, sharedPhone, "how many leads today");
    expect(replyB).toContain("5 leads today");

    const campaignReplyA = await sendAndGetReply(tenantA, sharedPhone, "which campaign gave the most");
    expect(campaignReplyA).toContain("Campaign A");
    expect(campaignReplyA).not.toContain("Campaign B");

    const campaignReplyB = await sendAndGetReply(tenantB, sharedPhone, "which campaign gave the most");
    expect(campaignReplyB).toContain("Campaign B");
    expect(campaignReplyB).not.toContain("Campaign A");
  });

  // ---------------------------------------------------------------------
  // 3. Role/permission isolation
  // ---------------------------------------------------------------------
  it("Role/permission isolation: RUTA_AI_ASSISTANT_BROAD_QUERY gates cross-teammate data, enforced in rutaTools.ts - never by the LLM", async () => {
    const tenantId = await makeRutaTenant("role-iso");
    const restrictedRole = await makeRutaRole(tenantId, false);
    const broadRole = await makeRutaRole(tenantId, true);
    const phoneOwner = unique("ph-owner");
    const phoneRestricted = unique("ph-restricted");
    const phoneBroad = unique("ph-broad");
    const ownerUser = await makeRutaUser(tenantId, restrictedRole, "Owner RoleIso", phoneOwner);
    await makeRutaUser(tenantId, restrictedRole, "Restricted RoleIso", phoneRestricted);
    await makeRutaUser(tenantId, broadRole, "Broad RoleIso", phoneBroad);

    for (let i = 0; i < 4; i++) await insertLead(tenantId, { ownerId: ownerUser });

    // Without the grant, a cross-teammate breakdown silently falls back to
    // just the asking user's OWN count - never an error, never someone
    // else's numbers.
    const restrictedReply = await sendAndGetReply(tenantId, phoneRestricted, "leads by teammate");
    expect(restrictedReply).toMatch(/^You have 0 leads? today\.$/);

    // With the grant, the same phrasing returns the real company-wide
    // breakdown, including the owner's name and count.
    const broadReply = await sendAndGetReply(tenantId, phoneBroad, "leads by teammate");
    expect(broadReply).toContain("Owner RoleIso");
    expect(broadReply).toContain("4");

    // updateOnX's teammate search is gated the same way (audit Finding 2b) -
    // a restricted user searching a teammate BY NAME finds nothing at all
    // (not even a hint the teammate exists); a broad user finds them.
    const restrictedSearch = await sendAndGetReply(tenantId, phoneRestricted, "update on Owner RoleIso");
    expect(restrictedSearch).toContain("No lead or teammate found");
    const broadSearch = await sendAndGetReply(tenantId, phoneBroad, "update on Owner RoleIso");
    expect(broadSearch).toContain("Owner RoleIso");
    expect(broadSearch).not.toContain("No lead or teammate found");
  });

  // ---------------------------------------------------------------------
  // 4. Session isolation
  // ---------------------------------------------------------------------
  it("Session isolation: disambiguation and conversation-anchor state never cross between concurrent users, even on the same tenant", async () => {
    const tenantId = await makeRutaTenant("session-iso");
    const roleId = await makeRutaRole(tenantId, false);
    const phoneA = unique("ph-a");
    const phoneB = unique("ph-b");
    const userA = await makeRutaUser(tenantId, roleId, "Alice SessionIso", phoneA);
    await makeRutaUser(tenantId, roleId, "Bob SessionIso", phoneB);

    // --- disambiguation state ---
    await insertLead(tenantId, { ownerId: userA, fullName: "Priya Sharma" });
    await insertLead(tenantId, { ownerId: userA, fullName: "Priya Sharma" }); // deliberately ambiguous

    const disambiguateReply = await sendAndGetReply(tenantId, phoneA, "update on Priya");
    expect(disambiguateReply).toContain("Multiple matches");

    // B has no pending state of their own - a bare "1" must NOT resolve
    // against A's in-flight disambiguation.
    const bReplyToBareNumber = await sendAndGetReply(tenantId, phoneB, "1");
    expect(bReplyToBareNumber).toContain("Didn't catch that");

    // A's own "1" still resolves correctly, proving the state was never
    // touched (let alone consumed) by B's unrelated message.
    const aResolved = await sendAndGetReply(tenantId, phoneA, "1");
    expect(aResolved).toContain("Priya Sharma");
    expect(aResolved).not.toContain("Didn't catch that");

    // --- conversation-anchor state (conversational follow-ups) ---
    const today = todayRange(TZ);
    const yesterday = dayOffsetRange(TZ, 1);
    // Yesterday deliberately has MORE leads than today, so any accidental
    // leak of A's anchor into B's drill-down is unmistakable in the result.
    await insertLead(tenantId, { campaignName: "TodayCampaign", metaCreatedAt: new Date(today.start.getTime() + 60 * 60 * 1000) });
    await insertLead(tenantId, { campaignName: "TodayCampaign", metaCreatedAt: new Date(today.start.getTime() + 2 * 60 * 60 * 1000) });
    for (let i = 0; i < 5; i++) {
      await insertLead(tenantId, { campaignName: "YesterdayCampaign", metaCreatedAt: new Date(yesterday.start.getTime() + 60 * 60 * 1000) });
    }

    // A asks about YESTERDAY - this sets A's own anchor to "yesterday".
    const aYesterday = await sendAndGetReply(tenantId, phoneA, "how many leads yesterday");
    expect(aYesterday).toContain("5 leads yesterday");

    // B, who never asked a lead-count question at all, asks a drill-down
    // question with NO date of its own. If B's context leaked A's anchor,
    // this would report "YesterdayCampaign" (5 leads); correctly isolated,
    // it must default to TODAY - "TodayCampaign" (2 leads) - since B has no
    // anchor of their own.
    const bDrilldown = await sendAndGetReply(tenantId, phoneB, "which campaign gave the most");
    expect(bDrilldown).toContain("TodayCampaign");
    expect(bDrilldown).not.toContain("YesterdayCampaign");
  });

  // ---------------------------------------------------------------------
  // 5. Concurrent conversations
  // ---------------------------------------------------------------------
  it("Concurrent conversations: many simultaneous requests across several tenants/users never cross-talk (no shared mutable state)", async () => {
    const tenantX = await makeRutaTenant("concurrent-x");
    const tenantY = await makeRutaTenant("concurrent-y");
    const roleX = await makeRutaRole(tenantX, false);
    const roleY = await makeRutaRole(tenantY, false);

    // Four users, deliberately spread across two tenants (two users per
    // tenant), each with a DETERMINISTIC, DISTINCT expected lead count -
    // any cross-talk between concurrently-executing requests would show up
    // as at least one user receiving the wrong number.
    const participants = [
      { tenantId: tenantX, roleId: roleX, label: "X1", count: 2 },
      { tenantId: tenantX, roleId: roleX, label: "X2", count: 7 },
      { tenantId: tenantY, roleId: roleY, label: "Y1", count: 4 },
      { tenantId: tenantY, roleId: roleY, label: "Y2", count: 9 },
    ];

    const withPhones = await Promise.all(
      participants.map(async (p) => {
        const phoneNumber = unique(`ph-${p.label}`);
        const userId = await makeRutaUser(p.tenantId, p.roleId, p.label, phoneNumber);
        for (let i = 0; i < p.count; i++) await insertLead(p.tenantId, { ownerId: userId });
        return { ...p, phoneNumber };
      }),
    );

    // "my leads today" (owner-scoped), not "how many leads today"
    // (leadCount, deliberately COMPANY-WIDE - see leadCountTool's own
    // comment) - X1 and X2 share tenantX, so a company-wide count would
    // correctly return their COMBINED total for both and prove nothing
    // about per-request isolation. The owner-scoped tool is what actually
    // distinguishes "X1's own request" from "X2's own request" even though
    // they hit the same tenant, same table, same concurrent time window.
    //
    // Fired with Promise.all - genuinely interleaved concurrent execution,
    // not the sequential for-loop handleRutaAssistantMessages itself uses
    // for a single batch. This is the real deployment shape (independent
    // serverless invocations), not just an in-process loop.
    await Promise.all(withPhones.map((p) => handleRutaAssistantMessages([inboundMessage(p.tenantId, p.phoneNumber, "my leads today")])));

    for (const p of withPhones) {
      const call = vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls.find((c) => c[2] === p.phoneNumber);
      expect(call, `expected a reply to ${p.label} (${p.phoneNumber})`).toBeDefined();
      expect(call![3]).toContain(`${p.count} lead${p.count === 1 ? "" : "s"} today`);
    }
  });

  // ---------------------------------------------------------------------
  // 6. Webhook duplicate/retry handling
  // ---------------------------------------------------------------------
  it("Webhook duplicate/retry handling: a redelivered wamid is processed exactly once; a genuinely new message still gets a reply", async () => {
    const tenantId = await makeRutaTenant("webhook-dup");
    const roleId = await makeRutaRole(tenantId, false);
    const phoneNumber = unique("ph-dup");
    const userId = await makeRutaUser(tenantId, roleId, "Dup User", phoneNumber);
    await insertLead(tenantId, { ownerId: userId });
    await insertLead(tenantId, { ownerId: userId });

    const waMessageId = `wamid.${randomUUID()}`;
    const msg = inboundMessage(tenantId, phoneNumber, "how many leads today", waMessageId);

    await handleRutaAssistantMessages([msg]);
    expect(replyCallCount()).toBe(1);
    expect(vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls[0]![3]).toContain("2 leads today");

    // Simulated Meta webhook redelivery: the EXACT SAME message object
    // (same waMessageId) arrives again. Must be a silent no-op - no second
    // reply sent.
    await handleRutaAssistantMessages([msg]);
    expect(replyCallCount()).toBe(1);

    // A third redelivery, even batched together with itself, still only
    // ever produces the one original reply.
    await handleRutaAssistantMessages([msg, msg]);
    expect(replyCallCount()).toBe(1);

    // A genuinely NEW message (different wamid) from the same user is NOT
    // treated as a duplicate - dedupe is scoped to the message id, not the
    // user or the message text.
    const secondReply = await sendAndGetReply(tenantId, phoneNumber, "how many leads today");
    expect(secondReply).toContain("2 leads today");
    expect(replyCallCount()).toBe(2);
  });

  it("Webhook duplicate/retry handling: dedupe is scoped per-tenant, not by wamid alone", async () => {
    const tenantA = await makeRutaTenant("webhook-dup-tenant-a");
    const tenantB = await makeRutaTenant("webhook-dup-tenant-b");
    const roleA = await makeRutaRole(tenantA, false);
    const roleB = await makeRutaRole(tenantB, false);
    const phoneA = unique("ph-dup-a");
    const phoneB = unique("ph-dup-b");
    await makeRutaUser(tenantA, roleA, "Dup User A", phoneA);
    await makeRutaUser(tenantB, roleB, "Dup User B", phoneB);

    // The SAME wamid value, coincidentally, on two different tenants -
    // claiming it for tenant A must never block tenant B's own (tenantId,
    // waMessageId) claim.
    const sharedWamid = `wamid.${randomUUID()}`;
    await handleRutaAssistantMessages([inboundMessage(tenantA, phoneA, "how many leads today", sharedWamid)]);
    await handleRutaAssistantMessages([inboundMessage(tenantB, phoneB, "how many leads today", sharedWamid)]);

    expect(replyCallCount()).toBe(2);
  });
});
