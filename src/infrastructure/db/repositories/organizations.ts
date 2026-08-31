// Agency <-> client organization relationships (see schema.ts's own doc
// comment on agencyOrganizations for why this is a relationship table, not
// a third `account_type`). Deliberately just the data-access layer for now
// - no application-layer service or API handler wires these up yet, same
// "schema + repository now, pipeline wiring later" split
// src/infrastructure/db/repositories/metaIntegration.ts's own history
// followed when tenant-level Meta auth was first added.
//
// Every function below is scoped by the AGENCY's own companyId wherever it
// mutates or lists relationships that company owns - never trusts a
// clientCompanyId or relationship id on its own without also checking it
// belongs to the calling agency, same tenant-isolation discipline every
// other repository in this codebase already follows.

import { and, eq } from "drizzle-orm";
import { getDb } from "../client";
import { agencyOrganizations, companies } from "../schema";
import { firstOrThrow } from "../util";

export interface LinkClientOrganizationInput {
  agencyCompanyId: string;
  clientCompanyId: string;
  createdBy?: string;
}

/**
 * Links a client organization to an agency. Enforced invariants live on the
 * table itself (see schema.ts): at most one ACTIVE agency per client
 * (partial unique index - inserting a second active link for the same
 * client fails at the database level rather than silently overwriting the
 * first), and an organization can never link to itself (CHECK constraint).
 * Re-linking a PREVIOUSLY REVOKED client to a (possibly different) agency
 * is just a normal insert - the old revoked row is left in place as history,
 * never deleted or reused.
 */
export async function linkClientOrganization(input: LinkClientOrganizationInput) {
  const db = await getDb();
  const rows = await db
    .insert(agencyOrganizations)
    .values({
      agencyCompanyId: input.agencyCompanyId,
      clientCompanyId: input.clientCompanyId,
      createdBy: input.createdBy,
    })
    .returning();
  return firstOrThrow(rows);
}

/**
 * Revokes the CURRENT active relationship between this agency and this
 * client (a no-op, zero rows affected, if none is currently active) -
 * never deletes the row, matching every other "revoke" operation in this
 * schema (see sessions.revokedAt, meta_connections.status="revoked").
 * Scoped by agencyCompanyId so an agency can only revoke a link it is
 * actually a party to, never another agency's.
 */
export async function revokeClientOrganizationLink(agencyCompanyId: string, clientCompanyId: string) {
  const db = await getDb();
  await db
    .update(agencyOrganizations)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(
      and(
        eq(agencyOrganizations.agencyCompanyId, agencyCompanyId),
        eq(agencyOrganizations.clientCompanyId, clientCompanyId),
        eq(agencyOrganizations.status, "active"),
      ),
    );
}

/** Every client organization currently (actively) managed by this agency,
 * joined with the client's own name/status for display. */
export async function listActiveClientOrganizations(agencyCompanyId: string) {
  const db = await getDb();
  return db
    .select({
      linkId: agencyOrganizations.id,
      clientCompanyId: agencyOrganizations.clientCompanyId,
      clientName: companies.name,
      clientStatus: companies.status,
      linkedAt: agencyOrganizations.createdAt,
    })
    .from(agencyOrganizations)
    .innerJoin(companies, eq(companies.id, agencyOrganizations.clientCompanyId))
    .where(and(eq(agencyOrganizations.agencyCompanyId, agencyCompanyId), eq(agencyOrganizations.status, "active")));
}

/** The agency (if any) currently managing this client organization - null
 * for an independent organization with no active agency link. */
export async function getActiveAgencyForClient(clientCompanyId: string) {
  const db = await getDb();
  const [row] = await db
    .select({
      linkId: agencyOrganizations.id,
      agencyCompanyId: agencyOrganizations.agencyCompanyId,
      agencyName: companies.name,
      linkedAt: agencyOrganizations.createdAt,
    })
    .from(agencyOrganizations)
    .innerJoin(companies, eq(companies.id, agencyOrganizations.agencyCompanyId))
    .where(and(eq(agencyOrganizations.clientCompanyId, clientCompanyId), eq(agencyOrganizations.status, "active")))
    .limit(1);
  return row ?? null;
}
