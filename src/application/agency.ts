// Application-layer service backing the whole "Agency" nav section (public/
// agency-dashboard.html, clients.html, client-detail.html): the agency-level
// dashboard VIEW, the Clients list, Add Client (create a brand-new client
// company the agency owns outright - no consent step needed), Invite Client
// (link to an EXISTING registered company - DOES need consent, see
// inviteExistingClient/respondToAgencyInvite below), and Client Detail (a
// per-client, read-only drill-down covering Users/Leads/Campaigns/
// Integrations/Settings).
//
// getClientDetail is still deliberately narrow about what it exposes:
// aggregate lead COUNTS only (never a client's raw lead list/PII), campaign
// names/status (not their webhook secrets), and integration STATUS only
// (getRelevantMetaConnectionView already masks out tokens - never returned
// here at all). It also only ever grants access once the relationship has
// moved to "active"/"suspended" - an "invited" relationship the client
// hasn't accepted yet grants no data access, see that function's own doc
// comment.
//
// Every exported function here takes the CALLER's own companyId as an
// explicit parameter and is only ever invoked after the API handler has
// already verified that company is accountType "agency" (except the
// client-facing respondToAgencyInvite/getPendingInviteForCompany pair, which
// intentionally has NO accountType gate - any company can be someone's
// invited client, see api/admin/users/handler.ts's handleAgencyInviteResource)
// - see api/admin/users/handler.ts's handleAgencyResource. Nothing here
// re-checks that itself, same "application layer enforces, repository layer
// trusts its caller" split every other service in this codebase already
// follows.

import { AuthError } from "./auth";
import { uniqueSlug } from "./auth";
import { hashPassword, generateTempPassword } from "../infrastructure/auth/password";
import {
  createClientFixedRoles,
  createCompany,
  createUser,
  emailExists,
  getCompanyById,
  getUserByEmail,
  listUsers,
  listUsersForCompanies,
  setCompanyCreatedBy,
  completeOnboarding,
} from "../infrastructure/db/repositories/tenancy";
import {
  getAgencyLeadCounts,
  getClaimingAgencyForClient,
  getClientMetrics,
  linkOrReactivateClientOrganization,
  listClaimedClientOrganizations,
  setAgencyClientStatus,
} from "../infrastructure/db/repositories/organizations";
import { assignClientToUser } from "../infrastructure/db/repositories/agencyClientAssignments";
import { listCampaigns, listCampaignsForCompanies } from "../infrastructure/db/repositories/campaigns";
import { getRelevantMetaConnectionView } from "../infrastructure/db/repositories/metaIntegration";
import { provisionDefaultForms } from "../infrastructure/db/repositories/forms";
import { resolveEffectiveIndustryTemplate, LEAD_SOURCES } from "../domain/industryTemplates";
import { CLAIMED_AGENCY_CLIENT_STATUSES, type AgencyClientStatus } from "../domain/agencyClientStatus";
import { canAccessClient, type AgencyClientAccess } from "./agencyClientAccess";

export interface AgencyDashboardClientRow {
  id: string;
  name: string;
  leads: number;
  activeCampaigns: number;
  // "invited" | "pending" | "active" | "suspended" - see
  // src/domain/agencyClientStatus.ts. "removed" never appears here;
  // listClaimedClientOrganizations already excludes it.
  status: string;
}

export interface AgencyDashboardSummary {
  kpis: {
    clients: number;
    activeClients: number;
    totalLeads: number;
    leadsToday: number;
    activeCampaigns: number;
  };
  clients: AgencyDashboardClientRow[];
}

// Shared by getAgencyDashboardSummary and listAgencyClients below - both
// need exactly the same "claimed clients this caller can access, plus
// their lead/campaign metrics" building block; factored out so the two
// can never drift into computing the roster two different ways. Not
// exported - `claimed`/`metrics` are internal shape, callers get either
// the plain roster (listAgencyClients) or the roster plus a KPI rollup
// (getAgencyDashboardSummary).
async function buildAgencyClientRoster(agencyCompanyId: string, access: AgencyClientAccess) {
  const allClaimed = await listClaimedClientOrganizations(agencyCompanyId);
  const claimed = allClaimed.filter((c) => canAccessClient(access, c.clientCompanyId));
  const metrics = await getClientMetrics(claimed.map((c) => c.clientCompanyId));

  const clients: AgencyDashboardClientRow[] = claimed
    .map((c) => {
      const m = metrics.get(c.clientCompanyId)!;
      return {
        id: c.clientCompanyId,
        name: c.clientName,
        leads: m.totalLeads,
        activeCampaigns: m.activeCampaigns,
        status: c.relationshipStatus,
      };
    })
    .sort((a, b) => b.leads - a.leads);

  return { claimed, metrics, clients };
}

