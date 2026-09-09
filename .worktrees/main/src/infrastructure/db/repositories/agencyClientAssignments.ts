// Per-user "which clients can this agency teammate see" data access - see
// agencyClientAssignments' own doc comment in schema.ts and
// src/application/agencyClientAccess.ts for the authorization model this
// backs. Plain data-access, no permission decisions of its own (same
// "application layer enforces, repository layer trusts its caller" split
// every other repository in this codebase follows) - every write here
// still takes agencyCompanyId explicitly so a caller that forgets to scope
// a clientCompanyId to the right agency fails loudly (a mismatched
// clientCompanyId simply isn't a client of that agency, so nothing to
// assign) rather than silently cross-tenant-assigning.

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../client";
import { agencyClientAssignments } from "../schema";

/** Lightweight id-only list for the JWT claim - see
 * AccessTokenClaims.assignedClientIds and resolveAgencyClientAccess. Not
 * scoped by agencyCompanyId: a user only ever belongs to one company, and
 * every assignment row for them was created under that same company (see
 * setAssignedClients below), so there is nothing cross-tenant to leak here
 * - same reasoning listUserBranches/getUserBranchIds already rely on. */
export async function getUserAssignedClientIds(userId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ clientCompanyId: agencyClientAssignments.clientCompanyId })
    .from(agencyClientAssignments)
    .where(eq(agencyClientAssignments.userId, userId));
  return rows.map((r) => r.clientCompanyId);
}

/** Every agency user currently assigned to this specific client - used by
 * a future "who on our team can see this client" view; not yet surfaced in
 * any UI, kept alongside the rest of this table's access patterns. */
export async function listAssignedUserIdsForClient(agencyCompanyId: string, clientCompanyId: string): Promise<string[]> {
  const db = await getDb();
  const rows = await db
    .select({ userId: agencyClientAssignments.userId })
    .from(agencyClientAssignments)
    .where(
      and(
        eq(agencyClientAssignments.agencyCompanyId, agencyCompanyId),
        eq(agencyClientAssignments.clientCompanyId, clientCompanyId),
      ),
    );
  return rows.map((r) => r.userId);
}

/**
 * Idempotent single-client grant - used to auto-assign whoever just
 * created/invited/onboarded a new client to that client immediately (see
 * addClientOrganization/inviteExistingClient in src/application/agency.ts
 * and completeAgencyOnboarding in src/application/agencyOnboarding.ts), so
 * an assignment-scoped agency teammate is never immediately locked out of a
 * client they themselves just brought onto the roster. Harmless no-op if
 * the row already exists (ON CONFLICT DO NOTHING) - and harmless even for a
 * user whose role already holds AGENCY_CLIENTS_VIEW_ALL, since that
 * permission bypasses this table entirely regardless of what rows exist
 * for them.
 */
export async function assignClientToUser(input: {
  agencyCompanyId: string;
  clientCompanyId: string;
  userId: string;
  createdBy?: string;
}) {
  const db = await getDb();
  await db
    .insert(agencyClientAssignments)
    .values({
      agencyCompanyId: input.agencyCompanyId,
      clientCompanyId: input.clientCompanyId,
      userId: input.userId,
      createdBy: input.createdBy,
    })
    .onConflictDoNothing({ target: [agencyClientAssignments.userId, agencyClientAssignments.clientCompanyId] });
}

/**
 * Replace-all: the Users page's "Assigned Clients" checkbox list saves the
 * COMPLETE desired set in one call, not incremental add/remove - simpler
 * for that UI (and for this function's caller) than diffing against what
 * was there before. Scoped by agencyCompanyId on both the delete and the
 * insert, so a caller can never assign a clientCompanyId that isn't
 * actually one of THIS agency's own claimed clients - see this function's
 * only caller (api/admin/users/handler.ts) for the "is this actually one of
 * our clients" check that must happen before this runs; this function
 * itself does not re-verify that against agency_clients, to keep the same
 * "repository trusts its caller" split every other repository here follows.
 */
export async function setAssignedClients(input: {
  agencyCompanyId: string;
  userId: string;
  clientCompanyIds: string[];
  createdBy?: string;
}): Promise<void> {
  const db = await getDb();

  // No multi-statement transactions over the Neon HTTP driver (see
  // src/application/auth.ts for the same constraint) - sequential,
  // individually-safe statements instead: clear everything for this user
  // under this agency, then insert the new desired set. A crash between the
  // two leaves the user with fewer assignments than intended (never more,
  // never someone else's), which is the safe direction for a visibility
  // restriction to fail in.
  await db
    .delete(agencyClientAssignments)
    .where(
      and(eq(agencyClientAssignments.userId, input.userId), eq(agencyClientAssignments.agencyCompanyId, input.agencyCompanyId)),
    );

  if (input.clientCompanyIds.length === 0) return;

  await db.insert(agencyClientAssignments).values(
    input.clientCompanyIds.map((clientCompanyId) => ({
      agencyCompanyId: input.agencyCompanyId,
      clientCompanyId,
      userId: input.userId,
      createdBy: input.createdBy,
    })),
  );
}

/** Every assignment row for this user, filtered down to whichever of the
 * given clientCompanyIds are still valid - used the same way
 * branchIdsForCompany guards branch deletion, so a stale assignment to a
 * since-removed client can be filtered out of a UI list without a separate
 * existence check per id. */
export async function assignedClientIdsAmong(userId: string, clientCompanyIds: string[]): Promise<Set<string>> {
  if (clientCompanyIds.length === 0) return new Set();
  const db = await getDb();
  const rows = await db
    .select({ clientCompanyId: agencyClientAssignments.clientCompanyId })
    .from(agencyClientAssignments)
    .where(and(eq(agencyClientAssignments.userId, userId), inArray(agencyClientAssignments.clientCompanyId, clientCompanyIds)));
  return new Set(rows.map((r) => r.clientCompanyId));
}
