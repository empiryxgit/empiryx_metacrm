// Pure-logic tests for the guided onboarding state model (Phase 2 of the
// "Individual User — Guided First-Time Onboarding" review request). No
// database involved - see src/security/onboardingState.test.ts for the
// real-Postgres repository-level coverage.

import { describe, expect, it } from "vitest";
import {
  ONBOARDING_STATUSES,
  ONBOARDING_STEPS,
  FIRST_ONBOARDING_STEP,
  isOnboardingStatus,
  isOnboardingStep,
  resolveOnboardingStatus,
  resolveOnboardingStep,
  isOnboardingStepUnlocked,
  nextOnboardingStep,
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