/**
 * Plain client roster (GET /api/agency/clients) - the Clients table's data
 * with no KPI rollup attached, for a caller that only wants the list. Same
 * underlying data/authorization as getAgencyDashboardSummary below, which
 * calls this exact same builder internally so the two can never disagree
 * about who's in the roster or what each row looks like.
 */
export async function listAgencyClients(agencyCompanyId: string, access: AgencyClientAccess): Promise<AgencyDashboardClientRow[]> {
  const { clients } = await buildAgencyClientRoster(agencyCompanyId, access);
  return clients;
}

/**
 * Everything the Agency Dashboard's KPI row and Clients table need, in one
 * call. Clients are sorted by lead volume (most leads first) - the same
 * "what needs my attention" ordering a busy agency wants, not alphabetical.
 *
 * `access` (resolveAgencyClientAccess(auth), from the caller) is what
 * actually implements "the user cannot see Client B": every claimed client
 * is filtered down to whichever ones the caller can access BEFORE the KPIs
 * are computed from them, so a Manager/User's KPI row also only reflects
 * their own assigned clients, not the whole agency's.
 */
export async function getAgencyDashboardSummary(
  agencyCompanyId: string,
  access: AgencyClientAccess,
): Promise<AgencyDashboardSummary> {
  const { claimed, metrics, clients } = await buildAgencyClientRoster(agencyCompanyId, access);

  const kpis = {
    clients: claimed.length,
    activeClients: claimed.filter((c) => c.relationshipStatus === "active").length,
    totalLeads: clients.reduce((sum, c) => sum + c.leads, 0),
    leadsToday: [...metrics.values()].reduce((sum, m) => sum + m.leadsToday, 0),
    activeCampaigns: clients.reduce((sum, c) => sum + c.activeCampaigns, 0),
  };

  return { kpis, clients };
}

export interface AgencyLeadsReportRawFilters {
  // All optional, all raw/untrusted strings straight off the query string -
  // see getAgencyLeadsReport's own comment for how each one is validated
  // before use. "status" here means leads.pipelineStage (the CRM funnel
  // stage a client's own industry template defines), not the internal
  // ingestion leads.status column - the business-facing concept an agency
  // owner actually means by "Status" in a leads report.
  clientId?: string;
  from?: string;
  to?: string;
  source?: string;
  campaignId?: string;
  status?: string;
  assignedUserId?: string;
}

export interface AgencyLeadsReportClientRow {
  id: string;
  name: string;
  leads: number;
}

export interface AgencyLeadsReportFilterOptions {
  clients: Array<{ id: string; name: string }>;
  sources: Array<{ key: string; label: string }>;
  campaigns: Array<{ id: string; name: string; clientId: string }>;
  statuses: Array<{ key: string; label: string }>;
  assignedUsers: Array<{ id: string; name: string; clientId: string }>;
}

export interface AgencyLeadsReport {
  totalLeads: number;
  clients: AgencyLeadsReportClientRow[];
  filters: AgencyLeadsReportFilterOptions;
}

/** Union of every stage key/label across the given clients' OWN industry
 * templates - agencies routinely mix templates across their roster (a
 * Real Estate client and a Solar client both appear in this feature's own
 * UI mockup), so "Status" can't be a single fixed enum the way Source is.
 * Deduped by key (every template shares "new"/"contacted"/"qualified"/
 * "won"/"lost" - see src/domain/industryTemplates.ts - so those collapse
 * to one option each; a template-specific stage like "site_visit" vs
 * "site_survey" correctly stays two distinct options). */
