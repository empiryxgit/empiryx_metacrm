// Agency <-> client organization relationships (see schema.ts's own doc
// comment on agencyClients for why this is a relationship table, not a
// third `account_type`). This IS wired up now - see src/application/
// agency.ts (getAgencyDashboardSummary, addClientOrganization) and
// api/admin/users/handler.ts's ?resource=agency branch - but every function
// here stays a plain data-access function with no auth/permission checks of
// its own, same as every other repository in this codebase; the calling
// application-layer code is responsible for verifying the caller is
// actually the agency in question before calling any of these.
//
// Every function below is scoped by the AGENCY's own companyId wherever it
// mutates or lists relationships that company owns - never trusts a
// clientCompanyId or relationship id on its own without also checking it
// belongs to the calling agency, same tenant-isolation discipline every
// other repository in this codebase already follows.

import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../client";
import { agencyClients, campaigns, companies, leads } from "../schema";
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
 * own name/status for display. `clientIndustryTemplate` was added for the
 * Agency Leads report (src/application/agency.ts's getAgencyLeadsReport) -
 * it needs each authorized client's own template to build a cross-client
 * "Status" (pipeline stage) filter option list without a second query per
 * client. */
export async function listClaimedClientOrganizations(agencyCompanyId: string) {
  const db = await getDb();
  return db
    .select({
      linkId: agencyClients.id,
      clientCompanyId: agencyClients.clientCompanyId,
      clientName: companies.name,
      clientStatus: companies.status,
      clientIndustryTemplate: companies.industryTemplate,
      // Only meaningful when clientIndustryTemplate is "custom" - see
      // buildStatusOptions in src/application/agency.ts, which needs each
      // authorized client's real custom stage set (not just the safe
      // placeholder) to build an accurate cross-client Status filter.
      clientCustomTemplateConfig: companies.customTemplateConfig,
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

/** Per-client-company counts backing the Agency Dashboard's KPI row and
 * Clients table (see getAgencyDashboardSummary in src/application/
 * agency.ts, the only caller). Fetches just the columns needed and
 * aggregates in JS - same style api/dashboard/index.ts already uses for
 * the regular CRM dashboard, rather than introducing a new grouped-SQL-
 * aggregate pattern this codebase doesn't otherwise use. Fine at the scale
 * one agency's client list actually reaches; a future agency with an
 * unusually large roster could revisit this as a GROUP BY query without
 * changing the return shape callers see.
 *
 * Returns a Map keyed by companyId, always containing an entry (zeroed)
 * for every id passed in - callers never need an `?? default` fallback. */
export async function getClientMetrics(
  clientCompanyIds: string[],
): Promise<Map<string, { totalLeads: number; leadsToday: number; activeCampaigns: number }>> {
  const metrics = new Map(clientCompanyIds.map((id) => [id, { totalLeads: 0, leadsToday: 0, activeCampaigns: 0 }]));
  if (clientCompanyIds.length === 0) return metrics;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const db = await getDb();
  const [leadRows, activeCampaignRows] = await Promise.all([
    db.select({ companyId: leads.companyId, createdAt: leads.createdAt }).from(leads).where(inArray(leads.companyId, clientCompanyIds)),
    db
      .select({ companyId: campaigns.companyId })
      .from(campaigns)
      .where(and(inArray(campaigns.companyId, clientCompanyIds), eq(campaigns.status, "active"))),
  ]);

  for (const row of leadRows) {
    // leads.companyId is nullable in the schema (a lead can theoretically
    // exist company-less mid-ingestion) - filtered out here since it can
    // never match one of the specific ids we queried for anyway.
    if (!row.companyId) continue;
    const m = metrics.get(row.companyId);
    if (!m) continue;
    m.totalLeads++;
    if (row.createdAt >= todayStart) m.leadsToday++;
  }
  for (const row of activeCampaignRows) {
    const m = metrics.get(row.companyId);
    if (m) m.activeCampaigns++;
  }
  return metrics;
}

export interface AgencyLeadCountFilters {
  // The caller-authorized universe (or a single further-narrowed client
  // within it) - see getAgencyLeadsReport in src/application/agency.ts for
  // where this list comes from. This function does zero authorization of
  // its own (same "repository trusts its caller" split as everything else
  // in this file) - it is a pure GROUP BY aggregate over EXACTLY the ids
  // it's given, nothing more.
  clientCompanyIds: string[];
  from?: Date;
  to?: Date;
  source?: string;
  crmCampaignId?: string;
  pipelineStage?: string;
  ownerId?: string;
}

/** Real SQL-side `GROUP BY company_id` count (unlike getClientMetrics
 * above, which aggregates in JS over fetched rows) - the Agency Leads
 * report is explicitly meant to scale to an agency's full lead history
 * across every client (the totals in the UI mockup this was built from run
 * into the tens of thousands), so pulling every matching row into memory
 * just to count them would be wasteful in a way getClientMetrics' smaller,
 * simpler "total ever + today" shape never was.
 *
 * Returns { totalLeads, byClient } where byClient is a Map keyed by
 * companyId, containing an entry ONLY for ids that actually matched at
 * least one lead under these filters (unlike getClientMetrics, no
 * zero-filled entries - callers already have the full authorized client
 * list separately and can default a missing id to 0 themselves). Empty
 * clientCompanyIds short-circuits to an empty result without a query, same
 * "authorization already resolved to nothing, so there is nothing left to
 * ask the database" contract as getClientMetrics. */
export async function getAgencyLeadCounts(filters: AgencyLeadCountFilters): Promise<{ totalLeads: number; byClient: Map<string, number> }> {
  if (filters.clientCompanyIds.length === 0) return { totalLeads: 0, byClient: new Map() };

  const conditions = [inArray(leads.companyId, filters.clientCompanyIds)];
  if (filters.from) conditions.push(gte(leads.createdAt, filters.from));
  if (filters.to) conditions.push(lt(leads.createdAt, filters.to));
  if (filters.source) conditions.push(eq(leads.source, filters.source));
  if (filters.crmCampaignId) conditions.push(eq(leads.crmCampaignId, filters.crmCampaignId));
  if (filters.pipelineStage) conditions.push(eq(leads.pipelineStage, filters.pipelineStage));
  if (filters.ownerId) conditions.push(eq(leads.ownerId, filters.ownerId));

  const db = await getDb();
  const rows = await db
    .select({ companyId: leads.companyId, count: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(...conditions))
    .groupBy(leads.companyId);

  const byClient = new Map<string, number>();
  let totalLeads = 0;
  for (const row of rows) {
    // leads.companyId is nullable in the schema - see getClientMetrics'
    // own comment above for why this can never match a real filter id
    // anyway, so it's simply excluded from the per-client breakdown.
    if (!row.companyId) continue;
    byClient.set(row.companyId, row.count);
    totalLeads += row.count;
  }
  return { totalLeads, byClient };
}
