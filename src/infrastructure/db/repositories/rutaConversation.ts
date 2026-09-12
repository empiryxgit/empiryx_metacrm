// RUTA Conversation Context (Phase F) - persistence for the WhatsApp AI
// Assistant's OWN conversation state, deliberately kept in its own tables
// (ruta_conversations / ruta_conversation_turns - see schema.ts's own
// comment on that section), separate from every CRM table. This is the
// conversation_id-aware replacement for the single-slot
// userWhatsappLinks.pendingQueryContext mechanism: every function here
// takes tenantId AND userId AND (once resolved) conversationId, and every
// query filters on all three together - never conversationId alone - so a
// bug elsewhere passing the wrong id can never read or write a different
// user's or tenant's context; it simply matches zero rows. See
// rutaAiAssistant.ts's own header for exactly where this sits in the
// pipeline, and this file's own exported constants for the two knobs
// ("how long is a conversation live" / "how much history is compact")
// that make this behave like a bounded context rather than an unbounded
// log.

import { and, desc, eq, gt, lt } from "drizzle-orm";
import { getDb } from "../client";
import { rutaConversations, rutaConversationTurns } from "../schema";

/** How long a conversation stays "the active thread" for a (tenantId,
 * userId) with no inbound message before the NEXT message starts a fresh
 * one (a new conversation_id) instead of resuming it. Deliberately
 * generous relative to PENDING_CONTEXT_TTL_MINUTES below - a follow-up
 * reference ("what about yesterday?") only ever resolves within a few
 * minutes of the question it follows up on, but the conversation THREAD
 * itself (for the append-only turn history) can reasonably span a longer
 * back-and-forth before it's considered a new topic entirely. */
export const CONVERSATION_IDLE_TIMEOUT_MINUTES = 30;

/** TTL for the single-slot pending disambiguation/anchor pointer
 * (rutaConversations.pendingContext) - identical value and semantics to
 * the PENDING_QUERY_CONTEXT_TTL_MINUTES this replaces (whatsapp.ts), just
 * relocated onto the conversation row. */
export const PENDING_CONTEXT_TTL_MINUTES = 3;

/** Cap on ruta_conversation_turns rows kept per conversation - THE literal
 * "compact conversation context, not unlimited history" mechanism: every
 * recordConversationTurn call below prunes its own conversationId back
 * down to the most recent N rows, so the table's per-conversation size
 * never grows past this regardless of how long a conversation runs. Not
 * itself consulted for follow-up resolution (see schema.ts's own comment -
 * that still reads the pendingContext pointer, an O(1) lookup) - this is
 * the audit-trail history, sized for "enough to look back over," not a
 * resolution index. */
export const MAX_TURNS_PER_CONVERSATION = 20;

export interface RutaConversation {
  id: string;
  tenantId: string;
  userId: string;
  pendingContext: unknown;
  pendingContextExpiresAt: Date | null;
}

/**
 * Finds the caller's still-active conversation (the most recent row for
 * this (tenantId, userId) whose idleExpiresAt hasn't passed) and refreshes
 * its activity window, or starts a brand-new conversation (a fresh
 * conversation_id) when there is none or the most recent one has gone
 * idle. Called once per inbound message, right after the WhatsApp
 * identity lookup - see rutaAiAssistant.ts's handleOneMessage.
 *
 * Deliberately does NOT touch pendingContext either way - resuming an
 * active conversation must leave whatever's pending (a disambiguation, an
 * anchor) exactly as it was; starting a fresh one naturally has none.
 */
export async function getOrCreateActiveConversation(tenantId: string, userId: string, phoneNumber: string): Promise<RutaConversation> {
  const db = await getDb();
  const now = new Date();

  const [existing] = await db
    .select()
    .from(rutaConversations)
    .where(and(eq(rutaConversations.tenantId, tenantId), eq(rutaConversations.userId, userId), gt(rutaConversations.idleExpiresAt, now)))
    .orderBy(desc(rutaConversations.lastActivityAt))
    .limit(1);

  const idleExpiresAt = new Date(now.getTime() + CONVERSATION_IDLE_TIMEOUT_MINUTES * 60_000);

  if (existing) {
    await db
      .update(rutaConversations)
      .set({ lastActivityAt: now, idleExpiresAt, updatedAt: now })
      .where(and(eq(rutaConversations.id, existing.id), eq(rutaConversations.tenantId, tenantId), eq(rutaConversations.userId, userId)));
    return { id: existing.id, tenantId, userId, pendingContext: existing.pendingContext, pendingContextExpiresAt: existing.pendingContextExpiresAt };
  }

  const [created] = await db
    .insert(rutaConversations)
    .values({ tenantId, userId, phoneNumber, startedAt: now, lastActivityAt: now, idleExpiresAt })
    .returning();
  if (!created) throw new Error("Failed to create RUTA conversation.");
  return { id: created.id, tenantId, userId, pendingContext: null, pendingContextExpiresAt: null };
}

/** The live pending disambiguation/anchor pointer for this EXACT
 * (tenantId, userId, conversationId) triple, or null if there is none or
 * it has expired - mirrors the old
 * `link.pendingQueryContext && link.pendingQueryContextExpiresAt.getTime() > Date.now()`
 * check inline in rutaAiAssistant.ts, just as a repository function now
 * that the value lives on a different row. */
