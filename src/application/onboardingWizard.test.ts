// Real-Postgres lifecycle + security tests for the guided onboarding
// wizard's application layer (PHASE 26/27 of the "Individual User — Guided
// First-Time Onboarding" review request). Same real-Postgres, no-mocking
// convention as every other src/security/*.test.ts and *.flow.test.ts file
// in this project - every assertion here reflects the actual schema and
// the actual canSubmitOnboardingStep() authorization rule, not a mock.
//
// Tenants are created via the REAL registerCompanyAndOwner() (not a
// hand-rolled fixture) so every test exercises the exact same path a real
// Individual signup goes through, including the NOT_STARTED bootstrap this
// phase wires into it.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerCompanyAndOwner } from "./auth";
import {
  OnboardingWizardError,
  addFirstLead,
  completeWizard,
  getOnboardingContext,
  saveBusinessProfile,
  saveCrmBasics,
  saveLeadSources,
  savePipelineChoice,
  skipCurrentStep,
} from "./onboardingWizard";
import { uniqueId } from "../testSupport/dbFixtures";

async function newIndividual(label: string) {
  const result = await registerCompanyAndOwner({
    companyName: `Onboarding Wizard ${label} Co`,
    fullName: `${label} Owner`,
    email: `${uniqueId(`onb-wizard-${label}`)}@example.com`,
    password: "a-very-long-password-onb-wizard-1",
    accountType: "individual",
    phoneNumber: "+15558881000",
  });
  return { companyId: result.company.id, userId: result.user.id };
}

