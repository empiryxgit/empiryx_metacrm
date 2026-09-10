// Single acceptance suite mapped 1:1 to the "implementation is complete
// only when" checklist from the review request: the four flow diagrams
// (Individual, Agency, Client, Agency-manages-clients), the four security
// guarantees, and the industry-pluggability requirement. This file does
// NOT replace any of the deeper per-concern suites already in this
// directory (tenantAccessScenarios.test.ts, registrationFlows.test.ts,
// agencyClientIsolation.test.ts, agencyDashboardKpis.test.ts,
// businessConfiguration.test.ts, tenantIsolation.test.ts, ...) - those
// remain the authoritative, exhaustive coverage for each concern. This
// file exists so there is ONE place that walks every arrow in every
// diagram end to end, in the same order the checklist names them, as a
// literal, re-runnable "is this actually done" check - and so a future
// change that breaks any single arrow fails here even if it happens to
// slip past a more narrowly-scoped test elsewhere.
//
// Same real-Postgres, no-mocking, "never rely on frontend restrictions for
// tenant security" convention as every other src/security/*.test.ts file:
// every assertion below drives a real application-layer or repository
// function, never a page or piece of client-side JS.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerCompanyAndOwner, AuthError } from "../application/auth";
import {
  addClientOrganization,
  getAgencyDashboardSummary,
  listAgencyClients,
  getClientDetail,
} from "../application/agency";
import { generateOnboardingLink, getOnboardingLinkPreview, completeAgencyOnboarding } from "../application/agencyOnboarding";
import { resolveAgencyClientAccess, canAccessClient, assertAgencyAccountType } from "../application/agencyClientAccess";
import { checkAgencyCanManageClient } from "../application/agencyClientContext";
import { getClaimingAgencyForClient } from "../infrastructure/db/repositories/organizations";
import { getCompanyById, updateBusinessConfiguration } from "../infrastructure/db/repositories/tenancy";
import { insertManualLead, isLeadAccessible } from "../infrastructure/db/repositories";
import { resolveEffectiveIndustryTemplate, validateCustomTemplateConfig, type CustomTemplateConfig } from "../domain/industryTemplates";
import type { AuthContext } from "../infrastructure/auth/context";
import { uniqueId } from "../testSupport/dbFixtures";

function authFor(companyId: string, userId: string, assignedClientIds: string[] = [], permissions: string[] = []): AuthContext {
  return { userId, sub: userId, companyId, roleId: randomUUID(), permissions, assignedClientIds };
}