export async function getPendingContext(tenantId: string, userId: string, conversationId: string): Promise<unknown | null> {
  const db = await getDb();
  const [row] = await db
    .select({ pendingContext: rutaConversations.pendingContext, pendingContextExpiresAt: rutaConversations.pendingContextExpiresAt })
    .from(rutaConversations)
    .where(and(eq(rutaConversations.id, conversationId), eq(rutaConversations.tenantId, tenantId), eq(rutaConversations.userId, userId)))
    .limit(1);
  if (!row?.pendingContext || !row.pendingContextExpiresAt) return null;
  return row.pendingContextExpiresAt.getTime() > Date.now() ? row.pendingContext : null;
}

/** Sets/overwrites the pending pointer for this conversation - a fresh
 * turn always simply overwrites whatever was pending, never accumulates
 * (same rule the old single-slot column followed). Scoped by tenantId AND
 * userId AND conversationId together, so this can never be pointed at
 * (let alone overwrite) a different user's or tenant's conversation even
 * if a caller passed the wrong id. */
export async function setPendingContext(tenantId: string, userId: string, conversationId: string, context: unknown): Promise<void> {
  const db = await getDb();
  const expiresAt = new Date(Date.now() + PENDING_CONTEXT_TTL_MINUTES * 60_000);
  await db
    .update(rutaConversations)
    .set({ pendingContext: context, pendingContextExpiresAt: expiresAt, updatedAt: new Date() })
    .where(and(eq(rutaConversations.id, conversationId), eq(rutaConversations.tenantId, tenantId), eq(rutaConversations.userId, userId)));
}

export async function clearPendingContext(tenantId: string, userId: string, conversationId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(rutaConversations)
    .set({ pendingContext: null, pendingContextExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(rutaConversations.id, conversationId), eq(rutaConversations.tenantId, tenantId), eq(rutaConversations.userId, userId)));
}

export interface RecordConversationTurnInput {
  toolName: string;
  sessionRole?: "anchor" | "drilldown";
  range?: { start: Date; end: Date; label: string };
  /** Raw inbound message text - truncated here to a few hundred
   * characters before storage. This is the ONLY per-turn text kept, and it
   * is never fed back to an LLM (see schema.ts's own comment on this
   * table) - purely a compact, human-auditable record of what was asked. */
  userMessageText: string;
}

const MESSAGE_EXCERPT_MAX_CHARS = 300;

/** Appends one turn to this conversation's compact history, then prunes
 * that SAME conversationId back down to MAX_TURNS_PER_CONVERSATION rows -
 * the append and the prune both scoped to (tenantId, userId,
 * conversationId), so this can never grow, or be pruned against, another
 * conversation's rows. */
export async function recordConversationTurn(tenantId: string, userId: string, conversationId: string, input: RecordConversationTurnInput): Promise<void> {
  const db = await getDb();
  const excerpt = input.userMessageText.slice(0, MESSAGE_EXCERPT_MAX_CHARS);

  await db.insert(rutaConversationTurns).values({
    conversationId,
    tenantId,
    userId,
    toolName: input.toolName,
    sessionRole: input.sessionRole ?? null,
    rangeStartAt: input.range?.start ?? null,
    rangeEndAt: input.range?.end ?? null,
    rangeLabel: input.range?.label ?? null,
    userMessageExcerpt: excerpt.length > 0 ? excerpt : "(empty message)",
  });

  const keep = await db
    .select({ id: rutaConversationTurns.id })
    .from(rutaConversationTurns)
    .where(and(eq(rutaConversationTurns.conversationId, conversationId), eq(rutaConversationTurns.tenantId, tenantId), eq(rutaConversationTurns.userId, userId)))
    .orderBy(desc(rutaConversationTurns.createdAt))
    .limit(MAX_TURNS_PER_CONVERSATION);
  if (keep.length < MAX_TURNS_PER_CONVERSATION) return; // Nothing beyond the cap yet.

  const oldestKeptCreatedAt = await db
    .select({ createdAt: rutaConversationTurns.createdAt })
    .from(rutaConversationTurns)
    .where(and(eq(rutaConversationTurns.id, keep[keep.length - 1]!.id), eq(rutaConversationTurns.conversationId, conversationId)))
    .limit(1);
  const cutoff = oldestKeptCreatedAt[0]?.createdAt;
  if (!cutoff) return;

  await db
    .delete(rutaConversationTurns)
    .where(and(eq(rutaConversationTurns.conversationId, conversationId), eq(rutaConversationTurns.tenantId, tenantId), eq(rutaConversationTurns.userId, userId), lt(rutaConversationTurns.createdAt, cutoff)));
}

/** The full compact turn history for this conversation, most recent last -
 * for the future/for debugging (e.g. a "what have we talked about"
 * command); not currently consulted anywhere in the resolution path (see
 * schema.ts's own comment) but kept as a first-class read so callers never
 * need to reach into the table directly. */
export async function listConversationTurns(tenantId: string, userId: string, conversationId: string): Promise<Array<{ toolName: string; sessionRole: string | null; rangeLabel: string | null; userMessageExcerpt: string; createdAt: Date }>> {
  const db = await getDb();
  const rows = await db
    .select({
      toolName: rutaConversationTurns.toolName,
      sessionRole: rutaConversationTurns.sessionRole,
      rangeLabel: rutaConversationTurns.rangeLabel,
      userMessageExcerpt: rutaConversationTurns.userMessageExcerpt,
      createdAt: rutaConversationTurns.createdAt,
    })
    .from(rutaConversationTurns)
    .where(and(eq(rutaConversationTurns.conversationId, conversationId), eq(rutaConversationTurns.tenantId, tenantId), eq(rutaConversationTurns.userId, userId)))
    .orderBy(rutaConversationTurns.createdAt);
  return rows;
}
