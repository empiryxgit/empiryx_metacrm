// The guided first-time onboarding wizard's application layer - Individual
// users ONLY (see src/domain/onboarding.ts's own header comment for why:
// agency and agency-onboarded-client companies never reach IN_PROGRESS/
// NOT_STARTED at all, so every function here is a no-op risk for them only
// in theory - api/onboarding/handler.ts's new actions are the only callers,
// and every one of them derives companyId/userId from the authenticated
// session, never from the request body, so a company can never submit a
// wizard step on behalf of another tenant).
//
// Every mutating function below follows the same three-step shape:
//   1. Load this company's current onboarding state.
//   2. Authorize the specific step being submitted via
//      canSubmitOnboardingStep() - the single source of truth for "is this
//      step allowed right now" (no skipping ahead, no resubmitting after
//      COMPLETED).
//   3. Persist whatever this step collects, then advance the company's
//      resume pointer to the next step (setOnboardingStep already flips
//      NOT_STARTED -> IN_PROGRESS for free - see its own comment in
//      tenancy.ts - so there is no separate "bootstrap" call needed here).

import {
  getCompanyById,
  getOnboardingState,
  setOnboardingStep,
  completeOnboarding,
  updateCompanyProfile,
  updateOnboardingProfileFields,
  updateUser,
  type OnboardingState,
} from "../infrastructure/db/repositories/tenancy";
import { insertManualLead } from "../infrastructure/db/repositories";
import {
  canSubmitOnboardingStep,
  isMetaConnectionApplicable,
  isOnboardingStep,
  isValidOnboardingLeadSourceSelection,
  nextOnboardingStep,
  ONBOARDING_LEAD_SOURCE_OPTIONS,
  type OnboardingStatus,
  type OnboardingStep,
} from "../domain/onboarding";
import { getInitialStageKey, resolveEffectiveIndustryTemplate } from "../domain/industryTemplates";

export class OnboardingWizardError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
  }
}

async function requireOnboardingState(companyId: string): Promise<OnboardingState> {
  const state = await getOnboardingState(companyId);
  if (!state) throw new OnboardingWizardError("Company not found.", 404);
  return state;
}

/** The one place every step-submission function below checks authorization
 * before touching the database - see canSubmitOnboardingStep's own comment
 * for exactly which (status, currentStep, targetStep) combinations pass. */
function assertSubmittable(state: OnboardingState, targetStep: OnboardingStep) {
  if (!canSubmitOnboardingStep(state.status, state.step, targetStep)) {
    throw new OnboardingWizardError(
      state.status === "COMPLETED"
        ? "Onboarding is already complete - this can be changed from Settings instead."
        : "This step isn't available yet - please complete the earlier steps first.",
      409,
    );
  }
}

/** Moves the company's resume pointer past `justSubmittedStep`. When that
 * step is already the last one (REVIEW), there is nothing further to
 * advance to - the resume pointer simply stays on REVIEW until
 * completeWizard() finishes the whole thing. */
async function advanceOnboardingStep(companyId: string, justSubmittedStep: OnboardingStep): Promise<void> {
  const next = nextOnboardingStep(justSubmittedStep) ?? justSubmittedStep;
  await setOnboardingStep(companyId, next);
}

// ---------------------------------------------------------------------------
// Status - read-only context for resuming, prefilling, and the Review step.
// ---------------------------------------------------------------------------

export interface OnboardingContext {
  status: OnboardingStatus;
  step: OnboardingStep | null;
  completedAt: Date | null;
  company: {
    name: string;
    industry: string | null;
    website: string | null;
    industryTemplate: string;
    leadTerminology: string;
    selectedLeadSources: string[] | null;
  };
  isMetaConnectionApplicable: boolean;
}

export async function getOnboardingContext(companyId: string): Promise<OnboardingContext | null> {
  const [state, company] = await Promise.all([getOnboardingState(companyId), getCompanyById(companyId)]);
  if (!state || !company) return null;

  const selectedLeadSources = isValidOnboardingLeadSourceSelection(company.selectedLeadSources)
    ? company.selectedLeadSources
    : null;

  return {
    status: state.status,
    step: state.step,
    completedAt: state.completedAt,
    company: {
      name: company.name,
      industry: company.industry,
      website: company.website,
      industryTemplate: company.industryTemplate,
      leadTerminology: company.leadTerminology,
      selectedLeadSources,
    },
    isMetaConnectionApplicable: isMetaConnectionApplicable(selectedLeadSources),
  };
}

