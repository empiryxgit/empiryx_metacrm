// End-to-end backend tests for the three complete registration flows named
// in the review request. Each test drives the REAL application-layer
// functions in the exact sequence the corresponding flow diagram names,
// against real Postgres, and asserts every named step actually happened -
// not just that the final function call didn't throw. Frontend redirect
// targets (which literal .html page a flow lands on) are cited from the
// actual page source in each test's comments, not re-implemented here -
// see register.html and onboarding-agency.html.
//
// Same real-Postgres, no-mocking convention as every other
// src/security/*.test.ts file.

import { describe, expect, it } from "vitest";
import { registerCompanyAndOwner } from "../application/auth";
import { generateOnboardingLink, getOnboardingLinkPreview, completeAgencyOnboarding } from "../application/agencyOnboarding";
import { getCompanyById } from "../infrastructure/db/repositories/tenancy";
import { getClaimingAgencyForClient, listClaimedClientOrganizations } from "../infrastructure/db/repositories/organizations";
import { uniqueId } from "../testSupport/dbFixtures";

describe.skipIf(!process.env.DATABASE_URL)("Registration flow: Individual", () => {
  it("Register -> Select Individual -> Create Account -> Dashboard, with no industry required", async () => {
    // "Select Individual": public/register.html's step 1 radio defaults to
    // "individual" and sends accountType: "individual" - reproduced here by
    // passing it explicitly. Deliberately NOT passing `industry` at all -
    // register.html's form has no industry field for either account type
    // (see its own header comment), so a real request from that page never
    // sends one.
    const email = `${uniqueId("regflow-individual")}@example.com`;
    const result = await registerCompanyAndOwner({
      companyName: "Solo Leads Co",
      fullName: "Jordan Solo",
      email,
      password: "a-very-long-password-abc",
      accountType: "individual",
      phoneNumber: "+15551234000",
      // industry intentionally omitted
    });

    // "Create Account" succeeded: company + Owner role + user, all in one
    // shot, no industry decision required anywhere in this path.
    expect(result.company.accountType).toBe("individual");
    expect(result.company.industryTemplate).toBe("general"); // defaulted, never asked for
    expect(result.role.isSystem).toBe(true);
    expect(result.role.name).toBe("Owner"); // the single generic Owner role, not one of the four fixed agency roles
    expect(result.user.email).toBe(email);

    // "-> Onboarding -> Dashboard": as of the guided first-time onboarding
    // wizard (see src/domain/onboarding.ts), register.html now sends a
    // fresh Individual signup straight to /onboarding.html, not
    // /dashboard.html directly - App.requireAuth() would bounce it there
    // anyway (onboardingCompletedAt is still null), so the guided wizard IS
    // the first thing this account sees, exactly per the review request's
    // own "the individual user's first experience" goal: never straight to
    // an empty dashboard. Dashboard access only resumes once that wizard's
    // own completeWizard() runs (see src/application/onboardingWizard.test.ts
    // for the full step-by-step lifecycle) - not asserted again here.
    const company = await getCompanyById(result.company.id);
    expect(company?.onboardingCompletedAt).toBeNull();
    expect(company?.onboardingStatus).toBe("NOT_STARTED");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Registration flow: Agency", () => {
  it("Register -> Select Agency -> Create Agency -> Agency Dashboard", async () => {
    const email = `${uniqueId("regflow-agency")}@example.com`;
    const result = await registerCompanyAndOwner({
      companyName: "Acme Lead Agency",
      fullName: "Alex Agency",
      email,
      password: "a-very-long-password-def",
      accountType: "agency", // "Select Agency"
      phoneNumber: "+15551234001",
    });

    // "Create Agency" - the fixed AGENCY_OWNER/ADMIN/MANAGER/USER role
    // catalog is provisioned (not the generic single Owner role), and the
    // registering user becomes AGENCY_OWNER: full access, sees every
    // client by default.
    expect(result.company.accountType).toBe("agency");
    expect(result.role.isSystem).toBe(true);
    expect(result.role.name).toBe("AGENCY_OWNER");
    expect((result.role.permissions as string[])).toContain("agency_clients.view_all");

    // "-> Agency Dashboard": register.html routes accountType === "agency"
    // straight to /agency-dashboard.html - again only meaningful once
    // onboarding is already complete.
    const company = await getCompanyById(result.company.id);
    expect(company?.onboardingCompletedAt).not.toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Registration flow: Agency Client (onboarding link)", () => {
  it("Agency generates link -> Client opens link -> Client registers -> org created -> auto-linked to agency -> Client Dashboard", async () => {
    // "Agency" - a real agency account, created the same way the Agency
    // flow test above proves out, not a bare fixture row.
    const agencyEmail = `${uniqueId("regflow-client-agency")}@example.com`;
    const agency = await registerCompanyAndOwner({
      companyName: "Beta Lead Agency",
      fullName: "Bailey Agency",
      email: agencyEmail,
      password: "a-very-long-password-ghi",
      accountType: "agency",
      phoneNumber: "+15551234002",
    });

    // "Generate onboarding link"
    const contactEmail = `${uniqueId("regflow-client-contact")}@example.com`;
    const link = await generateOnboardingLink({
      agencyCompanyId: agency.company.id,
      actingUserId: agency.user.id,
      clientName: "Gamma Client Co",
      contactEmail,
    });
    expect(link.token).toBeTruthy();

    // "Client opens link" - the public, non-consuming preview
    // public/onboarding-agency.html calls before showing its own
    // registration form. Confirms the link resolves to the right agency
    // WITHOUT spending it (still redeemable afterward, asserted below).
    const preview = await getOnboardingLinkPreview(link.token);
    expect(preview.agencyName).toBe("Beta Lead Agency");
    expect(preview.clientName).toBe("Gamma Client Co");
    expect(preview.contactEmail).toBe(contactEmail);

    // "Client registers"
    const clientOwnerEmail = `${uniqueId("regflow-client-owner")}@example.com`;
    const completion = await completeAgencyOnboarding({
      token: link.token,
      companyName: "Gamma Client Co",
      ownerName: "Gale Client",
      ownerEmail: clientOwnerEmail,
      phoneNumber: "+15551234003",
      password: "a-very-long-password-jkl",
    });

    // "Client organization created" - a brand-new, independent tenant
    // (accountType "individual" - a client org is never itself an agency),
    // with its own Owner-equivalent user.
    const clientCompany = await getCompanyById(completion.company.id);
    expect(clientCompany).not.toBeNull();
    expect(clientCompany?.accountType).toBe("individual");
    expect(completion.owner.email).toBe(clientOwnerEmail);

    // "Automatically linked to agency" - already "active", not "invited":
    // unlike inviteExistingClient's flow, completing an onboarding link
    // needs no separate accept/decline step (see completeAgencyOnboarding's
    // own doc comment on why).
    const claim = await getClaimingAgencyForClient(completion.company.id);
    expect(claim?.agencyCompanyId).toBe(agency.company.id);
    expect(claim?.relationshipStatus).toBe("active");
    const roster = await listClaimedClientOrganizations(agency.company.id);
    expect(roster.some((c) => c.clientCompanyId === completion.company.id)).toBe(true);

    // "-> Client Dashboard": onboarding-agency.html sends window.location to
    // /dashboard.html on success (the SAME dashboard.html an Individual
    // account lands on - a client org is architecturally just another
    // "individual"-accountType company) - again only meaningful with
    // onboarding already marked complete.
    expect(clientCompany?.onboardingCompletedAt).not.toBeNull();
  });
});
