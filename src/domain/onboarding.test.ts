// Pure-logic tests for the guided onboarding state model (Phase 2 of the
// "Individual User — Guided First-Time Onboarding" review request). No
// database involved - see src/security/onboardingState.test.ts for the
// real-Postgres repository-level coverage.

import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STATUSES,
  ONBOARDING_STEPS,
  FIRST_ONBOARDING_STEP,
  ONBOARDING_LEAD_SOURCE_OPTIONS,
  isOnboardingStatus,
  isOnboardingStep,
  resolveOnboardingStatus,
  resolveOnboardingStep,
  isOnboardingStepUnlocked,
  nextOnboardingStep,
  canSubmitOnboardingStep,
  isValidOnboardingLeadSourceSelection,
  isMetaConnectionApplicable,
} from "./onboarding";

describe("resolveOnboardingStatus", () => {
  it("passes through each real status unchanged", () => {
    for (const s of ONBOARDING_STATUSES) {
      expect(resolveOnboardingStatus(s)).toBe(s);
    }
  });

  it("falls back to COMPLETED for anything unrecognized - never traps a company behind a wizard it can't identify", () => {
    expect(resolveOnboardingStatus(null)).toBe("COMPLETED");
    expect(resolveOnboardingStatus(undefined)).toBe("COMPLETED");
    expect(resolveOnboardingStatus("bogus")).toBe("COMPLETED");
    expect(resolveOnboardingStatus(42)).toBe("COMPLETED");
  });
});

describe("resolveOnboardingStep", () => {
  it("passes through each real step unchanged", () => {
    for (const s of ONBOARDING_STEPS) {
      expect(resolveOnboardingStep(s)).toBe(s);
    }
  });

  it("resolves to null (not a fabricated step) for anything unrecognized", () => {
    expect(resolveOnboardingStep(null)).toBeNull();
    expect(resolveOnboardingStep(undefined)).toBeNull();
    expect(resolveOnboardingStep("bogus")).toBeNull();
  });
});

describe("isOnboardingStatus / isOnboardingStep", () => {
  it("type guards agree exactly with the resolve functions' notion of valid", () => {
    expect(isOnboardingStatus("IN_PROGRESS")).toBe(true);
    expect(isOnboardingStatus("in_progress")).toBe(false); // case-sensitive, matches the DB's stored casing exactly
    expect(isOnboardingStep("PIPELINE")).toBe(true);
    expect(isOnboardingStep("Pipeline")).toBe(false);
  });
});

describe("step ordering", () => {
  it("FIRST_ONBOARDING_STEP is BUSINESS_PROFILE - the wizard always starts here", () => {
    expect(FIRST_ONBOARDING_STEP).toBe("BUSINESS_PROFILE");
    expect(ONBOARDING_STEPS[0]).toBe(FIRST_ONBOARDING_STEP);
  });

  it("nextOnboardingStep walks the full six-step sequence and terminates after REVIEW", () => {
    let step = FIRST_ONBOARDING_STEP;
    const visited = [step];
    for (let i = 0; i < ONBOARDING_STEPS.length - 1; i++) {
      const next = nextOnboardingStep(step);
      expect(next).not.toBeNull();
      visited.push(next!);
      step = next!;
    }
    expect(visited).toEqual(ONBOARDING_STEPS);
    expect(nextOnboardingStep("REVIEW")).toBeNull(); // nothing after the last step but Setup Complete
  });
});

describe("isOnboardingStepUnlocked - 'allow back, never allow jumping ahead'", () => {
  it("a company with no current step (NOT_STARTED/COMPLETED) unlocks nothing", () => {
    for (const target of ONBOARDING_STEPS) {
      expect(isOnboardingStepUnlocked(null, target)).toBe(false);
    }
  });

  it("the current step itself is unlocked - retrying/resubmitting the step you're on is never 'jumping ahead'", () => {
    expect(isOnboardingStepUnlocked("PIPELINE", "PIPELINE")).toBe(true);
  });

  it("every earlier step is unlocked - navigating back to review/edit a completed step is always allowed", () => {
    expect(isOnboardingStepUnlocked("REVIEW", "BUSINESS_PROFILE")).toBe(true);
    expect(isOnboardingStepUnlocked("META_CONNECTION", "CRM_BASICS")).toBe(true);
  });

  it("any later step is locked - a request naming a step past the company's own furthest reach is rejected", () => {
    expect(isOnboardingStepUnlocked("BUSINESS_PROFILE", "PIPELINE")).toBe(false);
    expect(isOnboardingStepUnlocked("BUSINESS_PROFILE", "REVIEW")).toBe(false);
  });
});

