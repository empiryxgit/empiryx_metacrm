// PHASE 28 - final acceptance test for the "Individual User — Guided
// First-Time Onboarding" review request, mapped literally to its own
// acceptance criteria. Same real-Postgres, no-mocking convention as
// src/security/completeSystemAcceptance.test.ts, which this file
// deliberately mirrors in style and sits alongside (that file already
// covers "No Industry Required -> Create Account -> Use CRM" for
// Individual at a CRM-usage level; this file is specifically about the
// GUIDED SETUP EXPERIENCE itself - Welcome, resumability, and the
// Setup Complete -> Dashboard handoff - which didn't exist when that file
// was written).

import { describe, expect, it } from "vitest";
import { registerCompanyAndOwner } from "../application/auth";
import {
  completeWizard,
  getOnboardingContext,
  saveBusinessProfile,
  saveLeadSources,
  skipCurrentStep,
} from "../application/onboardingWizard";
import { getCompanyById } from "../infrastructure/db/repositories/tenancy";
import { uniqueId } from "../testSupport/dbFixtures";

describe.skipIf(!process.env.DATABASE_URL)("ACCEPTANCE: Individual guided onboarding — full target experience", () => {
  it("Register -> Select Individual -> No Industry Required -> Account Created", async () => {
    const email = `${uniqueId("accept-onb-register")}@example.com`;
    const result = await registerCompanyAndOwner({
      companyName: "Acceptance Onboarding Solo Co",
      fullName: "Riley Solo",
      email,
      password: "a-very-long-password-accept-onb-1",
      accountType: "individual",
      phoneNumber: "+15559991001",
      // industry intentionally omitted - "No Industry Required".
    });
    expect(result.company.industryTemplate).toBe("general"); // defaulted, never asked for, never blocked account creation

    // "Account Created" -> the guided wizard is what a first login lands
    // on, NOT an empty dashboard: onboardingStatus is NOT_STARTED (never
    // COMPLETED at this point), so App.requireAuth() on dashboard.html
    // would redirect straight to onboarding.html. This is the single most
    // important behavior this whole feature exists to produce - see the
    // review request's own closing line: "The CRM is helping me get
    // started," not "Here is an empty dashboard."
    const company = await getCompanyById(result.company.id);
    expect(company?.onboardingStatus).toBe("NOT_STARTED");
    expect(company?.onboardingCompletedAt).toBeNull();
  });

  it("First Login -> Welcome -> Guided Setup (Business/CRM/Pipeline/Lead Sources/Meta all configurable, industry and Meta both optional) -> Setup Complete -> Dashboard", async () => {
    const result = await registerCompanyAndOwner({
      companyName: "Acceptance Onboarding Full Co",
      fullName: "Casey Guided",
      email: `${uniqueId("accept-onb-full")}@example.com`,
      password: "a-very-long-password-accept-onb-2",
      accountType: "individual",
      phoneNumber: "+15559991002",
    });
    const companyId = result.company.id;
    const userId = result.user.id;

    // "Welcome": a fresh, never-touched company presents NOT_STARTED with
    // no resume step - this is exactly what tells onboarding.html to show
    // the Welcome screen rather than resuming mid-flow.
    let ctx = await getOnboardingContext(companyId);
    expect(ctx).toMatchObject({ status: "NOT_STARTED", step: null });

    // "Guided Setup" step 1 - Business Profile. Configurable, and this is
    // also where the wizard bootstraps NOT_STARTED -> IN_PROGRESS.
    ctx = await saveBusinessProfile(companyId, userId, { businessName: "Acceptance Onboarding Full Co", website: "example.com" });
    expect(ctx.status).toBe("IN_PROGRESS");

    // Step 2 - CRM Basics (configurable; also exercised skipped elsewhere).
    ctx = await skipCurrentStep(companyId, "CRM_BASICS");
    // Step 3 - Pipeline (configurable via the recommended-vs-customize choice).
    ctx = await skipCurrentStep(companyId, "PIPELINE");
    // Step 4 - Lead Sources (configurable).
    ctx = await saveLeadSources(companyId, ["website", "phone"]);

    // "Meta optional": no facebook/instagram selected above, so the Meta
    // Connection step never even applies - proving Meta can never block
    // completion.
    expect(ctx.isMetaConnectionApplicable).toBe(false);
    ctx = await skipCurrentStep(companyId, "META_CONNECTION");
    expect(ctx.step).toBe("REVIEW");

    // "Setup Complete -> Dashboard": completing the wizard is what flips
    // onboardingCompletedAt, the exact field App.requireAuth() gates
    // dashboard.html on.
    ctx = await completeWizard(companyId, userId);
    expect(ctx.status).toBe("COMPLETED");
    const company = await getCompanyById(companyId);
    expect(company?.onboardingCompletedAt).not.toBeNull();
  });

  it("Returning User -> Login -> Dashboard directly, no re-onboarding, once already COMPLETED", async () => {
    const result = await registerCompanyAndOwner({
      companyName: "Acceptance Onboarding Returning Co",
      fullName: "Drew Returning",
      email: `${uniqueId("accept-onb-returning")}@example.com`,
      password: "a-very-long-password-accept-onb-3",
      accountType: "individual",
      phoneNumber: "+15559991003",
    });
    const companyId = result.company.id;
    await saveBusinessProfile(companyId, result.user.id, {});
    await skipCurrentStep(companyId, "CRM_BASICS");
    await skipCurrentStep(companyId, "PIPELINE");
    await skipCurrentStep(companyId, "LEAD_SOURCE");
    await skipCurrentStep(companyId, "META_CONNECTION");
    await completeWizard(companyId, result.user.id);

    // Simulate "logs back in later" - a completely fresh read of state,
    // same as what /api/onboarding/wizard/status (and /api/auth/me) would
    // return on the next login. Must be COMPLETED with no step to resume -
    // App.requireAuth() would let this straight through to dashboard.html,
    // never redirecting into onboarding.html again.
    const ctx = await getOnboardingContext(companyId);
    expect(ctx).toMatchObject({ status: "COMPLETED", step: null });
  });

  it("Interrupted Setup -> Login -> Resume Setup at exactly the step they left off on", async () => {
    const result = await registerCompanyAndOwner({
      companyName: "Acceptance Onboarding Interrupted Co",
      fullName: "Jamie Interrupted",
      email: `${uniqueId("accept-onb-interrupted")}@example.com`,
      password: "a-very-long-password-accept-onb-4",
      accountType: "individual",
      phoneNumber: "+15559991004",
    });
    const companyId = result.company.id;

    // Gets partway through, then "closes the browser" (or the tab crashes,
    // or they just walk away) - nothing beyond what's already been saved
    // exists anywhere in memory.
    await saveBusinessProfile(companyId, result.user.id, { businessName: "Interrupted Co" });
    await skipCurrentStep(companyId, "CRM_BASICS"); // now resting at PIPELINE

    // "Login -> Resume Setup": a brand-new read, exactly what a fresh page
    // load of onboarding.html after logging back in would fetch from GET
    // /api/onboarding/wizard/status.
    const resumed = await getOnboardingContext(companyId);
    expect(resumed).toMatchObject({ status: "IN_PROGRESS", step: "PIPELINE" });
    // The data already entered was never lost.
    expect(resumed?.company.name).toBe("Interrupted Co");
  });
});
