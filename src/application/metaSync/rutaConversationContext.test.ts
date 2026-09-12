// RUTA Conversation Context (Phase F) - acceptance tests. Same real-
// Postgres, no-mocking convention as rutaAiAssistant.flow.test.ts (only
// graphClient's network call is mocked); requires DATABASE_URL, skips
// otherwise (see docs/TESTING.md).
//
// Two layers of coverage:
//   1. Repository-level (src/infrastructure/db/repositories/
//      rutaConversation.ts directly) - proves the isolation guarantee
//      itself (tenantId+userId+conversationId together, never
//      conversationId alone), conversation rollover after idle timeout,
//      and turn-history compaction (MAX_TURNS_PER_CONVERSATION).
//   2. Orchestrator-level (rutaAiAssistant.ts, via handleRutaAssistantMessages)
//      - the spec's own conversational example end to end (anchor ->
//      drill-down -> bare-date follow-up re-running the ORIGINAL anchor),
//      proof the compact turn history is actually written, and proof that
//      conversation-context resolution never expands what a
//      permission-gated tool is willing to return.

import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as graphClient from "../../infrastructure/meta/graphClient";
import { getDb } from "../../infrastructure/db/client";
import { companies, leads, metaConnections, metaWhatsappAccounts, roles, rutaConversationTurns, rutaConversations, users } from "../../infrastructure/db/schema";
import { encryptSecret } from "../../infrastructure/security/encryption";
import { upsertUserWhatsappLink } from "../../infrastructure/db/repositories/whatsapp";
import { PERMISSIONS } from "../../domain/permissions";
import {
  CONVERSATION_IDLE_TIMEOUT_MINUTES,
  MAX_TURNS_PER_CONVERSATION,
  clearPendingContext,
  getOrCreateActiveConversation,
  getPendingContext,
  listConversationTurns,
  recordConversationTurn,
  setPendingContext,
} from "../../infrastructure/db/repositories/rutaConversation";
import { handleRutaAssistantMessages, type RutaAssistantInboundMessage } from "./rutaAiAssistant";

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
// Fixtures - the minimal rows each layer of coverage needs.
// ---------------------------------------------------------------------------

/** Bare tenant + user, no WhatsApp/send-context wiring - all the
 * repository-level tests need, since rutaConversation.ts only ever takes
 * (tenantId, userId, ...), never a phone number lookup. */