function buildStatusOptions(
  clients: Array<{ clientIndustryTemplate: string; clientCustomTemplateConfig?: unknown }>,
): Array<{ key: string; label: string }> {
  const seen = new Map<string, string>();
  for (const client of clients) {
    const template = resolveEffectiveIndustryTemplate(client.clientIndustryTemplate, client.clientCustomTemplateConfig);
    for (const stage of template.stages) {
      if (!seen.has(stage.key)) seen.set(stage.key, stage.label);
    }
  }
  return [...seen.entries()].map(([key, label]) => ({ key, label }));
}

/** "to" is meant as an inclusive whole day (the UI's Date filter is a plain
 * date, not a timestamp) but getAgencyLeadCounts filters with an
 * exclusive `lt(createdAt, to)` - shifting to the START of the NEXT day
 * makes an inclusive day-picker behave correctly without every caller
 * needing to know that. "from" needs no such shift - `gte` is already
 * inclusive of the day itself at midnight. Returns undefined for a
 * missing/unparseable value rather than throwing - an invalid date filter
 * degrades to "no date filter" instead of a hard 400, same forgiving
 * posture the CRM dashboard's own date parsing already takes. */
function parseFilterDate(value: string | undefined, opts: { endOfDay?: boolean } = {}): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  date.setHours(0, 0, 0, 0);
  if (opts.endOfDay) date.setDate(date.getDate() + 1);
  return date;
}

/**
 * Aggregate lead reporting across every client this agency manages -
 * "Total Leads" plus a per-client breakdown, filterable by Client/Date/
 * Source/Campaign/Status/Assigned User (see the UI mockup this was built
 * from). THE hard requirement this function exists to satisfy: every one
 * of those filters is independently re-checked against the caller's own
 * resolved access (`access`, from resolveAgencyClientAccess) before it
 * ever reaches a query - a clientId/campaignId/assignedUserId naming
 * something outside that access is REJECTED (AuthError), never silently
 * ignored or silently widened to "all". This mirrors getClientDetail's own
 * "404 rather than fall back" posture for exactly the same reason: a
 * filter parameter is still a caller-supplied input, and this report's
 * whole point is that Client A's numbers can never leak into a report
 * that also happens to cover Client B.
 */
export async function getAgencyLeadsReport(
  agencyCompanyId: string,
  access: AgencyClientAccess,
  raw: AgencyLeadsReportRawFilters,
): Promise<AgencyLeadsReport> {
  const allClaimed = await listClaimedClientOrganizations(agencyCompanyId);
  const authorizedClients = allClaimed.filter((c) => canAccessClient(access, c.clientCompanyId));
  const authorizedClientIds = authorizedClients.map((c) => c.clientCompanyId);

  // Filter OPTIONS (for building the dropdowns) are always drawn from the
  // FULL authorized set, regardless of any client/campaign/user filter
  // already applied - so choosing one filter never makes another filter's
  // own option list appear to shrink out from under the user. The actual
  // aggregate query below is what narrows, not this list.
  const [campaignsAll, usersAll] = await Promise.all([
    listCampaignsForCompanies(authorizedClientIds),
    listUsersForCompanies(authorizedClientIds),
  ]);
  const statusOptions = buildStatusOptions(authorizedClients);

  // "Client" filter - narrows the aggregate to exactly one client, but
  // only one already inside this caller's authorized set.
  let scopedClientIds = authorizedClientIds;
  if (raw.clientId) {
    if (!authorizedClientIds.includes(raw.clientId)) {
      throw new AuthError("You don't have access to that client.", 403);
    }
    scopedClientIds = [raw.clientId];
  }

  // "Campaign" filter - must be one of the authorized clients' own
  // campaigns, never trusted as a bare id.
  let crmCampaignId: string | undefined;
  if (raw.campaignId) {
    if (!campaignsAll.some((c) => c.id === raw.campaignId)) {
      throw new AuthError("You don't have access to that campaign.", 403);
    }
    crmCampaignId = raw.campaignId;
  }

  // "Assigned User" filter - same discipline, against the authorized
  // clients' own users.
  let ownerId: string | undefined;
  if (raw.assignedUserId) {
    if (!usersAll.some((u) => u.id === raw.assignedUserId)) {
      throw new AuthError("You don't have access to that user.", 403);
    }
    ownerId = raw.assignedUserId;
  }

  // "Source" filter - not a tenant-scoped id (LEAD_SOURCES is a fixed,
  // global catalog), so this is input validation rather than
  // authorization, but still rejected outright rather than silently
  // ignored if it names something that doesn't exist.
  let source: string | undefined;
  if (raw.source) {
    if (!LEAD_SOURCES.some((s) => s.key === raw.source)) {
      throw new AuthError("Unknown source filter.", 400);
    }
    source = raw.source;
  }

  // "Status" filter - validated against the cross-client union computed
  // above, not a single fixed enum (see buildStatusOptions' own comment).
  let pipelineStage: string | undefined;
  if (raw.status) {
    if (!statusOptions.some((s) => s.key === raw.status)) {
      throw new AuthError("Unknown status filter.", 400);
    }
    pipelineStage = raw.status;
  }

  const { totalLeads, byClient } = await getAgencyLeadCounts({
    clientCompanyIds: scopedClientIds,
    from: parseFilterDate(raw.from),
    to: parseFilterDate(raw.to, { endOfDay: true }),
    source,
    crmCampaignId,
    pipelineStage,
    ownerId,
  });

  const scopedClientSet = new Set(scopedClientIds);
  const clients: AgencyLeadsReportClientRow[] = authorizedClients
    .filter((c) => scopedClientSet.has(c.clientCompanyId))
    .map((c) => ({ id: c.clientCompanyId, name: c.clientName, leads: byClient.get(c.clientCompanyId) ?? 0 }))
    .sort((a, b) => b.leads - a.leads);

  return {
    totalLeads,
    clients,
    filters: {
      clients: authorizedClients.map((c) => ({ id: c.clientCompanyId, name: c.clientName })),
      sources: LEAD_SOURCES,
      campaigns: campaignsAll.map((c) => ({ id: c.id, name: c.name, clientId: c.companyId })),
      statuses: statusOptions,
      assignedUsers: usersAll.map((u) => ({ id: u.id, name: u.fullName, clientId: u.companyId })),
    },
  };
}

