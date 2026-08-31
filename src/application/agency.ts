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
  createCompany,
  createOwnerRole,
  createUser,
  emailExists,
  getCompanyById,
  getUserByEmail,
  listUsers,
  setCompanyCreatedBy,
  completeOnboarding,
} from "../infrastructure/db/repositories/tenancy";
import {
  getClaimingAgencyForClient,
  getClientMetrics,
  linkOrReactivateClientOrganization,
  listClaimedClientOrganizations,
  setAgencyClientStatus,
} from "../infrastructure/db/repositories/organizations";
import { listCampaigns } from "../infrastructure/db/repositories/campaigns";
import { getRelevantMetaConnectionView } from "../infrastructure/db/repositories/metaIntegration";
import { provisionDefaultForms } from "../infrastructure/db/repositories/forms";
import { getIndustryTemplate } from "../domain/industryTemplates";
import { CLAIMED_AGENCY_CLIENT_STATUSES, type AgencyClientStatus } from "../domain/agencyClientStatus";

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

/**
 * Everything the Agency Dashboard's KPI row and Clients table need, in one
 * call. Clients are sorted by lead volume (most leads first) - the same
 * "what needs my attention" ordering a busy agency wants, not alphabetical.
 */
export async function getAgencyDashboardSummary(agencyCompanyId: string): Promise<AgencyDashboardSummary> {
  const claimed = await listClaimedClientOrganizations(agencyCompanyId);
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

  const kpis = {
    clients: claimed.length,
    activeClients: claimed.filter((c) => c.relationshipStatus === "active").length,
    totalLeads: clients.reduce((sum, c) => sum + c.leads, 0),
    leadsToday: [...metrics.values()].reduce((sum, m) => sum + m.leadsToday, 0),
    activeCampaigns: clients.reduce((sum, c) => sum + c.activeCampaigns, 0),
  };

  return { kpis, clients };
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

  // Every new company defaults to the "real_estate" CRM template, same as
  // any other registration path - see RegisterInput.industry's own comment
  // in ./auth.ts for why nothing here collects one.
  const industryTemplate = "real_estate" as const;
  const company = await createCompany({ name: companyName, slug, industryTemplate, accountType: "individual" });
  const ownerRole = await createOwnerRole(company.id);
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
    await provisionDefaultForms(company.id, getIndustryTemplate(industryTemplate), owner.id);
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
// access to yet - only the aggregate counts already on the dashboard). A
// future phase can widen this once there's an actual permission model for
// "which agency staff can see which client's leads", rather than every
// agency user getting full access the moment a client is claimed.

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
 * clients obviously don't either). */
export async function getClientDetail(agencyCompanyId: string, clientCompanyId: string): Promise<ClientDetail> {
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
