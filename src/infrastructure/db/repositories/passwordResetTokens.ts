// The "Forgot password" token model (login.html -> /forgot-password.html ->
// emailed link -> /reset-password.html) - see passwordResetTokens' own doc
// comment in schema.ts for the full security model. Plain data-access, no
// validity/expiry decisions of its own beyond the single-use claim itself
// (consumePasswordResetTokenByHash) - same "application layer enforces,
// repository layer trusts its caller" split organizationInvitations.ts
// follows (see src/application/passwordReset.ts, the only caller, for
// where everything else gets checked).

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../client";
import { passwordResetTokens } from "../schema";
import { firstOrThrow } from "../util";

export interface CreatePasswordResetTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

export async function createPasswordResetToken(input: CreatePasswordResetTokenInput) {
  const db = await getDb();
  const rows = await db.insert(passwordResetTokens).values(input).returning();
  return firstOrThrow(rows);
}

/**
 * Marks every still-outstanding (not yet used) token for this user as used,
 * without deleting the rows - called at the START of a fresh
 * requestPasswordReset so a user who requests a second link can't leave
 * two simultaneously-valid reset links outstanding (the newest request is
 * the one that should work - same "rotate limits blast radius" reasoning
 * as a session's refresh-token rotation). A harmless no-op when there's
 * nothing outstanding to invalidate.
 */
export async function invalidateOutstandingPasswordResetTokens(userId: string) {
  const db = await getDb();
  await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
}

/**
 * The single-use guarantee, made atomic - identical shape to
 * acceptInvitationByHash in organizationInvitations.ts: one
 * UPDATE ... WHERE still-unused-and-unexpired ... RETURNING, not a
 * check-then-write pair, so two concurrent redemption requests for the
 * same token can never both succeed. Returns the claimed row (caller looks
 * up the user from row.userId) or null if the token was already used,
 * never existed, or is past its expiresAt at the moment this ran.
 */
export async function consumePasswordResetTokenByHash(tokenHash: string) {
  const db = await getDb();
  const rows = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        isNull(passwordResetTokens.usedAt),
        gt(passwordResetTokens.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