// ---------------------------------------------------------------------------
// Step 1 - Business Profile (PHASE 6)
// ---------------------------------------------------------------------------

export interface SaveBusinessProfileInput {
  businessName?: string;
  // Free-text business description (companies.industry) - "e.g. Real
  // Estate Broker" - unrelated to the structured industryTemplate key,
  // which this wizard deliberately never asks the user to pick (see PHASE
  // 8's own "do not require the user to understand pipeline configuration"
  // rule - a fresh signup keeps the "general" template from registration
  // unless they later visit Settings -> Business Configuration).
  industry?: string;
  website?: string;
  phoneNumber?: string;
}

export async function saveBusinessProfile(
  companyId: string,
  userId: string,
  input: SaveBusinessProfileInput,
): Promise<OnboardingContext> {
  const state = await requireOnboardingState(companyId);
  assertSubmittable(state, "BUSINESS_PROFILE");

  const companyPatch: { name?: string; industry?: string } = {};
  if (typeof input.businessName === "string") {
    const trimmed = input.businessName.trim();
    if (!trimmed) throw new OnboardingWizardError("Business name cannot be empty.", 400);
    companyPatch.name = trimmed;
  }
  if (typeof input.industry === "string") {
    companyPatch.industry = input.industry.trim();
  }
  if (Object.keys(companyPatch).length > 0) {
    await updateCompanyProfile(companyId, companyPatch);
  }

  if (typeof input.website === "string") {
    await updateOnboardingProfileFields(companyId, { website: input.website.trim() || undefined });
  }

  if (typeof input.phoneNumber === "string" && input.phoneNumber.trim()) {
    await updateUser(companyId, userId, { phoneNumber: input.phoneNumber.trim() });
  }

  await advanceOnboardingStep(companyId, "BUSINESS_PROFILE");
  return (await getOnboardingContext(companyId))!;
}

// ---------------------------------------------------------------------------
// Step 2 - CRM Basics (PHASE 7)
// ---------------------------------------------------------------------------

export interface SaveCrmBasicsInput {
  // "What do you call your leads?" - e.g. "Lead" / "Prospect" / "Enquiry" /
  // "Customer". Deliberately scoped to only the NEW surfaces this project
  // builds (this wizard's own later screens, dashboard empty-states, the
  // setup checklist) - see companies.leadTerminology's own schema.ts
  // comment for why the rest of the existing app is NOT retrofitted to
  // honor it. Falls back to the column's own "Lead" default when omitted.
  leadTerminology?: string;
}

const MAX_LEAD_TERMINOLOGY_LENGTH = 40;

export async function saveCrmBasics(companyId: string, input: SaveCrmBasicsInput): Promise<OnboardingContext> {
  const state = await requireOnboardingState(companyId);
  assertSubmittable(state, "CRM_BASICS");

  if (typeof input.leadTerminology === "string" && input.leadTerminology.trim()) {
    const trimmed = input.leadTerminology.trim().slice(0, MAX_LEAD_TERMINOLOGY_LENGTH);
    await updateOnboardingProfileFields(companyId, { leadTerminology: trimmed });
  }

  await advanceOnboardingStep(companyId, "CRM_BASICS");
  return (await getOnboardingContext(companyId))!;
}

// ---------------------------------------------------------------------------
// Step 3 - Pipeline (PHASE 8)
// ---------------------------------------------------------------------------
//
// No pipeline builder lives inside the wizard. "Use Recommended Pipeline"
// and "Customize Pipeline" both simply advance the wizard - the company's
// industryTemplate (defaulted to "general" at registration, itself a
// working pipeline) already applies either way. Real customization happens
// in Settings -> Business Configuration (updateBusinessConfiguration),
// whenever the user gets there - never blocking this wizard on it.

export type PipelineChoice = "recommended" | "customize";

export async function savePipelineChoice(companyId: string, choice: unknown): Promise<OnboardingContext> {
  const state = await requireOnboardingState(companyId);
  assertSubmittable(state, "PIPELINE");

  if (choice !== "recommended" && choice !== "customize") {
    throw new OnboardingWizardError('choice must be "recommended" or "customize".', 400);
  }

  await advanceOnboardingStep(companyId, "PIPELINE");
  return (await getOnboardingContext(companyId))!;
}