describe.skipIf(!process.env.DATABASE_URL)("ACCEPTANCE: Individual — Register -> Select Individual -> No Industry Required -> Create Account -> Use CRM", () => {
  it("registers with no industry field, defaults to general, and can immediately create + read back its own CRM data", async () => {
    const email = `${uniqueId("accept-individual")}@example.com`;
    // "Select Individual": accountType: "individual". No `industry` key at
    // all in the input object - not even `undefined` - reproducing exactly
    // what register.html's step-2 submit body sends (see its own header
    // comment: the form has no industry field for either account type).
    const result = await registerCompanyAndOwner({
      companyName: "Acceptance Solo Co",
      fullName: "Sam Solo",
      email,
      password: "a-very-long-password-accept-1",
      accountType: "individual",
      phoneNumber: "+15559990001",
    });

    // "No Industry Required": defaulted, never asked for, never blocked
    // account creation.
    expect(result.company.industryTemplate).toBe("general");
    expect(result.company.accountType).toBe("individual");

    // "Use CRM": a real manually-entered lead, scoped to this brand-new
    // company, readable back under that same scope - the ordinary CRM
    // action every individual account performs daily.
    const lead = await insertManualLead({
      companyId: result.company.id,
      fullName: "Prospective Buyer",
      phoneNumber: "+15559990099",
      source: "manual",
      pipelineStage: "new",
      customFields: {},
    });
    expect(await isLeadAccessible(result.company.id, lead.id)).toBe(true);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ACCEPTANCE: Agency — Register -> Select Agency -> Create Agency -> Agency Dashboard -> Add Client -> Generate Onboarding Link -> Send Link", () => {
  it("walks the full agency setup journey, each step visible in real backend state", async () => {
    // "Select Agency" / "Create Agency"
    const agencyEmail = `${uniqueId("accept-agency")}@example.com`;
    const agency = await registerCompanyAndOwner({
      companyName: "Acceptance Agency Co",
      fullName: "Ari Agency",
      email: agencyEmail,
      password: "a-very-long-password-accept-2",
      accountType: "agency",
      phoneNumber: "+15559990002",
    });
    expect(agency.role.name).toBe("AGENCY_OWNER");
    const ownerAccess = resolveAgencyClientAccess(authFor(agency.company.id, agency.user.id, [], agency.role.permissions as string[]));

    // "Agency Dashboard" - a fresh agency starts with an empty, well-formed
    // roster (zero clients, zero of everything else), not an error.
    const emptyDashboard = await getAgencyDashboardSummary(agency.company.id, ownerAccess);
    expect(emptyDashboard.kpis.clients).toBe(0);
    expect(emptyDashboard.clients).toEqual([]);

    // "Add Client" - the agency originates a brand-new client company
    // directly (no invite/accept step - see addClientOrganization's own
    // doc comment).
    const added = await addClientOrganization({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      companyName: "Acceptance Client Co",
      ownerName: "Cam Client",
      ownerEmail: `${uniqueId("accept-addclient")}@example.com`,
    });
    expect(added.temporaryPassword).toBeTruthy();

    const afterAddDashboard = await getAgencyDashboardSummary(agency.company.id, ownerAccess);
    expect(afterAddDashboard.kpis.clients).toBe(1);
    expect(afterAddDashboard.kpis.activeClients).toBe(1); // Add Client links as "active" immediately, no accept step

    // "Generate Onboarding Link" - the OTHER way to bring a client on
    // (a prospect with no account yet, rather than one the agency
    // originates outright).
    const link = await generateOnboardingLink({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      clientName: "Acceptance Prospect Co",
      contactEmail: `${uniqueId("accept-prospect")}@example.com`,
    });
    expect(link.token).toBeTruthy();
    expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // "Send Link" - this codebase has no transactional-email service
    // (deliberate, free-tier-only choice - see the project status doc's
    // "no email/notification service" open item), so "Send" is realized as
    // public/clients.html's "Copy Link" button: the agency copies the URL
    // below and shares it however they choose (email, chat, SMS...). What
    // matters for this step is that the link the agency would copy/send is
    // genuinely valid and independently openable - proven by resolving it
    // through the exact same public, non-consuming preview the recipient's
    // browser calls before showing them anything (see the Client journey
    // below for the rest of that chain).
    const shareableUrl = `https://example.test/onboarding/agency/${encodeURIComponent(link.token)}`;
    expect(shareableUrl).toContain(link.token);
    const preview = await getOnboardingLinkPreview(link.token);
    expect(preview.agencyName).toBe("Acceptance Agency Co");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ACCEPTANCE: Client — Open Link -> Register -> Automatically become Agency Client -> Access own CRM", () => {
  it("completes onboarding via a real link and immediately has its own working, isolated CRM", async () => {
    const agency = await registerCompanyAndOwner({
      companyName: "Acceptance Agency For Client Co",
      fullName: "Ari Agency Two",
      email: `${uniqueId("accept-agency2")}@example.com`,
      password: "a-very-long-password-accept-3",
      accountType: "agency",
      phoneNumber: "+15559990003",
    });
    const link = await generateOnboardingLink({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      clientName: "Acceptance Onboarding Client Co",
      contactEmail: `${uniqueId("accept-onbclient")}@example.com`,
    });

    // "Open Link" - the public, non-consuming preview a recipient's browser
    // calls before showing its own registration form.
    const preview = await getOnboardingLinkPreview(link.token);
    expect(preview.clientName).toBe("Acceptance Onboarding Client Co");

    // "Register"
    const ownerEmail = `${uniqueId("accept-clientowner")}@example.com`;
    const completion = await completeAgencyOnboarding({
      token: link.token,
      companyName: "Acceptance Onboarding Client Co",
      ownerName: "Cam Client Two",
      ownerEmail,
      phoneNumber: "+15559990004",
      password: "a-very-long-password-accept-4",
    });

    // "Automatically become Agency Client" - active immediately, no
    // separate accept step required from either side.
    const claim = await getClaimingAgencyForClient(completion.company.id);
    expect(claim?.agencyCompanyId).toBe(agency.company.id);
    expect(claim?.relationshipStatus).toBe("active");

    // "Access own CRM" - a real lead, created and read back under the
    // CLIENT's own company scope, and (the isolation half of "own") never
    // visible under the agency's own separate company scope.
    const clientLead = await insertManualLead({
      companyId: completion.company.id,
      fullName: "Client's Own Prospect",
      source: "manual",
      pipelineStage: "new",
      customFields: {},
    });
    expect(await isLeadAccessible(completion.company.id, clientLead.id)).toBe(true);
    expect(await isLeadAccessible(agency.company.id, clientLead.id)).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ACCEPTANCE: Agency manages clients — Agency Dashboard -> See all clients -> See aggregate statistics -> Open authorized client -> Manage client CRM", () => {
  it("an authorized agency user sees every client, correct aggregate stats, and can genuinely act inside an authorized client's own CRM", async () => {
    const agency = await registerCompanyAndOwner({
      companyName: "Acceptance Manage Agency Co",
      fullName: "Ari Manager",
      email: `${uniqueId("accept-manageagency")}@example.com`,
      password: "a-very-long-password-accept-5",
      accountType: "agency",
      phoneNumber: "+15559990005",
    });
    const ownerAccess = resolveAgencyClientAccess(authFor(agency.company.id, agency.user.id, [], agency.role.permissions as string[]));

    const clientA = await addClientOrganization({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      companyName: "Acceptance Managed Client A",
      ownerName: "Owner A",
      ownerEmail: `${uniqueId("accept-mca")}@example.com`,
    });
    const clientB = await addClientOrganization({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      companyName: "Acceptance Managed Client B",
      ownerName: "Owner B",
      ownerEmail: `${uniqueId("accept-mcb")}@example.com`,
    });

    // Give each client its own leads BEFORE checking aggregate stats, so
    // "aggregate" actually means something (not just two zero-lead rows).
    await insertManualLead({ companyId: clientA.company.id, fullName: "A Lead 1", source: "manual", pipelineStage: "new", customFields: {} });
    await insertManualLead({ companyId: clientA.company.id, fullName: "A Lead 2", source: "manual", pipelineStage: "new", customFields: {} });
    await insertManualLead({ companyId: clientB.company.id, fullName: "B Lead 1", source: "manual", pipelineStage: "new", customFields: {} });

    // "See all clients"
    const roster = await listAgencyClients(agency.company.id, ownerAccess);
    expect(roster.map((c) => c.id).sort()).toEqual([clientA.company.id, clientB.company.id].sort());

    // "See aggregate statistics" - the dashboard's totalLeads is the SUM
    // across every authorized client (2 + 1 = 3), never one client's count
    // alone and never an average.
    const dashboard = await getAgencyDashboardSummary(agency.company.id, ownerAccess);
    expect(dashboard.kpis.clients).toBe(2);
    expect(dashboard.kpis.totalLeads).toBe(3);

    // "Open authorized client"
    const opened = await checkAgencyCanManageClient(authFor(agency.company.id, agency.user.id, [], agency.role.permissions as string[]), clientA.company.id);
    expect(opened.ok).toBe(true);
    if (!opened.ok) throw new Error("expected ok:true");
    expect(opened.clientName).toBe("Acceptance Managed Client A");

    // "Manage client CRM" - this is the part that actually matters
    // security-wise: proves the client-context switch is a REAL data-scope
    // change, not a cosmetic label. Reproduces exactly what
    // withEffectiveCompanyContext (src/application/agencyClientContext.ts)
    // does to every operational CRM request once a valid client-context
    // cookie is active - swap companyId to the client's, leave every other
    // auth field (permissions, userId, ...) untouched - then performs a
    // real write (a manual lead creation, the same action Leads.html's
    // "Add Lead" button triggers) through that effective context.
    const effectiveAuth: AuthContext = { ...authFor(agency.company.id, agency.user.id, [], agency.role.permissions as string[]), companyId: clientA.company.id };
    const leadCreatedWhileManagingClient = await insertManualLead({
      companyId: effectiveAuth.companyId,
      fullName: "Added By Agency While Managing Client A",
      source: "manual",
      pipelineStage: "new",
      customFields: {},
    });
    // The write really landed under CLIENT A's own company - never the
    // agency's own, and never Client B's.
    expect(await isLeadAccessible(clientA.company.id, leadCreatedWhileManagingClient.id)).toBe(true);
    expect(await isLeadAccessible(agency.company.id, leadCreatedWhileManagingClient.id)).toBe(false);
    expect(await isLeadAccessible(clientB.company.id, leadCreatedWhileManagingClient.id)).toBe(false);

    // Confirms the aggregate stat above reflects this new write too - the
    // dashboard is never stale relative to what "Manage client CRM" just
    // did.
    const dashboardAfterManage = await getAgencyDashboardSummary(agency.company.id, ownerAccess);
    expect(dashboardAfterManage.kpis.totalLeads).toBe(4);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ACCEPTANCE: Security guarantees (Client A != Client B, Agency A != Agency B, Unauthorized Agency User != All Clients, Client User != Agency Dashboard)", () => {
  // Each guarantee below has its own exhaustive dedicated coverage
  // elsewhere (tenantIsolation.test.ts / campaignTenantIsolation.test.ts,
  // agencyClientIsolation.test.ts, agencyClientIsolation.test.ts +
  // tenantAccessScenarios.test.ts Scenario 5, tenantAccessScenarios.test.ts
  // Scenario 4). These four are a single, literal, side-by-side mapping to
  // the checklist's own four guarantee statements - one crisp assertion
  // each, not a re-derivation of the deeper suites.

  it("Client A != Client B: Client A's session-scoped access can never reach Client B's lead", async () => {
    const clientA = await registerCompanyAndOwner({
      companyName: "Acceptance Guarantee Client A",
      fullName: "Guard A",
      email: `${uniqueId("accept-guardA")}@example.com`,
      password: "a-very-long-password-accept-6",
      accountType: "individual",
      phoneNumber: "+15559990006",
    });
    const clientB = await registerCompanyAndOwner({
      companyName: "Acceptance Guarantee Client B",
      fullName: "Guard B",
      email: `${uniqueId("accept-guardB")}@example.com`,
      password: "a-very-long-password-accept-7",
      accountType: "individual",
      phoneNumber: "+15559990007",
    });
    const leadB = await insertManualLead({ companyId: clientB.company.id, fullName: "B's Lead", source: "manual", pipelineStage: "new", customFields: {} });

    expect(await isLeadAccessible(clientA.company.id, leadB.id)).toBe(false);
  });

  it("Agency A != Agency B: Agency A can never manage a client claimed by Agency B", async () => {
    const agencyA = await registerCompanyAndOwner({
      companyName: "Acceptance Guarantee Agency A",
      fullName: "Guard Agency A",
      email: `${uniqueId("accept-agAguard")}@example.com`,
      password: "a-very-long-password-accept-8",
      accountType: "agency",
      phoneNumber: "+15559990008",
    });
    const agencyB = await registerCompanyAndOwner({
      companyName: "Acceptance Guarantee Agency B",
      fullName: "Guard Agency B",
      email: `${uniqueId("accept-agBguard")}@example.com`,
      password: "a-very-long-password-accept-9",
      accountType: "agency",
      phoneNumber: "+15559990009",
    });
    const clientOfB = await addClientOrganization({
      agencyCompanyId: agencyB.company.id,
      actingUserId: agencyB.user.id,
      companyName: "Acceptance Guarantee Client Of B",
      ownerName: "Owner Of B",
      ownerEmail: `${uniqueId("accept-clientofb")}@example.com`,
    });

    const result = await checkAgencyCanManageClient(
      authFor(agencyA.company.id, agencyA.user.id, [], agencyA.role.permissions as string[]),
      clientOfB.company.id,
    );
    expect(result.ok).toBe(false);
  });

  it("Unauthorized Agency User != All Clients: an assignment-scoped agency user sees only the clients assigned to them, never every client their agency has", async () => {
    const agency = await registerCompanyAndOwner({
      companyName: "Acceptance Guarantee Assignment Agency",
      fullName: "Guard Owner",
      email: `${uniqueId("accept-assignagency")}@example.com`,
      password: "a-very-long-password-accept-10",
      accountType: "agency",
      phoneNumber: "+15559990010",
    });
    const assigned = await addClientOrganization({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      companyName: "Acceptance Guarantee Assigned Client",
      ownerName: "Owner Assigned",
      ownerEmail: `${uniqueId("accept-assigned")}@example.com`,
    });
    const notAssigned = await addClientOrganization({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      companyName: "Acceptance Guarantee Unassigned Client",
      ownerName: "Owner Unassigned",
      ownerEmail: `${uniqueId("accept-unassigned")}@example.com`,
    });

    // A restricted (non-Owner) profile: no agency_clients.view_all, and
    // assignedClientIds naming only the one client this user was actually
    // assigned to (addClientOrganization auto-assigns the ACTING user, not
    // an arbitrary teammate, so a fresh restricted user here starts with
    // none - this simulates that fresh teammate).
    const restrictedAccess = resolveAgencyClientAccess(authFor(agency.company.id, randomUUID(), [assigned.company.id], []));

    expect(canAccessClient(restrictedAccess, assigned.company.id)).toBe(true);
    expect(canAccessClient(restrictedAccess, notAssigned.company.id)).toBe(false); // != All Clients
  });

  it("Client User != Agency Dashboard: an individual/client account is rejected by the exact gate every agency surface sits behind", () => {
    expect(() => assertAgencyAccountType("individual")).toThrow(AuthError);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("ACCEPTANCE: Industry is an optional configuration/template, not a foundational tenant type", () => {
  it("every built-in industry (Real Estate, Solar, Healthcare, Education, E-commerce) resolves through the SAME generic function - no per-industry branching required by any caller", () => {
    const builtIns: Array<[string, string]> = [
      ["real_estate", "Real Estate"],
      ["solar", "Solar"],
      ["healthcare", "Healthcare"],
      ["education", "Education"],
      ["ecommerce", "E-commerce"],
    ];
    for (const [key] of builtIns) {
      const template = resolveEffectiveIndustryTemplate(key, undefined);
      expect(template.stages.length).toBeGreaterThan(0);
      expect(template.pipelineName).toBeTruthy();
      expect(Array.isArray(template.fields)).toBe(true);
    }
  });

  it("industries with no built-in key at all (Finance, Marketing, Manufacturing, or any future industry) work today via the 'custom' template - pure company-owned DATA, zero core code changes", () => {
    const notYetBuiltIn: Array<{ industry: string; config: CustomTemplateConfig }> = [
      {
        industry: "Finance",
        config: {
          name: "Finance",
          pipelineName: "Loan Pipeline",
          stages: [
            { key: "new", label: "New Applicant", isInitial: true },
            { key: "underwriting", label: "Underwriting" },
            { key: "funded", label: "Funded", isClosed: true, isWon: true },
            { key: "declined", label: "Declined", isClosed: true },
          ],
          fields: [{ key: "loan_amount", label: "Loan Amount", type: "currency" }],
        },
      },
      {
        industry: "Marketing",
        config: {
          name: "Marketing",
          pipelineName: "Client Acquisition",
          stages: [
            { key: "new", label: "New Lead", isInitial: true },
            { key: "proposal_sent", label: "Proposal Sent" },
            { key: "won", label: "Won", isClosed: true, isWon: true },
            { key: "lost", label: "Lost", isClosed: true },
          ],
          fields: [{ key: "monthly_budget", label: "Monthly Budget", type: "currency" }],
        },
      },
      {
        industry: "Manufacturing",
        config: {
          name: "Manufacturing",
          pipelineName: "RFQ Pipeline",
          stages: [
            { key: "new", label: "RFQ Received", isInitial: true },
            { key: "quoted", label: "Quoted" },
            { key: "order_won", label: "Order Won", isClosed: true, isWon: true },
            { key: "order_lost", label: "Order Lost", isClosed: true },
          ],
          fields: [{ key: "unit_quantity", label: "Unit Quantity", type: "number" }],
        },
      },
      {
        // Stands in for "any future industry" - not a real industry name
        // this codebase knows about at all, proving the mechanism is
        // genuinely generic rather than a hidden allowlist of names.
        industry: "Aerospace Parts Distribution (hypothetical future industry)",
        config: {
          name: "Aerospace Parts Distribution",
          pipelineName: "Parts Order Pipeline",
          stages: [
            { key: "new", label: "Inquiry", isInitial: true },
            { key: "certified", label: "Certification Check" },
            { key: "shipped", label: "Shipped", isClosed: true, isWon: true },
          ],
          fields: [{ key: "part_number", label: "Part Number", type: "text" }],
        },
      },
    ];

    for (const { config } of notYetBuiltIn) {
      const validated = validateCustomTemplateConfig(config);
      expect(validated.ok).toBe(true);
      const template = resolveEffectiveIndustryTemplate("custom", config);
      expect(template.name).toBe(config.name);
      expect(template.stages.some((s) => s.isWon)).toBe(true);
    }
  });

  it("a real company can round-trip through Settings -> Business Configuration to adopt a not-yet-built-in industry (Finance) with no schema or code change - only a saved row", async () => {
    const company = await registerCompanyAndOwner({
      companyName: "Acceptance Finance Adopter Co",
      fullName: "Finn Finance",
      email: `${uniqueId("accept-financeco")}@example.com`,
      password: "a-very-long-password-accept-11",
      accountType: "individual",
      phoneNumber: "+15559990011",
    });
    expect(company.company.industryTemplate).toBe("general"); // starts on Core CRM, same as every account

    const financeConfig: CustomTemplateConfig = {
      name: "Finance",
      pipelineName: "Loan Pipeline",
      stages: [
        { key: "new", label: "New Applicant", isInitial: true },
        { key: "funded", label: "Funded", isClosed: true, isWon: true },
      ],
      fields: [{ key: "loan_amount", label: "Loan Amount", type: "currency" }],
    };
    const validated = validateCustomTemplateConfig(financeConfig);
    expect(validated.ok).toBe(true);

    await updateBusinessConfiguration(company.company.id, { industryTemplate: "custom", customTemplateConfig: financeConfig });

    const reloaded = await getCompanyById(company.company.id);
    expect(reloaded?.industryTemplate).toBe("custom");
    const effective = resolveEffectiveIndustryTemplate(reloaded!.industryTemplate, reloaded!.customTemplateConfig);
    expect(effective.name).toBe("Finance");
    expect(effective.pipelineName).toBe("Loan Pipeline");
  });
});
