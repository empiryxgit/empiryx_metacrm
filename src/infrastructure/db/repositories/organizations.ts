// Agency <-> client organization relationships (see schema.ts's own doc
// comment on agencyClients for why this is a relationship table, not a
// third `account_type`). Deliberately just the data-access layer for now -
// no application-layer service or API handler wires these up yet, same
// "schema + repository now, pipeline wiring later" split
// src/infrastructure/db/repositories/metaIntegration.ts's own history
// followed when tenant-level Meta auth was first added.
//
// Every function below is scoped by the AGENCY's own companyId wherever it
// mutates or lists relationships that company owns - never trusts a
// clientCompanyId or relationship id on its own without also checking it
// belongs to the calling agency, same tenant-isolation discipline every
// other repository in this codebase already follows.

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../client";
import { agencyClients, companies } from "../schema";
import { firstOrThrow } from "../util";
import { CLAIMED_AGENCY_CLIENT_STATUSES, type AgencyClientStatus } from "../../../domain/agencyClientStatus";

export interface LinkClientOrganizationInput {
  agencyCompanyId: string;
  clientCompanyId: string;
  createdBy?: string;
  // Defaults to "invited" - see agencyClientStatus.ts's lifecycle comment.
  // Pass "active" directly for a flow that skips the invite/accept step
  // (e.g. an agency admin adding a client it already has an offline
  // agreement with).
  status?: AgencyClientStatus;
}

/**
 * Creates (or REACTIVATES) the relationship between one agency and one
 * client organization. Because `ux_agency_clients_agency_client` makes
 * (agencyCompanyId, clientCompanyId) unique for the row's entire lifetime
 * (see schema.ts), this is an upsert, not a plain insert: re-inviting a
 * client this same agency had previously removed reactivates that original
 * row (and its id/history) rather than creating a second one.
 *
 * `ux_agency_clients_one_claimed_agency_per_client` (also on the table)
 * still applies on top of that - if this client organization is currently
 * claimed (invited/pending/active/suspended) by a DIFFERENT agency, this
 * throws a Postgres unique-violation error rather than silently
 * transferring ownership. No API/application layer exists yet to translate
 * that into a friendly error (see this file's header comment) - a future
 * caller must catch it and report "this client already belongs to another
 * agency" rather than a raw 500.
 */
export async function linkOrReactivateClientOrganization(input: LinkClientOrganizationInput) {
  const db = await getDb();
  const rows = await db
    .insert(agencyClients)
    .values({
      agencyCompanyId: input.agencyCompanyId,
      clientCompanyId: input.clientCompanyId,
      createdBy: input.createdBy,
      status: input.status ?? "invited",
    })
    .onConflictDoUpdate({
      target: [agencyClients.agencyCompanyId, agencyClients.clientCompanyId],
      set: { status: input.status ?? "invited", updatedAt: new Date() },
    })
    .returning();
  return firstOrThrow(rows);
}

/**
 * Moves an existing (agency, client) relationship to a new status - accept
 * an invite, suspend, remove, etc. Scoped by agencyCompanyId so an agency
 * can only transition a relationship it is actually a party to, never
 * another agency's. No-op (zero rows affected) if no such relationship
 * exists. Deliberately does not validate the FROM status - the fixed
 * lifecycle in agencyClientStatus.ts is documented, not enforced as a state
 * machine here (see that file's own comment) - a future application-layer
 * service is the right place for "can't go from removed back to active
 * without going through invited again"-style rules, if ever needed.
 */
export async function setAgencyClientStatus(agencyCompanyId: string, clientCompanyId: string, status: AgencyClientStatus) {
  const db = await getDb();
  await db
    .update(agencyClients)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(agencyClients.agencyCompanyId, agencyCompanyId), eq(agencyClients.clientCompanyId, clientCompanyId)));
}

/** Every client organization CURRENTLY CLAIMED (invited/pending/active/
 * suspended - i.e. not "removed") by this agency, joined with the client's
 * own name/status for display. */
export async function listClaimedClientOrganizations(agencyCompanyId: string) {
  const db = await getDb();
  return db
    .select({
      linkId: agencyClients.id,
      clientCompanyId: agencyClients.clientCompanyId,
      clientName: companies.name,
      clientStatus: companies.status,
      relationshipStatus: agencyClients.status,
      linkedAt: agencyClients.createdAt,
    })
    .from(agencyClients)
    .innerJoin(companies, eq(companies.id, agencyClients.clientCompanyId))
    .where(
      and(
        eq(agencyClients.agencyCompanyId, agencyCompanyId),
        inArray(agencyClients.status, CLAIMED_AGENCY_CLIENT_STATUSES),
      ),
    );
}

/** The agency currently claiming this client organization (any non-"removed"
 * status), or null for an independent/unclaimed organization. Relies on
 * ux_agency_clients_one_claimed_agency_per_client to guarantee at most one
 * row can ever match. */
export async function getClaimingAgencyForClient(clientCompanyId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      linkId: agencyClients.id,
      agencyCompanyId: agencyClients.agencyCompanyId,
      agencyName: companies.name,
      relationshipStatus: agencyClients.status,
      linkedAt: agencyClients.createdAt,
    })
    .from(agencyClients)
    .innerJoin(companies, eq(companies.id, agencyClients.agencyCompanyId))
    .where(
      and(
        eq(agencyClients.clientCompanyId, clientCompanyId),
        inArray(agencyClients.status, CLAIMED_AGENCY_CLIENT_STATUSES),
      ),
    )
    .limit(1);
  return row ?? null;
}