// Fixed enums mirroring the DB check comments on campaigns.status /
// campaigns.platform in schema.ts. Raw keys only, no display labels here -
// the existing Campaigns page (public/campaigns.html) already has its own
// statusLabel()-style formatting for these same keys; this report returns
// exactly what that page already knows how to render, not a second
// parallel label set that could drift from it.
const CAMPAIGN_STATUSES = ["draft", "active", "paused", "archived"] as const;
const CAMPAIGN_PLATFORMS = ["facebook", "instagram", "both"] as const;

export interface AgencyCampaignsReportRawFilters {
  clientId?: string;
  status?: string;
  platform?: string;
}

export interface AgencyCampaignRow {
  id: string;
  name: string;
  platform: string;
  status: string;
  clientId: string;
  clientName: string;
}

export interface AgencyCampaignsReport {
  campaigns: AgencyCampaignRow[];
  filters: {
    clients: Array<{ id: string; name: string }>;
    statuses: readonly string[];
    platforms: readonly string[];
  };
}

/**
 * "Agency Campaigns" - every campaign across every client this caller can
 * see, the campaign-centric sibling of getAgencyLeadsReport above (same
 * authorization discipline: the client/status/platform filters are all
 * independently re-checked, never trusted at face value). listCampaigns/
 * listCampaignsForCompanies (src/infrastructure/db/repositories/
 * campaigns.ts) never join out to `companies` - a single-tenant caller
 * never needs a client name attached to its own campaigns, but a
 * cross-client view does, so it's attached here.
 */
