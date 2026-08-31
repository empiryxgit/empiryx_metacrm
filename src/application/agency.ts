// Application-layer service for the Agency Dashboard (public/
// agency-dashboard.html) - an agency-level VIEW plus the one write action
// it supports (adding a client). Deliberately narrow: this gives an agency
// read-only COUNTS across its claimed clients (leads/campaigns totals for
// the KPI row and Clients table) and the ability to spin up a brand-new
// client company it owns outright - it does NOT give an agency user any
// way to browse into a client's actual leads/pipeline/campaigns. That
// (real cross-tenant data access, with whatever authorization model it
// needs) is still the deferred "next phase" documented on agency-clients.ts
// in src/infrastructure/db/repositories/organizations.ts - this file only
// ever returns aggregate numbers, never a client's row-level data.
//
// Every exported function here takes the CALLER's own companyId as an
// explicit parameter and is only ever invoked after the API handler has
// already verified that company is accountType "agency" - see
// api/admin/users/handler.ts's handleAgencyResource. Nothing here re-checks
// that itself, same "application layer enforces, repository layer trusts
// its caller" split every other service in this codebase already follows.

import { AuthError } from "./auth";
import { uniqueSlug } from "./auth";
import { hashPassword, generateTempPassword } from "../infrastructure/auth/password";
import {
  createCompany,
  createOwnerRole,
  createUser,
  emailExists,
  setCompanyCreatedBy,
  completeOnboarding,
} from "../infrastructure/db/repositories/tenancy";
import {
  getClientMetrics,
  linkOrReactivateClientOrganization,
  listClaimedClientOrganizations,
} from "../infrastructure/db/repositories/organizations";
import { provisionDefaultForms } from "../infrastructure/db/repositories/forms";
import { getIndustryTemplate } from "../domain/industryTemplates";

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
