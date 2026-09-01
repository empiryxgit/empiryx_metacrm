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

import { LEAD_SOURCES } from "./industryTemplates";

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

/**
 * The actual authorization check every onboarding step-submission endpoint
 * (api/onboarding/handler.ts) runs before accepting a POST for `targetStep`
 * - the full-context counterpart to isOnboardingStepUnlocked above, which
 * only covers the IN_PROGRESS case (used for read-only UI decisions like
 * "which steps in the progress bar are clickable"). This one additionally
 * covers the two states that function deliberately treats as "unlocks
 * nothing":
 *
 * - NOT_STARTED: the wizard has never been touched yet, so there is no
 *   stored current step - but submitting the very FIRST step is exactly
 *   how a company bootstraps from NOT_STARTED into IN_PROGRESS (see
 *   saveBusinessProfile in src/application/onboardingWizard.ts). Nothing
 *   past step 1 is reachable from here.
 * - COMPLETED: the wizard is done. Every onboarding endpoint is closed -
 *   changing any of this data afterward goes through Settings, never
 *   through re-submitting a "completed" wizard step.
 */
export function canSubmitOnboardingStep(status: OnboardingStatus, currentStep: OnboardingStep | null, targetStep: OnboardingStep): boolean {
  if (status === "COMPLETED") return false;
  if (status === "NOT_STARTED") return targetStep === FIRST_ONBOARDING_STEP;
  return isOnboardingStepUnlocked(currentStep, targetStep);
}

// ---------------------------------------------------------------------------
// Lead Source step ("How do you get your leads?") - PHASE 9
// ---------------------------------------------------------------------------
//
// Deliberately a SUBSET of the full LEAD_SOURCES catalog
// (src/domain/industryTemplates.ts), not a separate list of its own values -
// this step is asking "which of the channels this CRM already understands
// do you use," never inventing a parallel vocabulary. Excludes the two keys
// LEAD_SOURCES itself documents as system-set-only (meta_lead_ads,
// public_form - never a manual/user choice anywhere in the app) for the
// same reason MANUAL_LEAD_SOURCE_KEYS excludes them from the Add Customer
// form's own Source picker.
const ONBOARDING_LEAD_SOURCE_KEYS = ["facebook", "instagram", "website", "whatsapp", "phone", "email", "manual", "other"];

export const ONBOARDING_LEAD_SOURCE_OPTIONS = LEAD_SOURCES.filter((s) => ONBOARDING_LEAD_SOURCE_KEYS.includes(s.key));

export function isValidOnboardingLeadSourceSelection(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" && ONBOARDING_LEAD_SOURCE_KEYS.includes(v));
}

/**
 * "If the user selected Facebook / Instagram, show [the Meta Connection
 * step]." The one place this decision is made - both the wizard UI (should
 * it render/link to this step at all) and the Review step's summary
 * ("optional items skipped") call this rather than re-deriving the rule
 * themselves. An unrecognized/missing selectedLeadSources value (the step
 * was skipped entirely, or the company predates this column) resolves to
 * "not applicable," never a crash - same safe-default posture as every
 * other resolve function in this file.
 */
export function isMetaConnectionApplicable(selectedLeadSources: unknown): boolean {
  if (!isValidOnboardingLeadSourceSelection(selectedLeadSources)) return false;
  return selectedLeadSources.includes("facebook") || selectedLeadSources.includes("instagram");
}
