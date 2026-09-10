// The "Generate Onboarding Link" invite/onboarding-token model (Clients ->
// Add Client -> Generate Onboarding Link) - see organizationInvitations'
// own doc comment in schema.ts for the full security model and how each
// requested rule (must expire, revocable, unguessable, single-use,
// tenant-aware, no client-side agency override) maps onto this table.
// Plain data-access, no validity/expiry decisions of its own beyond the
// single-use claim itself (acceptInvitation) - same "application layer
// enforces, repository layer trusts its caller" split every other
// repository in this codebase follows (see
// src/application/agencyOnboarding.ts, the only caller, for where
// everything else gets checked).

import { and, eq, gt, sql } from "drizzle-orm";
import { getDb } from "../client";
import { organizationInvitations } from "../schema";
import { firstOrThrow } from "../util";

export interface CreateInvitationInput {
  agencyCompanyId: string;
  tokenHash: string;
  clientName: string;
  email: string;
  expiresAt: Date;
  createdBy?: string;
}

/** Always created as status='PENDING' (the column's own DB default too) -
 * there is no code path that creates an invitation in any other state. */
export async function createInvitation(input: CreateInvitationInput) {
  const db = await getDb();
  const rows = await db.insert(organizationInvitations).values(input).returning();
  return firstOrThrow(rows);
}

/** Looked up by its hash only - never by id - since the raw token (hashed
 * here by the caller) is the sole credential a redemption request
 * presents. Returns the row regardless of PENDING/ACCEPTED/REVOKED/expired
 * state; the application layer (getOnboardingLinkPreview) decides what
 * that means for a non-consuming preview. Never used by the actual
 * accept step below, which re-validates atomically on its own. */
export async function getInvitationByHash(tokenHash: string) {
  const db = await getDb();
  const [row] = await db.select().from(organizationInvitations).where(eq(organizationInvitations.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

/**
 * The single-use guarantee, made atomic: one UPDATE ... WHERE still-PENDING
 * RETURNING *, not a separate "check then mark accepted" pair of
 * statements. Two concurrent redemption requests for the same token can
 * both pass a plain SELECT-based check before either writes anything -
 * only one of them can ever be the row this UPDATE actually touches, since
 * the first one to commit flips status to ACCEPTED and the WHERE clause
 * excludes it for the second. The expiresAt check lives in the SAME
 * statement (not a separate "is it expired" check beforehand) for the same
 * reason: an already-expired PENDING row must never be acceptable no
 * matter how the caller got there.
 *
 * Returns the claimed row (still resultingCompanyId: null - the caller
 * sets that afterward via setInvitationResultingCompany once the company
 * it creates actually exists) or null if the invitation was not PENDING,
 * or was PENDING but expired, at the moment this ran.
 */
export async function acceptInvitationByHash(tokenHash: string) {
  const db = await getDb();
  const rows = await db
    .update(organizationInvitations)
    .set({ status: "ACCEPTED", acceptedAt: new Date() })
    .where(
      and(
        eq(organizationInvitations.tokenHash, tokenHash),
        eq(organizationInvitations.status, "PENDING"),
        gt(organizationInvitations.expiresAt, sql`now()`),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

/** Records what the accepted invitation actually produced, once known - a
 * second, best-effort write after acceptInvitationByHash above (this
 * codebase's usual non-transactional-steps posture, same as
 * registerCompanyAndOwner in src/application/auth.ts). The invitation is
 * already consumed (status='ACCEPTED') by the time this runs regardless of
 * whether it succeeds, so double-redemption stays impossible either way -
 * this only affects whether the audit trail shows which company an
 * invitation turned into. */
export async function setInvitationResultingCompany(id: string, resultingCompanyId: string) {
  const db = await getDb();
  await db.update(organizationInvitations).set({ resultingCompanyId }).where(eq(organizationInvitations.id, id));
}

/**
 * Scoped by agencyCompanyId - tenant-aware by construction: an agency can
 * only revoke an invitation it actually created, never another agency's
 * (the WHERE clause excludes any row that doesn't also match
 * agencyCompanyId, so a mismatched id is simply a no-op, not an error that
 * could leak whether the id exists at all). No-op on an already
 * ACCEPTED/REVOKED/expired invitation too - revoking something that can't
 * be redeemed anyway is harmless, so this never bothers special-casing it.
 */
export async function revokeInvitation(agencyCompanyId: string, id: string) {
  const db = await getDb();
  await db
    .update(organizationInvitations)
    .set({ status: "REVOKED", revokedAt: new Date() })
    .where(and(eq(organizationInvitations.id, id), eq(organizationInvitations.agencyCompanyId, agencyCompanyId)));
}

/** Every invitation this agency has ever generated, newest first -
 * tenant-scoped by construction (only ever queried by the calling agency's
 * own id). The Clients page's own "Onboarding Links" list (pending links
 * to copy/revoke, plus a short history of accepted/expired/revoked ones). */
export async function listInvitationsForAgency(agencyCompanyId: string) {
  const db = await getDb();
  return db
    .select()
    .from(organizationInvitations)
    .where(eq(organizationInvitations.agencyCompanyId, agencyCompanyId))
    .orderBy(organizationInvitations.createdAt);
}
