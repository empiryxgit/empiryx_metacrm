// "Generate Onboarding Link" invite tokens (Clients -> Add Client ->
// Generate Onboarding Link) - see agencyOnboardingTokens' own doc comment
// in schema.ts for the full security model. Plain data-access, no
// validity/expiry logic of its own - same "application layer enforces,
// repository layer trusts its caller" split every other repository in this
// codebase follows (see src/application/agencyOnboarding.ts, the only
// caller, for where expiresAt/usedAt/revokedAt actually get checked).

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb } from "../client";
import { agencyOnboardingTokens } from "../schema";
import { firstOrThrow } from "../util";

export interface CreateOnboardingTokenInput {
  agencyCompanyId: string;
  tokenHash: string;
  clientName: string;
  contactEmail: string;
  expiresAt: Date;
  createdBy?: string;
}

export async function createOnboardingToken(input: CreateOnboardingTokenInput) {
  const db = await getDb();
  const rows = await db.insert(agencyOnboardingTokens).values(input).returning();
  return firstOrThrow(rows);
}

/** Looked up by its hash only - never by id - since the raw token (hashed
 * here by the caller) is the sole credential a redemption request presents.
 * Returns the row regardless of expired/used/revoked state; the
 * application layer decides what that means. */
export async function getOnboardingTokenByHash(tokenHash: string) {
  const db = await getDb();
  const [row] = await db.select().from(agencyOnboardingTokens).where(eq(agencyOnboardingTokens.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

/**
 * The single-use guarantee, made atomic: one UPDATE ... WHERE still-valid
 * RETURNING *, not a separate "check then mark used" pair of statements.
 * Two concurrent redemption requests for the same token can both pass a
 * plain SELECT-based check before either writes anything - only one of
 * them can ever be the row this UPDATE actually touches, since the first
 * one to commit flips usedAt and the WHERE clause excludes it for the
 * second. Returns the claimed row (still resultingCompanyId: null - the
 * caller sets that afterward via setOnboardingTokenResultingCompany once
 * the company it creates actually exists) or null if the token was already
 * used/revoked/expired by the time this ran.
 */
export async function claimOnboardingTokenByHash(tokenHash: string) {
  const db = await getDb();
  const rows = await db
    .update(agencyOnboardingTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(agencyOnboardingTokens.tokenHash, tokenHash),
        isNull(agencyOnboardingTokens.usedAt),
        isNull(agencyOnboardingTokens.revokedAt),
        gt(agencyOnboardingTokens.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Records what the claimed token actually produced, once known - a second,
 * best-effort write after claimOnboardingTokenByHash above (this codebase's
 * usual non-transactional-steps posture, same as registerCompanyAndOwner in
 * src/application/auth.ts). The token is already consumed by the time this
 * runs regardless of whether it succeeds, so double-redemption stays
 * impossible either way - this only affects whether the audit trail shows
 * which company a link turned into. */
export async function setOnboardingTokenResultingCompany(id: string, resultingCompanyId: string) {
  const db = await getDb();
  await db.update(agencyOnboardingTokens).set({ resultingCompanyId }).where(eq(agencyOnboardingTokens.id, id));
}

/** Scoped by agencyCompanyId so an agency can only revoke a link it
 * actually generated, never another agency's - same ownership discipline
 * setAgencyClientStatus follows in organizations.ts. No-op if no such row
 * (or a row belonging to a different agency) exists. */
export async function revokeOnboardingToken(agencyCompanyId: string, id: string) {
  const db = await getDb();
  await db
    .update(agencyOnboardingTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agencyOnboardingTokens.id, id), eq(agencyOnboardingTokens.agencyCompanyId, agencyCompanyId)));
}

/** Every onboarding link this agency has ever generated, newest first - the
 * Clients page's own "Onboarding Links" list (pending links to copy/revoke,
 * plus a short history of used/expired ones). */
export async function listOnboardingTokensForAgency(agencyCompanyId: string) {
  const db = await getDb();
  return db
    .select()
    .from(agencyOnboardingTokens)
    .where(eq(agencyOnboardingTokens.agencyCompanyId, agencyCompanyId))
    .orderBy(agencyOnboardingTokens.createdAt);
}
