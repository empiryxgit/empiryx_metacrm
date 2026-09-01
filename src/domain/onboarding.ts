// The guided first-time onboarding wizard's state model - Individual users
// ONLY (see the review request's own "This phase is ONLY for INDIVIDUAL
// USERS... Do NOT implement the Agency onboarding/dashboard in this phase").
// Agency and agency-onboarded-client companies are entirely unaffected by
// anything in this file: they keep completing onboarding immediately at
// creation, exactly as before this feature existed - see
// src/application/auth.ts's registerCompanyAndOwner and
// src/application/agencyOnboarding.ts's completeAgencyOnboarding.
//
// Same union-type-plus-array-plus-resolve-with-safe-default convention as
// src/domain/accountType.ts and src/domain/industryTemplates.ts's
// IndustryKey - never branch on a raw companies.onboardingStatus/
// onboardingStep string anywhere outside resolveOnboardingStatus()/
// resolveOnboardingStep() below, so a hand-edited or since-invalidated row
// can never crash a caller, only fall back to a safe default.

export type OnboardingStatus = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";

export const ONBOARDING_STATUSES: OnboardingStatus[] = ["NOT_STARTED", "IN_PROGRESS", "COMPLETED"];

export function isOnboardingStatus(value: unknown): value is OnboardingStatus {
  return typeof value === "string" && (ONBOARDING_STATUSES as string[]).includes(value);
}

// Falls back to "COMPLETED" for anything unrecognized - the same posture as
// companies.onboardingStatus's own column default (see schema.ts's comment
// on that column for why "completed" rather than "not started" is the safe
// default): a row this function can't make sense of should never trap its
// company behind a wizard it has no way to know about.
export function resolveOnboardingStatus(value: unknown): OnboardingStatus {
  return isOnboardingStatus(value) ? value : "COMPLETED";
}

// Fixed order = the exact six steps named in the "TARGET EXPERIENCE"
// diagram (Business Profile -> CRM Basics -> Pipeline -> Lead Source ->
// Meta Connection -> Review). The Welcome screen and the post-completion
// "Setup Complete" screen are not steps in this list - they are the
// NOT_STARTED and COMPLETED statuses respectively, not resumable step
// positions of their own.
export type OnboardingStep = "BUSINESS_PROFILE" | "CRM_BASICS" | "PIPELINE" | "LEAD_SOURCE" | "META_CONNECTION" | "REVIEW";

export const ONBOARDING_STEPS: OnboardingStep[] = [
  "BUSINESS_PROFILE",
  "CRM_BASICS",
  "PIPELINE",
  "LEAD_SOURCE",
  "META_CONNECTION",
  "REVIEW",
];

export const FIRST_ONBOARDING_STEP: OnboardingStep = ONBOARDING_STEPS[0]!; // ONBOARDING_STEPS is a non-empty literal array

export function isOnboardingStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as string[]).includes(value);
}

// Unlike resolveOnboardingStatus, this one can genuinely have no safe
// non-null fallback - a company that is NOT_STARTED or COMPLETED has no
// "current step" at all, and forcing one would misrepresent real state to
// a caller. Returns null for anything unrecognized (including undefined/
// null itself), same as the column being genuinely empty.
export function resolveOnboardingStep(value: unknown): OnboardingStep | null {
  return isOnboardingStep(value) ? value : null;
}

function stepIndex(step: OnboardingStep): number {
  return ONBOARDING_STEPS.indexOf(step);
}

/**
 * "Allow navigation back to completed steps. Do not allow jumping ahead
 * when required information has not been completed." - the one rule every
 * step-changing onboarding endpoint must enforce before accepting a
 * request that names which step it's for. `currentStep` is the company's
 * own stored resume point (its FURTHEST reached step); `targetStep` is
 * whichever step the caller is trying to view or submit.
 *
 * Deliberately allows landing exactly ON the stored currentStep too (not
 * just strictly-earlier ones) - resubmitting the step you're already on
 * (e.g. retrying after a failed save - see PHASE 21's error-handling
 * requirement) must never be treated as "jumping ahead."
 *
 * A null currentStep (company is NOT_STARTED or COMPLETED, not
 * IN_PROGRESS) unlocks nothing - there is no wizard in progress to
 * navigate within.
 */
export function isOnboardingStepUnlocked(currentStep: OnboardingStep | null, targetStep: OnboardingStep): boolean {
  if (currentStep === null) return false;
  return stepIndex(targetStep) <= stepIndex(currentStep);
}

/** The step after `step`, or null when `step` is already the last one
 * (REVIEW) - a null result means "there is nothing left but Setup
 * Complete," never "stay on this step." */
export function nextOnboardingStep(step: OnboardingStep): OnboardingStep | null {
  const idx = stepIndex(step);
  return idx >= 0 && idx < ONBOARDING_STEPS.length - 1 ? ONBOARDING_STEPS[idx + 1]! : null;
}