// ---------------------------------------------------------------------------
// Step 4 - Lead Source (PHASE 9)
// ---------------------------------------------------------------------------

export async function saveLeadSources(companyId: string, selectedLeadSources: unknown): Promise<OnboardingContext> {
  const state = await requireOnboardingState(companyId);
  assertSubmittable(state, "LEAD_SOURCE");

  if (!isValidOnboardingLeadSourceSelection(selectedLeadSources) || selectedLeadSources.length === 0) {
    throw new OnboardingWizardError(
      `Select at least one lead source (${ONBOARDING_LEAD_SOURCE_OPTIONS.map((s) => s.key).join(", ")}), or use Skip for Now.`,
      400,
    );
  }

  await updateOnboardingProfileFields(companyId, { selectedLeadSources });
  await advanceOnboardingStep(companyId, "LEAD_SOURCE");
  return (await getOnboardingContext(companyId))!;
}

// ---------------------------------------------------------------------------
// Generic skip - "I'll Set This Up Later" / "Skip for Now" (PHASE 9/10, and
// any other step the frontend chooses to offer a skip control for). REVIEW
// is deliberately excluded - there is nothing to "skip" on the last step,
// only Continue (completeWizard).
// ---------------------------------------------------------------------------

export async function skipCurrentStep(companyId: string, step: unknown): Promise<OnboardingContext> {
  if (!isOnboardingStep(step) || step === "REVIEW") {
    throw new OnboardingWizardError("This step cannot be skipped.", 400);
  }
  const state = await requireOnboardingState(companyId);
  assertSubmittable(state, step);

  await advanceOnboardingStep(companyId, step);
  return (await getOnboardingContext(companyId))!;
}

// ---------------------------------------------------------------------------
// Step 6 - Review / Setup Complete (PHASE 12/13)
// ---------------------------------------------------------------------------
//
// Reuses the SAME completeOnboarding() every other onboarding path
// (agency registration, agency-onboarded clients, the legacy wizard) has
// always called - this wizard's completion means exactly the same thing
// theirs does: onboardingCompletedAt set, onboardingStatus COMPLETED,
// onboardingStep cleared to null. canSubmitOnboardingStep only allows
// targetStep REVIEW once the company's resume pointer has ALREADY reached
// REVIEW (isOnboardingStepUnlocked requires currentStep's index >= REVIEW's,
// and REVIEW is the last step) - so this can never fire before every
// earlier step has been submitted or explicitly skipped.

export async function completeWizard(companyId: string): Promise<OnboardingContext> {
  const state = await requireOnboardingState(companyId);
  assertSubmittable(state, "REVIEW");

  await completeOnboarding(companyId);
  return (await getOnboardingContext(companyId))!;
}

// ---------------------------------------------------------------------------
// First Lead (PHASE 11) - a lightweight shortcut offered on the Review /
// Setup Complete screen, NOT an OnboardingStep of its own (skipping it never
// blocks completeWizard). Calls insertManualLead directly rather than
// routing through the full dynamic Forms system (insertFormLead) - this is
// intentionally the simplest possible "add one customer" path, matching the
// small fixed field set (Name, Phone, Email, Source, Notes) the wizard
// screen itself offers.
// ---------------------------------------------------------------------------

export interface AddFirstLeadInput {
  fullName: string;
  phoneNumber?: string;
  email?: string;
  source?: string;
  notes?: string;
}

export async function addFirstLead(companyId: string, input: AddFirstLeadInput) {
  const fullName = input.fullName?.trim();
  if (!fullName) {
    throw new OnboardingWizardError("Name is required.", 400);
  }

  const company = await getCompanyById(companyId);
  if (!company) {
    throw new OnboardingWizardError("Company not found.", 404);
  }

  const template = resolveEffectiveIndustryTemplate(company.industryTemplate, company.customTemplateConfig);
  const source = typeof input.source === "string" && input.source.trim() ? input.source.trim() : "manual";

  return insertManualLead({
    companyId,
    fullName,
    phoneNumber: input.phoneNumber?.trim() || undefined,
    email: input.email?.trim() || undefined,
    source,
    pipelineStage: getInitialStageKey(template),
    notes: input.notes?.trim() || undefined,
    customFields: {},
  });
}
