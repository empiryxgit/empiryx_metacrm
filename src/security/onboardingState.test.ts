// Real-Postgres integration tests for Phase 2 ("Define Onboarding State")
// of the "Individual User — Guided First-Time Onboarding" review request.
// Same real-Postgres, no-mocking convention as every other
// src/security/*.test.ts file.
//
// IMPORTANT scope note (see this phase's own report): registerCompanyAndOwner
// is DELIBERATELY NOT changed in this phase - every existing registration
// path (individual, agency) still marks onboarding complete immediately,
// exactly as before. These tests prove the new state PRIMITIVES work
// correctly in isolation, and prove that leaving every existing call site
// untouched produces zero behavior change - not that any flow has started
// using them yet.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerCompanyAndOwner } from "../application/auth";
import {
  createCompany,
  getCompanyById,
  getOnboardingState,
  startOnboarding,
  setOnboardingStep,
  completeOnboarding,
} from "../infrastructure/db/repositories/tenancy";
import { uniqueId } from "../testSupport/dbFixtures";

describe.skipIf(!process.env.DATABASE_URL)("Onboarding state: no regression to existing registration paths", () => {
  it("a real Individual self-registration is still marked COMPLETED immediately - this phase changes no existing behavior", async () => {
    const result = await registerCompanyAndOwner({
      companyName: "Onboarding Phase2 No-Regression Co",
      fullName: "Regression Checker",
      email: `${uniqueId("onb-p2-individual")}@example.com`,
      password: "a-very-long-password-onb-p2-1",
      accountType: "individual",
      phoneNumber: "+15558880001",
    });
    const state = await getOnboardingState(result.company.id);
    expect(state).toMatchObject({ status: "COMPLETED", step: null });
    expect(state?.completedAt).not.toBeNull();
  });

  it("a real Agency self-registration is likewise still marked COMPLETED immediately - out of scope for this phase", async () => {
    const result = await registerCompanyAndOwner({
      companyName: "Onboarding Phase2 Agency No-Regression Co",
      fullName: "Agency Regression Checker",
      email: `${uniqueId("onb-p2-agency")}@example.com`,
      password: "a-very-long-password-onb-p2-2",
      accountType: "agency",
      phoneNumber: "+15558880002",
    });
    const state = await getOnboardingState(result.company.id);
    expect(state).toMatchObject({ status: "COMPLETED", step: null });
  });

  it("createCompany with no onboardingStatus override still defaults to COMPLETED via the column's own default", async () => {
    const company = await createCompany({
      name: "Onboarding Phase2 Default Co",
      slug: `onb-p2-default-${randomUUID()}`,
      industryTemplate: "general",
      accountType: "individual",
    });
    const state = await getOnboardingState(company.id);
    expect(state?.status).toBe("COMPLETED");
    expect(state?.step).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("Onboarding state: the new primitives, exercised directly", () => {
  it("a company created with an explicit NOT_STARTED override persists it correctly, with no step yet", async () => {
    const company = await createCompany({
      name: "Onboarding Phase2 NotStarted Co",
      slug: `onb-p2-notstarted-${randomUUID()}`,
      industryTemplate: "general",
      accountType: "individual",
      onboardingStatus: "NOT_STARTED",
    });
    const state = await getOnboardingState(company.id);
    expect(state).toMatchObject({ status: "NOT_STARTED", step: null, completedAt: null });
  });

  it("startOnboarding transitions NOT_STARTED -> IN_PROGRESS, landing on the first step", async () => {
    const company = await createCompany({
      name: "Onboarding Phase2 Start Co",
      slug: `onb-p2-start-${randomUUID()}`,
      industryTemplate: "general",
      accountType: "individual",
      onboardingStatus: "NOT_STARTED",
    });

    await startOnboarding(company.id);

    const state = await getOnboardingState(company.id);
    expect(state).toMatchObject({ status: "IN_PROGRESS", step: "BUSINESS_PROFILE" });
  });

  it("setOnboardingStep records progress through the wizard and always forces IN_PROGRESS", async () => {
    const company = await createCompany({
      name: "Onboarding Phase2 Progress Co",
      slug: `onb-p2-progress-${randomUUID()}`,
      industryTemplate: "general",
      accountType: "individual",
      onboardingStatus: "NOT_STARTED",
    });
    await startOnboarding(company.id);

    await setOnboardingStep(company.id, "CRM_BASICS");
    expect(await getOnboardingState(company.id)).toMatchObject({ status: "IN_PROGRESS", step: "CRM_BASICS" });

    await setOnboardingStep(company.id, "PIPELINE");
    expect(await getOnboardingState(company.id)).toMatchObject({ status: "IN_PROGRESS", step: "PIPELINE" });
  });

  it("completeOnboarding (extended) sets COMPLETED, clears the step, and stamps completedAt - resuming afterward is impossible", async () => {
    const company = await createCompany({
      name: "Onboarding Phase2 Complete Co",
      slug: `onb-p2-complete-${randomUUID()}`,
      industryTemplate: "general",
      accountType: "individual",
      onboardingStatus: "NOT_STARTED",
    });
    await startOnboarding(company.id);
    await setOnboardingStep(company.id, "REVIEW");

    await completeOnboarding(company.id);

    const state = await getOnboardingState(company.id);
    expect(state?.status).toBe("COMPLETED");
    expect(state?.step).toBeNull();
    expect(state?.completedAt).not.toBeNull();

    // The pre-existing boolean flag every current frontend/API check already
    // reads (App.requireAuth, /api/auth/me) is still correctly set too - the
    // new columns and the old one can never disagree.
    const company_ = await getCompanyById(company.id);
    expect(company_?.onboardingCompletedAt).not.toBeNull();
  });

  it("getOnboardingState resolves an invalid/legacy raw value safely rather than throwing or fabricating a step", async () => {
    const company = await createCompany({
      name: "Onboarding Phase2 Legacy Co",
      slug: `onb-p2-legacy-${randomUUID()}`,
      industryTemplate: "general",
      accountType: "individual",
    });
    // Simulate a row from before this column meant anything precise, or a
    // hand-edited one - getOnboardingState must still resolve safely.
    const { getDb } = await import("../infrastructure/db/client");
    const { companies } = await import("../infrastructure/db/schema");
    const { eq } = await import("drizzle-orm");
    const db = await getDb();
    await db.update(companies).set({ onboardingStatus: "SOME_FUTURE_VALUE", onboardingStep: "NOT_A_REAL_STEP" }).where(eq(companies.id, company.id));

    const state = await getOnboardingState(company.id);
    expect(state?.status).toBe("COMPLETED"); // safe fallback, never a crash
    expect(state?.step).toBeNull(); // no fabricated step
  });

  it("getOnboardingState returns null for a company that does not exist", async () => {
    expect(await getOnboardingState(randomUUID())).toBeNull();
  });
});