describe.skipIf(!process.env.DATABASE_URL)("onboardingWizard - full happy-path lifecycle", () => {
  it("walks every step in order (with Meta applicable) and lands on COMPLETED", async () => {
    const { companyId, userId } = await newIndividual("HappyPath");

    // A fresh Individual signup starts NOT_STARTED with nothing to resume.
    let ctx = await getOnboardingContext(companyId);
    expect(ctx).toMatchObject({ status: "NOT_STARTED", step: null });

    // Step 1 - Business Profile bootstraps NOT_STARTED -> IN_PROGRESS and
    // advances the resume pointer to CRM_BASICS.
    ctx = await saveBusinessProfile(companyId, userId, {
      businessName: "Renamed Business",
      industry: "Real Estate Broker",
      website: "www.example.com",
      phoneNumber: "+15558881111",
    });
    expect(ctx).toMatchObject({ status: "IN_PROGRESS", step: "CRM_BASICS" });
    expect(ctx.company).toMatchObject({ name: "Renamed Business", industry: "Real Estate Broker", website: "www.example.com" });

    // Step 2 - CRM Basics.
    ctx = await saveCrmBasics(companyId, { leadTerminology: "Prospect" });
    expect(ctx).toMatchObject({ step: "PIPELINE" });
    expect(ctx.company.leadTerminology).toBe("Prospect");

    // Step 3 - Pipeline (no DB write of its own - see PHASE 8's own design).
    ctx = await savePipelineChoice(companyId, "recommended");
    expect(ctx).toMatchObject({ step: "LEAD_SOURCE" });

    // Step 4 - Lead Source, including "facebook" - this is what makes the
    // Meta Connection step applicable next.
    ctx = await saveLeadSources(companyId, ["facebook", "whatsapp"]);
    expect(ctx).toMatchObject({ step: "META_CONNECTION" });
    expect(ctx.company.selectedLeadSources).toEqual(["facebook", "whatsapp"]);
    expect(ctx.isMetaConnectionApplicable).toBe(true);

    // Step 5 - Meta Connection is optional and never blocks (PHASE 21) -
    // skipping it here, same as clicking "Continue Without Meta".
    ctx = await skipCurrentStep(companyId, "META_CONNECTION");
    expect(ctx).toMatchObject({ step: "REVIEW" });

    // Step 6 - Review -> Finish.
    ctx = await completeWizard(companyId, userId);
    expect(ctx).toMatchObject({ status: "COMPLETED", step: null });
    expect(ctx.completedAt).not.toBeNull();
  });

  it("skipping every optional step still reaches COMPLETED - onboarding never traps the user", async () => {
    const { companyId, userId } = await newIndividual("SkipAll");

    await saveBusinessProfile(companyId, userId, { businessName: "Skip-Everything Co" });
    let ctx = await skipCurrentStep(companyId, "CRM_BASICS");
    expect(ctx.step).toBe("PIPELINE");
    ctx = await skipCurrentStep(companyId, "PIPELINE");
    expect(ctx.step).toBe("LEAD_SOURCE");
    ctx = await skipCurrentStep(companyId, "LEAD_SOURCE");
    // No lead sources were ever selected, so Meta Connection never applies -
    // the frontend would auto-skip it; here we just confirm the flag.
    expect(ctx.step).toBe("META_CONNECTION");
    expect(ctx.isMetaConnectionApplicable).toBe(false);
    ctx = await skipCurrentStep(companyId, "META_CONNECTION");
    expect(ctx.step).toBe("REVIEW");
    ctx = await completeWizard(companyId, userId);
    expect(ctx.status).toBe("COMPLETED");
  });

  it("Meta Connection is skipped only when NOT selecting Facebook/Instagram - selecting only 'website' never makes it applicable", async () => {
    const { companyId, userId } = await newIndividual("NoMeta");
    await saveBusinessProfile(companyId, userId, {});
    await skipCurrentStep(companyId, "CRM_BASICS");
    await skipCurrentStep(companyId, "PIPELINE");
    const ctx = await saveLeadSources(companyId, ["website", "manual"]);
    expect(ctx.isMetaConnectionApplicable).toBe(false);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("onboardingWizard - resume behavior", () => {
  it("a browser closed mid-wizard resumes exactly at the last saved step on a fresh read", async () => {
    const { companyId, userId } = await newIndividual("Resume");
    await saveBusinessProfile(companyId, userId, {});
    await saveCrmBasics(companyId, {});

    // Simulate "closed the browser, came back later" - a totally fresh
    // read, no in-memory state carried over.
    const resumed = await getOnboardingContext(companyId);
    expect(resumed).toMatchObject({ status: "IN_PROGRESS", step: "PIPELINE" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("onboardingWizard - authorization / cannot corrupt state", () => {
  it("rejects submitting a step ahead of the company's own furthest reach - no skipping ahead via a crafted request", async () => {
    const { companyId, userId } = await newIndividual("NoJumpAhead");
    await saveBusinessProfile(companyId, userId, {}); // now at CRM_BASICS

    // Attempting to submit LEAD_SOURCE (two steps ahead) must fail, not
    // silently succeed and corrupt the resume pointer.
    await expect(saveLeadSources(companyId, ["facebook"])).rejects.toBeInstanceOf(OnboardingWizardError);

    // State is unchanged - still resumes at CRM_BASICS.
    const ctx = await getOnboardingContext(companyId);
    expect(ctx).toMatchObject({ step: "CRM_BASICS" });
  });

  it("resubmitting the CURRENT step (e.g. retrying after a failed save) is always allowed, never treated as 'jumping ahead'", async () => {
    const { companyId, userId } = await newIndividual("RetrySameStep");
    await saveBusinessProfile(companyId, userId, {}); // now at CRM_BASICS
    await expect(saveCrmBasics(companyId, { leadTerminology: "Enquiry" })).resolves.toMatchObject({ step: "PIPELINE" });
  });

  it("navigating BACK and resubmitting an earlier, already-completed step is allowed", async () => {
    const { companyId, userId } = await newIndividual("BackEdit");
    await saveBusinessProfile(companyId, userId, { businessName: "First Name" });
    await saveCrmBasics(companyId, {}); // now at PIPELINE

    // Go back and resubmit step 1.
    const ctx = await saveBusinessProfile(companyId, userId, { businessName: "Corrected Name" });
    expect(ctx.company.name).toBe("Corrected Name");
  });

  it("a COMPLETED company can never resubmit any wizard step - onboarding is closed for good", async () => {
    const { companyId, userId } = await newIndividual("AlreadyDone");
    await saveBusinessProfile(companyId, userId, {});
    await skipCurrentStep(companyId, "CRM_BASICS");
    await skipCurrentStep(companyId, "PIPELINE");
    await skipCurrentStep(companyId, "LEAD_SOURCE");
    await skipCurrentStep(companyId, "META_CONNECTION");
    await completeWizard(companyId, userId);

    await expect(saveBusinessProfile(companyId, userId, { businessName: "Too Late" })).rejects.toBeInstanceOf(OnboardingWizardError);
    await expect(completeWizard(companyId, userId)).rejects.toBeInstanceOf(OnboardingWizardError);

    // Confirm the rejected attempt genuinely changed nothing.
    const ctx = await getOnboardingContext(companyId);
    expect(ctx?.company.name).not.toBe("Too Late");
  });

  it("REVIEW cannot be 'skipped' - Finish (completeWizard) is the only way past it", async () => {
    const { companyId, userId } = await newIndividual("NoSkipReview");
    await saveBusinessProfile(companyId, userId, {});
    await skipCurrentStep(companyId, "CRM_BASICS");
    await skipCurrentStep(companyId, "PIPELINE");
    await skipCurrentStep(companyId, "LEAD_SOURCE");
    await skipCurrentStep(companyId, "META_CONNECTION"); // now at REVIEW

    await expect(skipCurrentStep(companyId, "REVIEW")).rejects.toBeInstanceOf(OnboardingWizardError);
  });

  it("rejects an invalid lead-source selection instead of silently persisting garbage", async () => {
    const { companyId, userId } = await newIndividual("BadLeadSource");
    await saveBusinessProfile(companyId, userId, {});
    await skipCurrentStep(companyId, "CRM_BASICS");
    await skipCurrentStep(companyId, "PIPELINE");

    await expect(saveLeadSources(companyId, ["not-a-real-source"])).rejects.toBeInstanceOf(OnboardingWizardError);
    await expect(saveLeadSources(companyId, [])).rejects.toBeInstanceOf(OnboardingWizardError); // must select at least one, or Skip

    const ctx = await getOnboardingContext(companyId);
    expect(ctx?.company.selectedLeadSources).toBeNull();
  });

  it("acting on a nonexistent company throws rather than crashing", async () => {
    await expect(saveBusinessProfile(randomUUID(), randomUUID(), {})).rejects.toBeInstanceOf(OnboardingWizardError);
  });

  it("two tenants' wizards are fully isolated - progressing one never touches the other", async () => {
    const a = await newIndividual("TenantA");
    const b = await newIndividual("TenantB");

    await saveBusinessProfile(a.companyId, a.userId, { businessName: "Tenant A Business" });
    await saveBusinessProfile(b.companyId, b.userId, { businessName: "Tenant B Business" });
    await saveCrmBasics(a.companyId, {}); // advance ONLY tenant A

    const ctxA = await getOnboardingContext(a.companyId);
    const ctxB = await getOnboardingContext(b.companyId);
    expect(ctxA).toMatchObject({ step: "PIPELINE" });
    expect(ctxB).toMatchObject({ step: "CRM_BASICS" }); // untouched by A's progress
    expect(ctxA?.company.name).toBe("Tenant A Business");
    expect(ctxB?.company.name).toBe("Tenant B Business");
  });
});

describe.skipIf(!process.env.DATABASE_URL)("onboardingWizard - first lead shortcut", () => {
  it("creates a real lead in the company's initial pipeline stage, independent of wizard step", async () => {
    const { companyId, userId } = await newIndividual("FirstLead");
    await saveBusinessProfile(companyId, userId, {});

    const lead = await addFirstLead(companyId, { fullName: "Jordan Customer", phoneNumber: "+15558882222" });
    expect(lead.companyId).toBe(companyId);
    expect(lead.fullName).toBe("Jordan Customer");
    expect(lead.source).toBe("manual");
    expect(lead.pipelineStage).toBeTruthy();
  });

  it("rejects a first lead with no name rather than creating a blank record", async () => {
    const { companyId } = await newIndividual("FirstLeadNoName");
    await expect(addFirstLead(companyId, { fullName: "  " })).rejects.toBeInstanceOf(OnboardingWizardError);
  });
});