export async function getAgencyCampaignsReport(
  agencyCompanyId: string,
  access: AgencyClientAccess,
  raw: AgencyCampaignsReportRawFilters,
): Promise<AgencyCampaignsReport> {
  const allClaimed = await listClaimedClientOrganizations(agencyCompanyId);
  const authorizedClients = allClaimed.filter((c) => canAccessClient(access, c.clientCompanyId));
  const authorizedClientIds = authorizedClients.map((c) => c.clientCompanyId);
  const clientNameById = new Map(authorizedClients.map((c) => [c.clientCompanyId, c.clientName]));

  // "Client" filter - narrows to exactly one client, but only one already
  // inside this caller's authorized set (same discipline as
  // getAgencyLeadsReport's own clientId filter above).
  let scopedClientIds = authorizedClientIds;
  if (raw.clientId) {
    if (!authorizedClientIds.includes(raw.clientId)) {
      throw new AuthError("You don't have access to that client.", 403);
    }
    scopedClientIds = [raw.clientId];
  }

  if (raw.status && !CAMPAIGN_STATUSES.includes(raw.status as (typeof CAMPAIGN_STATUSES)[number])) {
    throw new AuthError("Unknown status filter.", 400);
  }
  if (raw.platform && !CAMPAIGN_PLATFORMS.includes(raw.platform as (typeof CAMPAIGN_PLATFORMS)[number])) {
    throw new AuthError("Unknown platform filter.", 400);
  }

  const campaignRows = await listCampaignsForCompanies(scopedClientIds);
  const campaigns: AgencyCampaignRow[] = campaignRows
    .filter((c) => !raw.status || c.status === raw.status)
    .filter((c) => !raw.platform || c.platform === raw.platform)
    .map((c) => ({
      id: c.id,
      name: c.name,
      platform: c.platform,
      status: c.status,
      clientId: c.companyId,
      clientName: clientNameById.get(c.companyId) ?? "—",
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName) || a.name.localeCompare(b.name));

  return {
    campaigns,
    filters: {
      clients: authorizedClients.map((c) => ({ id: c.clientCompanyId, name: c.clientName })),
      statuses: CAMPAIGN_STATUSES,
      platforms: CAMPAIGN_PLATFORMS,
    },
  };
}

export interface AddClientOrganizationInput {
  agencyCompanyId: string;
  // The agency user clicking "+ Add Client" - recorded as both the new
  // company's createdBy and the agency_clients link's createdBy. NOT the
  // new client company's owner user, who is created fresh below and (per
  // companies.createdBy's own comment in schema.ts) doesn't predate the
  // company the way a self-registering owner normally would.
  actingUserId: string;
  companyName: string;
  ownerName: string;
  ownerEmail: string;
}

export interface AddClientOrganizationResult {
  company: { id: string; name: string };
  owner: { id: string; email: string; fullName: string };
  // Shown exactly once - same contract as api/admin/users/handler.ts's
  // "create user" temporaryPassword: the caller must display this to the
  // agency admin immediately (so they can relay it to the client) and
  // cannot retrieve it again. Never stored in plaintext, never emailed -
  // no transactional-email dependency needed to stay free-tier-only, same
  // reasoning as that other flow.
  temporaryPassword: string;
}

/**
 * Creates a brand-new client company this agency owns outright and links
 * it as an "active" client immediately - no invite/accept step, since the
 * agency is the one originating the whole thing (see the AskUserQuestion
 * decision this was built from: "Create a brand-new client company").
 * Mirrors registerCompanyAndOwner's steps (company, Owner role, owner user,
 * onboarding skipped, best-effort createdBy + default forms) but does NOT
 * reuse that function directly - this flow has no phoneNumber to collect
 * (nothing in the Add Client form asks for one) and the password is
 * system-generated, not user-supplied, so registerCompanyAndOwner's
 * phoneNumber-required and password-length validations don't apply here.
 */
export async function addClientOrganization(input: AddClientOrganizationInput): Promise<AddClientOrganizationResult> {
  const companyName = input.companyName.trim();
  const ownerName = input.ownerName.trim();
  const ownerEmail = input.ownerEmail.trim().toLowerCase();

  if (!companyName || !ownerName || !ownerEmail) {
    throw new AuthError("Client name, owner name, and owner email are all required.");
  }
  if (await emailExists(ownerEmail)) {
    throw new AuthError("An account with this email already exists.", 409);
  }

  const slug = await uniqueSlug(companyName);
  const tempPassword = generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  // Every new company defaults to "general" - plain Core CRM, no industry
  // specialization - same as any other registration path (see
  // RegisterInput.industry's own comment in ./auth.ts for why nothing here
  // collects one). The client can pick a real template any time afterward
  // from Settings -> Business Configuration -> Industry/Template.
  const industryTemplate = "general" as const;
  const company = await createCompany({ name: companyName, slug, industryTemplate, accountType: "individual" });
  // The four fixed CLIENT_OWNER/ADMIN/MANAGER/USER roles (see
  // src/domain/fixedRoles.ts), not the single generic Owner role - this
  // client company is being originated BY the agency, so it starts on the
  // same fixed catalog every agency-originated client gets (see
  // createClientFixedRoles' own doc comment for why inviteExistingClient's
  // pre-existing companies deliberately do NOT go through this).
  const ownerRole = (await createClientFixedRoles(company.id)).get("CLIENT_OWNER")!;
  const owner = await createUser({
    companyId: company.id,
    roleId: ownerRole.id,
    email: ownerEmail,
    passwordHash,
    fullName: ownerName,
    mustChangePassword: true,
  });

  // Links immediately as "active" - see this function's own doc comment on
  // why no invite/accept step applies here.
  await linkOrReactivateClientOrganization({
    agencyCompanyId: input.agencyCompanyId,
    clientCompanyId: company.id,
    createdBy: input.actingUserId,
    status: "active",
  });

  // Auto-assign the acting agency user to the client they just created -
  // see agencyClientAssignments' own doc comment on assignClientToUser for
  // why: an assignment-scoped agency teammate (Admin/Manager/User tier -
  // only AGENCY_OWNER has unconditional "All clients" access, see
  // src/domain/fixedRoles.ts's explicit access rules) must never be
  // immediately locked out of a client they themselves just brought onto
  // the roster. Best-effort, same posture as the steps below - a failure
  // here never blocks the client itself from being created, and is
  // harmless for an AGENCY_OWNER acting user too, since
  // AGENCY_CLIENTS_VIEW_ALL bypasses this table regardless of what's in it.
  try {
    await assignClientToUser({
      agencyCompanyId: input.agencyCompanyId,
      clientCompanyId: company.id,
      userId: input.actingUserId,
      createdBy: input.actingUserId,
    });
  } catch (err) {
    console.error("[agency/add-client] Failed to auto-assign acting user to new client:", err);
  }

  // Every new account (agency-created clients included) skips the old
  // company-profile + first-campaign onboarding wizard - see
  // registerCompanyAndOwner's own comment in ./auth.ts for the full
  // reasoning. Best-effort, same posture as every step below.
  try {
    await completeOnboarding(company.id);
  } catch (err) {
    console.error("[agency/add-client] Failed to mark onboarding complete:", err);
  }
  try {
    await setCompanyCreatedBy(company.id, input.actingUserId);
  } catch (err) {
    console.error("[agency/add-client] Failed to set company.createdBy:", err);
  }
  try {
    await provisionDefaultForms(company.id, resolveEffectiveIndustryTemplate(industryTemplate, undefined), owner.id);
  } catch (err) {
    console.error("[agency/add-client] Failed to provision default forms:", err);
  }

  return {
    company: { id: company.id, name: company.name },
    owner: { id: owner.id, email: owner.email, fullName: owner.fullName },
    temporaryPassword: tempPassword,
  };
}

// ---- Invite Client (link to an EXISTING, already-registered company) -----
// Unlike addClientOrganization above, this links to a company the agency
// does not own or originate - so unlike that flow, this one genuinely needs
// the consent step Add Client's own doc comment explains it doesn't: the
// relationship starts "invited" (never "active") and only moves to "active"
// once the CLIENT itself accepts via respondToAgencyInvite below. This is
// exactly the flow the "Create a brand-new client company" AskUserQuestion
// answer deferred - now built because the user asked for "Invite Client" as
// its own nav item alongside "Add Client".

export interface InviteExistingClientResult {
  company: { id: string; name: string };
  ownerEmail: string;
}

/**
 * Invites an existing, already-registered company to become this agency's
 * client, by looking it up via its OWNER'S (or any user's) email - there is
 * no client-facing "browse companies" surface, so email is the only handle
 * an agency has for a company it doesn't already manage. Creates an
 * "invited" agency_clients row; grants no data access until the client
 * accepts (see getClientDetail's own status check below).
 */
export async function inviteExistingClient(input: {
  agencyCompanyId: string;
  actingUserId: string;
  ownerEmail: string;
}): Promise<InviteExistingClientResult> {
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  if (!ownerEmail) throw new AuthError("An email address is required.");

  const user = await getUserByEmail(ownerEmail);
  if (!user) {
    throw new AuthError(
      "No account found with that email. Ask them to register first, or use “Add Client” to create their account for them.",
      404,
    );
  }
  if (user.companyId === input.agencyCompanyId) {
    throw new AuthError("That email belongs to your own agency account.");
  }

  const company = await getCompanyById(user.companyId);
  if (!company) throw new AuthError("That account no longer exists.", 404);
  if (company.accountType === "agency") {
    throw new AuthError("That email belongs to another agency account - agencies can't be added as clients.");
  }

  const existingClaim = await getClaimingAgencyForClient(company.id);
  if (existingClaim && existingClaim.agencyCompanyId === input.agencyCompanyId) {
    throw new AuthError(
      existingClaim.relationshipStatus === "invited"
        ? "You've already invited this client - waiting on them to accept."
        : "This company is already your client.",
      409,
    );
  }
  if (existingClaim) {
    throw new AuthError("This company is already managed by another agency.", 409);
  }

  await linkOrReactivateClientOrganization({
    agencyCompanyId: input.agencyCompanyId,
    clientCompanyId: company.id,
    createdBy: input.actingUserId,
    status: "invited",
  });

  // Same auto-assign as addClientOrganization's own doc comment explains -
  // harmless even though the relationship is still "invited" (not yet
  // accepted): getClientDetail/getAgencyDashboardSummary already exclude
  // anything that isn't active/suspended regardless of assignment, and a
  // declined invite simply leaves this row pointing at a client the agency
  // no longer manages, same orphaned-but-harmless shape a removed client
  // leaves behind for any other agency user's assignments.
  try {
    await assignClientToUser({
      agencyCompanyId: input.agencyCompanyId,
      clientCompanyId: company.id,
      userId: input.actingUserId,
      createdBy: input.actingUserId,
    });
  } catch (err) {
    console.error("[agency/invite-client] Failed to auto-assign acting user to invited client:", err);
  }

  return { company: { id: company.id, name: company.name }, ownerEmail: user.email };
}

/** The pending agency invite for this company's OWN dashboard to show (a
 * "ABC Digital wants to manage your account - Accept/Decline" banner), or
 * null when there is none. Deliberately only ever returns an "invited" claim
 * - a "pending"/"active"/"suspended" relationship isn't something for the
 * client to respond to here (accepted already, or never asked). */
export async function getPendingInviteForCompany(
  companyId: string,
): Promise<{ agencyCompanyId: string; agencyName: string } | null> {
  const claim = await getClaimingAgencyForClient(companyId);
  if (!claim || claim.relationshipStatus !== "invited") return null;
  return { agencyCompanyId: claim.agencyCompanyId, agencyName: claim.agencyName };
}

/**
 * The client's own accept/decline action on a pending invite. Re-checks the
 * claim server-side (never trusts the agencyCompanyId the client's browser
 * sends beyond confirming it matches the ONE claim actually on file) so a
 * stale or tampered request can't accept/decline the wrong relationship.
 * Accepting moves the relationship to "active" (the client is now a real,
 * data-visible client of that agency - see getClientDetail's status gate);
 * declining moves it straight to "removed", freeing the company to be
 * invited by a different agency later.
 */
export async function respondToAgencyInvite(input: {
  companyId: string;
  agencyCompanyId: string;
  accept: boolean;
}): Promise<void> {
  const claim = await getClaimingAgencyForClient(input.companyId);
  if (!claim || claim.relationshipStatus !== "invited" || claim.agencyCompanyId !== input.agencyCompanyId) {
    throw new AuthError("That invitation is no longer available.", 404);
  }
  await setAgencyClientStatus(input.agencyCompanyId, input.companyId, input.accept ? "active" : "removed");
}

// ---- Client detail (read-only) --------------------------------------------
// The "Open" action on the Clients list. Deliberately narrow and read-only,
// same posture as getAgencyDashboardSummary's own doc comment: an agency can
// see who's on a client's team, what campaigns are running, whether Meta is
// connected (status only - never tokens, via getRelevantMetaConnectionView's
// own masking), and the client's own profile - but NOT a client's raw lead
// list (that's real customer PII the agency hasn't been given row-level
// access to yet - only the aggregate counts already on the dashboard).
// WHICH agency staff can even reach this at all for a given client is its
// own permission model now - see src/application/agencyClientAccess.ts and
// the `access` parameter both this function and getAgencyDashboardSummary
// take: an AGENCY_MANAGER/AGENCY_USER (or any custom role without
// agency_clients.view_all) only gets a non-404 response for a client
// they've been explicitly assigned, never every client the agency manages.

export interface ClientDetail {
  company: {
    id: string;
    name: string;
    industryTemplate: string;
    createdAt: Date;
  };
  relationshipStatus: AgencyClientStatus;
  users: Array<{ id: string; email: string; fullName: string; roleName: string; status: string }>;
  leads: { totalLeads: number; leadsToday: number };
  campaigns: Array<{ id: string; name: string; platform: string; status: string }>;
  integration: { connected: boolean; status: string | null; lastError: string | null } ;
}

/** Throws if this agency does not currently have a CONSENTED (active or
 * suspended) relationship with this client - "invited"/"pending" never
 * grants data access, only "active"/"suspended" do (removed/unclaimed
 * clients obviously don't either) - OR if the caller (per `access`,
 * resolveAgencyClientAccess(auth)) isn't allowed to see this specific
 * client. Deliberately the same 404 either way - a client this agency
 * relationship doesn't cover and a client this CALLER isn't assigned to
 * are indistinguishable from the outside, same "don't confirm more than
 * the outcome" posture the rest of this codebase's auth checks follow. */
export async function getClientDetail(
  agencyCompanyId: string,
  clientCompanyId: string,
  access: AgencyClientAccess,
): Promise<ClientDetail> {
  if (!canAccessClient(access, clientCompanyId)) {
    throw new AuthError("Client not found.", 404);
  }
  const claim = await getClaimingAgencyForClient(clientCompanyId);
  if (!claim || claim.agencyCompanyId !== agencyCompanyId || !["active", "suspended"].includes(claim.relationshipStatus)) {
    throw new AuthError("Client not found.", 404);
  }

  const company = await getCompanyById(clientCompanyId);
  if (!company) throw new AuthError("Client not found.", 404);

  const [users, campaignRows, metrics, integration] = await Promise.all([
    listUsers(clientCompanyId),
    listCampaigns(clientCompanyId),
    getClientMetrics([clientCompanyId]),
    getRelevantMetaConnectionView(clientCompanyId),
  ]);

  const m = metrics.get(clientCompanyId)!;

  return {
    company: {
      id: company.id,
      name: company.name,
      industryTemplate: company.industryTemplate,
      createdAt: company.createdAt,
    },
    relationshipStatus: claim.relationshipStatus as AgencyClientStatus,
    users: users.map((u) => ({ id: u.id, email: u.email, fullName: u.fullName, roleName: u.roleName, status: u.status })),
    leads: { totalLeads: m.totalLeads, leadsToday: m.leadsToday },
    campaigns: campaignRows.map((c) => ({ id: c.id, name: c.name, platform: c.platform, status: c.status })),
    integration: integration
      ? { connected: integration.status === "active", status: integration.status, lastError: integration.lastError }
      : { connected: false, status: null, lastError: null },
  };
}

/**
 * Suspend / reactivate / remove an already-claimed client - the "Client
 * Settings" tab's relationship controls. Thin wrapper over
 * setAgencyClientStatus with an existence/ownership check first so a caller
 * gets a proper 404 instead of a silent no-op update.
 */
export async function setClientRelationshipStatus(
  agencyCompanyId: string,
  clientCompanyId: string,
  status: Extract<AgencyClientStatus, "active" | "suspended" | "removed">,
): Promise<void> {
  const claim = await getClaimingAgencyForClient(clientCompanyId);
  if (
    !claim ||
    claim.agencyCompanyId !== agencyCompanyId ||
    !CLAIMED_AGENCY_CLIENT_STATUSES.includes(claim.relationshipStatus as AgencyClientStatus)
  ) {
    throw new AuthError("Client not found.", 404);
  }
  await setAgencyClientStatus(agencyCompanyId, clientCompanyId, status);
}