describe("canSubmitOnboardingStep - the full authorization check every wizard endpoint runs", () => {
  it("COMPLETED accepts nothing - every onboarding endpoint is closed once done", () => {
    for (const target of ONBOARDING_STEPS) {
      expect(canSubmitOnboardingStep("COMPLETED", null, target)).toBe(false);
      expect(canSubmitOnboardingStep("COMPLETED", "REVIEW", target)).toBe(false);
    }
  });

  it("NOT_STARTED accepts only the very first step - this is how a company bootstraps into IN_PROGRESS", () => {
    expect(canSubmitOnboardingStep("NOT_STARTED", null, FIRST_ONBOARDING_STEP)).toBe(true);
    for (const target of ONBOARDING_STEPS) {
      if (target === FIRST_ONBOARDING_STEP) continue;
      expect(canSubmitOnboardingStep("NOT_STARTED", null, target)).toBe(false);
    }
  });

  it("IN_PROGRESS delegates to isOnboardingStepUnlocked - current step and earlier are allowed, later is not", () => {
    expect(canSubmitOnboardingStep("IN_PROGRESS", "PIPELINE", "PIPELINE")).toBe(true);
    expect(canSubmitOnboardingStep("IN_PROGRESS", "PIPELINE", "BUSINESS_PROFILE")).toBe(true);
    expect(canSubmitOnboardingStep("IN_PROGRESS", "PIPELINE", "REVIEW")).toBe(false);
  });

  it("REVIEW (the completion step) is only submittable once the company's own resume pointer has already reached it", () => {
    expect(canSubmitOnboardingStep("IN_PROGRESS", "REVIEW", "REVIEW")).toBe(true);
    expect(canSubmitOnboardingStep("IN_PROGRESS", "META_CONNECTION", "REVIEW")).toBe(false);
  });
});

describe("ONBOARDING_LEAD_SOURCE_OPTIONS / isValidOnboardingLeadSourceSelection", () => {
  it("excludes the two system-set-only sources (meta_lead_ads, public_form)", () => {
    const keys = ONBOARDING_LEAD_SOURCE_OPTIONS.map((s) => s.key);
    expect(keys).not.toContain("meta_lead_ads");
    expect(keys).not.toContain("public_form");
    expect(keys).toContain("facebook");
    expect(keys).toContain("email");
  });

  it("accepts only arrays of known keys", () => {
    expect(isValidOnboardingLeadSourceSelection(["facebook", "email"])).toBe(true);
    expect(isValidOnboardingLeadSourceSelection([])).toBe(true);
    expect(isValidOnboardingLeadSourceSelection(["facebook", "not-a-real-source"])).toBe(false);
    expect(isValidOnboardingLeadSourceSelection("facebook")).toBe(false);
    expect(isValidOnboardingLeadSourceSelection(null)).toBe(false);
    expect(isValidOnboardingLeadSourceSelection(undefined)).toBe(false);
  });
});

describe("isMetaConnectionApplicable", () => {
  it("true only when facebook or instagram was selected", () => {
    expect(isMetaConnectionApplicable(["facebook"])).toBe(true);
    expect(isMetaConnectionApplicable(["instagram"])).toBe(true);
    expect(isMetaConnectionApplicable(["facebook", "whatsapp"])).toBe(true);
  });

  it("false when neither was selected, or the value is missing/invalid - never crashes on a bad value", () => {
    expect(isMetaConnectionApplicable(["whatsapp", "email"])).toBe(false);
    expect(isMetaConnectionApplicable([])).toBe(false);
    expect(isMetaConnectionApplicable(null)).toBe(false);
    expect(isMetaConnectionApplicable(undefined)).toBe(false);
    expect(isMetaConnectionApplicable("facebook")).toBe(false);
  });
});