async function makeBareTenantAndUser(label: string): Promise<{ tenantId: string; userId: string }> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Ruta ${label}`, slug: unique(`ruta-${label}`), accountType: "individual", timezone: TZ }).returning();
  const [role] = await db.insert(roles).values({ companyId: company!.id, name: "Role", permissions: [], isSystem: true }).returning();
  const [user] = await db.insert(users).values({ companyId: company!.id, roleId: role!.id, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: label, phoneNumber: unique("ph") }).returning();
  return { tenantId: company!.id, userId: user!.id };
}

/** Full send-context tenant (mirrors rutaAiAssistant.flow.test.ts's
 * makeRutaTenant) - needed only for the orchestrator-level tests below. */
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
    .values({ companyId: tenantId, name: unique(broadGrant ? "Broad" : "Restricted"), permissions: broadGrant ? [PERMISSIONS.RUTA_AI_ASSISTANT_BROAD_QUERY] : [], isSystem: true })
    .returning();
  return role!.id;
}

async function makeRutaUser(tenantId: string, roleId: string, label: string, phoneNumber: string): Promise<string> {
  const db = await getDb();
  const [user] = await db.insert(users).values({ companyId: tenantId, roleId, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: label, phoneNumber }).returning();
  const result = await upsertUserWhatsappLink(tenantId, user!.id, phoneNumber);
  expect(result.ok).toBe(true);
  return user!.id;
}

async function insertLead(tenantId: string, opts: { ownerId?: string | null; fullName?: string; campaignName?: string; metaCreatedAt?: Date } = {}): Promise<void> {
  const db = await getDb();
  await db.insert(leads).values({
    companyId: tenantId,
    metaLeadId: unique("lead"),
    metaCreatedAt: opts.metaCreatedAt ?? new Date(),
    ownerId: opts.ownerId ?? null,
    fullName: opts.fullName ?? null,
    source: "meta_lead_ads",
    campaignName: opts.campaignName ?? null,
  });
}

function inboundMessage(tenantId: string, fromPhoneNumber: string, messageText: string, waMessageId = `wamid.${randomUUID()}`): RutaAssistantInboundMessage {
  return { tenantId, fromPhoneNumber, waMessageId, messageText };
}

async function sendAndGetReply(tenantId: string, fromPhoneNumber: string, text: string, waMessageId?: string): Promise<string | undefined> {
  const before = vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls.length;
  await handleRutaAssistantMessages([inboundMessage(tenantId, fromPhoneNumber, text, waMessageId)]);
  const calls = vi.mocked(graphClient.sendWhatsappTextMessage).mock.calls.slice(before);
  return calls[0]?.[3];
}

/** Backdates a conversation's idleExpiresAt directly in Postgres, so a
 * rollover test doesn't need to actually wait CONVERSATION_IDLE_TIMEOUT_MINUTES. */
async function expireConversation(conversationId: string): Promise<void> {
  const db = await getDb();
  await db.update(rutaConversations).set({ idleExpiresAt: new Date(Date.now() - 60_000) }).where(eq(rutaConversations.id, conversationId));
}

describe.skipIf(!process.env.DATABASE_URL)("RUTA Conversation Context (Phase F)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------
  // Repository-level.
  // ---------------------------------------------------------------------

  it("getOrCreateActiveConversation creates once, then reuses the SAME conversation_id for the same (tenantId, userId)", async () => {
    const { tenantId, userId } = await makeBareTenantAndUser("reuse");
    const first = await getOrCreateActiveConversation(tenantId, userId, "+911234500001");
    const second = await getOrCreateActiveConversation(tenantId, userId, "+911234500001");
    expect(second.id).toBe(first.id);
  });

  it("getOrCreateActiveConversation starts a FRESH conversation_id once the previous one has gone idle", async () => {
    const { tenantId, userId } = await makeBareTenantAndUser("rollover");
    const first = await getOrCreateActiveConversation(tenantId, userId, "+911234500002");
    await setPendingContext(tenantId, userId, first.id, { kind: "disambiguation", options: [] });
    await expireConversation(first.id);

    const second = await getOrCreateActiveConversation(tenantId, userId, "+911234500002");
    expect(second.id).not.toBe(first.id);
    // A brand-new conversation starts with no pending context of its own -
    // the OLD (now-idle) conversation's state must not carry forward.
    expect(second.pendingContext).toBeNull();
  });

  it("Context can never cross users or tenants, even when given the RIGHT conversation_id and the WRONG tenantId/userId", async () => {
    const a = await makeBareTenantAndUser("cross-a");
    const b = await makeBareTenantAndUser("cross-b");
    const conversationA = await getOrCreateActiveConversation(a.tenantId, a.userId, "+911234500003");
    await setPendingContext(a.tenantId, a.userId, conversationA.id, { kind: "disambiguation", options: [{ kind: "lead", id: "L1", label: "Secret Lead" }] });

    // Reading A's conversation with B's tenantId/userId (but A's real
    // conversationId) must return nothing.
    expect(await getPendingContext(b.tenantId, a.userId, conversationA.id)).toBeNull();
    expect(await getPendingContext(a.tenantId, b.userId, conversationA.id)).toBeNull();
    expect(await getPendingContext(b.tenantId, b.userId, conversationA.id)).toBeNull();

    // Writing (set/clear) against A's conversationId under B's identity
    // must be a silent no-op, not a cross-tenant/-user overwrite.
    await setPendingContext(b.tenantId, b.userId, conversationA.id, { kind: "disambiguation", options: [] });
    await clearPendingContext(b.tenantId, a.userId, conversationA.id);

    // A's own original context survives untouched.
    const stillA = (await getPendingContext(a.tenantId, a.userId, conversationA.id)) as { kind: string; options: Array<{ label: string }> } | null;
    expect(stillA?.kind).toBe("disambiguation");
    expect(stillA?.options[0]?.label).toBe("Secret Lead");
  });

  it("recordConversationTurn keeps the history COMPACT - capped at MAX_TURNS_PER_CONVERSATION, oldest pruned first", async () => {
    const { tenantId, userId } = await makeBareTenantAndUser("compact");
    const conversation = await getOrCreateActiveConversation(tenantId, userId, "+911234500004");

    const totalTurns = MAX_TURNS_PER_CONVERSATION + 5;
    for (let i = 0; i < totalTurns; i++) {
      await recordConversationTurn(tenantId, userId, conversation.id, { toolName: "leadCount", userMessageText: `turn-${i}` });
    }

    const turns = await listConversationTurns(tenantId, userId, conversation.id);
    expect(turns.length).toBe(MAX_TURNS_PER_CONVERSATION);
    // The retained rows are the MOST RECENT ones - the oldest 5 (turn-0..4)
    // were pruned, not the newest.
    const excerpts = turns.map((t) => t.userMessageExcerpt);
    expect(excerpts).not.toContain("turn-0");
    expect(excerpts).toContain(`turn-${totalTurns - 1}`);
  });

  // ---------------------------------------------------------------------
  // Orchestrator-level.
  // ---------------------------------------------------------------------

  it("Spec example end to end: 'how many leads today' -> 'which campaign gave the most' -> 'what about yesterday' re-runs the ORIGINAL anchor, not the drill-down", async () => {
    const tenantId = await makeRutaTenant("spec-chain");
    const roleId = await makeRutaRole(tenantId, false);
    const phone = unique("ph-chain");
    await makeRutaUser(tenantId, roleId, "Chain User", phone);

    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
    await insertLead(tenantId, { campaignName: "TodayCampaign", metaCreatedAt: today });
    await insertLead(tenantId, { campaignName: "TodayCampaign", metaCreatedAt: today });
    for (let i = 0; i < 5; i++) await insertLead(tenantId, { campaignName: "YesterdayCampaign", metaCreatedAt: yesterday });

    const r1 = await sendAndGetReply(tenantId, phone, "how many leads today");
    expect(r1).toContain("2 leads today");

    const r2 = await sendAndGetReply(tenantId, phone, "which campaign gave the most");
    expect(r2).toContain("TodayCampaign"); // drill-down inherited today's anchor

    const r3 = await sendAndGetReply(tenantId, phone, "what about yesterday");
    // Re-runs leadCount (the ANCHOR tool), not campaignLeadCounts (the
    // drill-down the previous turn used) - exactly the spec's own example.
    expect(r3).toContain("5 leads yesterday");
  });

  it("Every resolved turn in that chain is written to the compact ruta_conversation_turns history", async () => {
    const tenantId = await makeRutaTenant("spec-chain-history");
    const roleId = await makeRutaRole(tenantId, false);
    const phone = unique("ph-chain-hist");
    const userId = await makeRutaUser(tenantId, roleId, "History User", phone);

    await sendAndGetReply(tenantId, phone, "how many leads today");
    await sendAndGetReply(tenantId, phone, "which campaign gave the most");
    await sendAndGetReply(tenantId, phone, "what about yesterday");

    const db = await getDb();
    const rows = await db.select().from(rutaConversationTurns).where(and(eq(rutaConversationTurns.tenantId, tenantId), eq(rutaConversationTurns.userId, userId)));
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.toolName).sort()).toEqual(["leadCount", "leadCount", "campaignLeadCounts"].sort());
    // Never grows unbounded, and never holds more than the raw message
    // text actually sent - no full LLM transcript, no reply text stored.
    for (const r of rows) expect(r.userMessageExcerpt.length).toBeLessThanOrEqual(300);
  });

  it("Conversation-context resolution never widens what a permission-gated tool returns - authorization still runs against the FINAL resolved query", async () => {
    const tenantId = await makeRutaTenant("resolve-then-authorize");
    const restrictedRoleId = await makeRutaRole(tenantId, false); // no RUTA_AI_ASSISTANT_BROAD_QUERY
    const otherUserRoleId = await makeRutaRole(tenantId, false);
    const restrictedPhone = unique("ph-restricted");
    const restrictedUserId = await makeRutaUser(tenantId, restrictedRoleId, "Restricted User", restrictedPhone);
    const otherUserId = await makeRutaUser(tenantId, otherUserRoleId, "Other Owner", unique("ph-other"));

    // A lead owned by a DIFFERENT user - only visible to a broad-grant
    // query, never to a personal-scoped one.
    await insertLead(tenantId, { ownerId: otherUserId, fullName: "Rohan Shah" });

    // Sets a live conversation anchor first - proves the anchor being live
    // doesn't itself grant anything.
    await sendAndGetReply(tenantId, restrictedPhone, "how many leads today");

    const reply = await sendAndGetReply(tenantId, restrictedPhone, "update on Rohan Shah");
    // updateOnX (rutaTools.ts) is gated by hasBroadGrant (crmTools.ts),
    // evaluated against ctx.tenantId/ctx.userId ONLY - never against the
    // live anchor/conversation context above - so a restricted user still
    // can't see a teammate's lead, chain or no chain.
    expect(reply).toContain('No lead or teammate found matching "Rohan Shah"');
    void restrictedUserId;
  });
});
