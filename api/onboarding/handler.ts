// Combines the two onboarding steps (company profile + complete) into ONE
// Vercel Function - see api/auth/handler.ts for why. URLs unchanged:
// /api/onboarding/company, /api/onboarding/complete - vercel.json rewrites
// them here with ?action= injected.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../src/infrastructure/auth/context";
import {
  completeOnboarding,
  getCompanyById,
  updateBusinessConfiguration,
  updateCompanyProfile,
} from "../../src/infrastructure/db/repositories/tenancy";
import { PERMISSIONS } from "../../src/domain/permissions";
import {
  INDUSTRY_KEYS,
  SELECTABLE_BUILT_IN_TEMPLATES,
  resolveEffectiveIndustryTemplate,
  validateCustomTemplateConfig,
  type IndustryKey,
} from "../../src/domain/industryTemplates";
import { listForms, provisionDefaultForms } from "../../src/infrastructure/db/repositories/forms";
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
} from "../../src/application/onboardingWizard";
import { sendOnboardingWelcomeMessage } from "../../src/application/metaSync/rutaAiAssistant";

function getAction(req: VercelRequest): string {
  const segments = req.query.action;
  if (Array.isArray(segments)) return segments[0] ?? "";
  return typeof segments === "string" ? segments : "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  switch (getAction(req)) {
    case "company":
      return handleCompany(req, res);
    case "complete":
      return handleComplete(req, res);
    case "business-config":
      return handleBusinessConfig(req, res);
    // --- Guided first-time onboarding wizard (Individual users only - see
    // src/domain/onboarding.ts's own header comment) ----------------------
    case "status":
      return handleWizardStatus(req, res);
    case "business-profile":
      return handleWizardStep(req, res, (companyId, userId, body) => saveBusinessProfile(companyId, userId, body));
    case "crm-basics":
      return handleWizardStep(req, res, (companyId, _userId, body) => saveCrmBasics(companyId, body));
    case "pipeline":
      return handleWizardStep(req, res, (companyId, _userId, body) => savePipelineChoice(companyId, body?.choice));
    case "lead-source":
      return handleWizardStep(req, res, (companyId, _userId, body) => saveLeadSources(companyId, body?.selectedLeadSources));
    case "skip":
      return handleWizardStep(req, res, (companyId, _userId, body) => skipCurrentStep(companyId, body?.step));
    case "wizard-complete":
      return handleWizardStep(req, res, (companyId, userId) => completeWizard(companyId, userId));
    case "first-lead":
      return handleFirstLead(req, res);
    default:
      res.status(404).json({ error: "Not found" });
  }
}

// Step 2 of onboarding: collects company profile details. Requires
// company.manage, which the auto-created Owner role always holds, so the
// user who just registered can always complete this step.
async function handleCompany(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  const { industry, companySize, timezone } = (req.body ?? {}) as {
    industry?: string;
    companySize?: string;
    timezone?: string;
  };

  await updateCompanyProfile(auth.companyId, { industry, companySize, timezone });
  res.status(200).json({ updated: true });
}

// Final onboarding step. Deliberately separate from creating the first
// campaign - the frontend wizard calls POST /api/campaigns first (see
// public/onboarding.html), then this, so "onboarding complete" always means
// "this company has at least reached the campaign step," which is what
// /api/auth/me's `company.onboardingCompleted` flag gates navigation on.
async function handleComplete(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  // Safety net for any company that predates the Forms module (registration
  // itself already provisions default forms for every new signup - see
  // registerCompanyAndOwner in src/application/auth.ts) - never leaves an
  // existing tenant without a working "Add Customer" form.
  try {
    const existing = await listForms(auth.companyId, "internal");
    if (existing.length === 0) {
      const company = await getCompanyById(auth.companyId);
      if (company) {
        await provisionDefaultForms(auth.companyId, resolveEffectiveIndustryTemplate(company.industryTemplate, company.customTemplateConfig));
      }
    }
  } catch (err) {
    console.error("[onboarding/complete] Failed to backfill default forms:", err);
  }

  await completeOnboarding(auth.companyId);
  // Legacy/direct-API completion path - covers a caller that finishes
  // onboarding via this endpoint directly instead of the guided wizard's
  // own /api/onboarding/wizard/complete (see completeWizard in
  // onboardingWizard.ts for that path's identical call). Best-effort, never
  // throws - see sendOnboardingWelcomeMessage's own doc comment.
  await sendOnboardingWelcomeMessage(auth.companyId, auth.userId);
  res.status(200).json({ completed: true });
}

// Settings -> Business Configuration -> Industry/Template. Gated on
// company.manage (same gate as handleCompany/handleComplete above) since
// this changes a foundational, company-wide setting, not a per-user
// preference. GET returns enough for the Settings UI to render its picker
// and (if applicable) prefill the custom-template builder; PUT/POST
// persists a choice.
//
// Deliberately supports saving a customTemplateConfig draft WITHOUT
// switching industryTemplate to "custom" (and vice versa - switching to a
// built-in template without touching a saved custom draft) - see
// updateBusinessConfiguration's own doc comment for why the two are stored
// independently. The only cross-field rule enforced here is: you cannot
// SWITCH to "custom" unless a valid config either already exists for this
// company or is being provided in this same request.
async function handleBusinessConfig(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
    if (!auth) return;

    const company = await getCompanyById(auth.companyId);
    if (!company) {
      res.status(404).json({ error: "Company not found" });
      return;
    }

    const effectiveTemplate = resolveEffectiveIndustryTemplate(company.industryTemplate, company.customTemplateConfig);
    res.status(200).json({
      current: {
        industryTemplate: company.industryTemplate,
        customTemplateConfig: company.customTemplateConfig ?? null,
      },
      effectiveTemplate,
      builtInTemplates: SELECTABLE_BUILT_IN_TEMPLATES,
      industryKeys: INDUSTRY_KEYS,
    });
    return;
  }

  if (req.method === "PUT" || req.method === "POST") {
    const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
    if (!auth) return;

    const body = (req.body ?? {}) as { industryTemplate?: string; customTemplateConfig?: unknown };
    const { industryTemplate } = body;

    if (typeof industryTemplate !== "string" || !INDUSTRY_KEYS.includes(industryTemplate as IndustryKey)) {
      res.status(400).json({ error: `industryTemplate must be one of: ${INDUSTRY_KEYS.join(", ")}` });
      return;
    }

    const providesCustomConfig = "customTemplateConfig" in body && body.customTemplateConfig != null;

    // Validate any provided customTemplateConfig regardless of the chosen
    // industryTemplate - a company may be previewing/switching to a
    // built-in template while still editing its custom draft, and that
    // draft should be rejected up front (not silently saved broken) even
    // though it isn't the active template right now.
    let validatedConfig: unknown = undefined;
    if (providesCustomConfig) {
      const result = validateCustomTemplateConfig(body.customTemplateConfig);
      if (!result.ok) {
        res.status(400).json({ error: result.error });
        return;
      }
      validatedConfig = result.config;
    }

    if (industryTemplate === "custom") {
      // Switching TO custom requires a real config: either one supplied
      // fresh in this same request, or one already saved from a previous
      // request. Prevents ever activating "custom" with nothing behind it.
      if (!providesCustomConfig) {
        const company = await getCompanyById(auth.companyId);
        const existingValid = company?.customTemplateConfig != null && validateCustomTemplateConfig(company.customTemplateConfig).ok;
        if (!existingValid) {
          res.status(400).json({ error: "Selecting \"custom\" requires a valid customTemplateConfig - none is saved yet." });
          return;
        }
      }
    }

    await updateBusinessConfiguration(auth.companyId, {
      industryTemplate,
      ...(providesCustomConfig ? { customTemplateConfig: validatedConfig } : {}),
    });

    const company = await getCompanyById(auth.companyId);
    const effectiveTemplate = company
      ? resolveEffectiveIndustryTemplate(company.industryTemplate, company.customTemplateConfig)
      : null;
    res.status(200).json({ updated: true, effectiveTemplate });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

// ---------------------------------------------------------------------------
// Guided first-time onboarding wizard (Individual users only) - PHASE 6-13.
// Every action below is gated on COMPANY_MANAGE, same permission the legacy
// handleCompany/handleComplete above use - the auto-created Owner role every
// individual registration gets always holds it, and this data (business
// profile, CRM basics, pipeline choice, lead sources) is exactly the kind of
// company-wide setting COMPANY_MANAGE already governs elsewhere in this
// file. companyId/userId are ALWAYS taken from the authenticated session
// (auth.companyId / auth.userId), never from the request body - see
// src/application/onboardingWizard.ts's header comment for why that's the
// one non-negotiable rule every function it exports depends on its callers
// upholding.
// ---------------------------------------------------------------------------

/** GET /api/onboarding/wizard/status - full onboarding context for
 * resuming/prefilling the wizard UI and rendering the Review step's
 * summary. Read-only - safe to call on every wizard page load. */
async function handleWizardStatus(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  const context = await getOnboardingContext(auth.companyId);
  if (!context) {
    res.status(404).json({ error: "Company not found" });
    return;
  }
  res.status(200).json(context);
}

/** Shared POST handler for every step-submission action (business-profile,
 * crm-basics, pipeline, lead-source, skip, wizard-complete) - each just
 * supplies the one application-layer function that knows how to validate
 * and persist its own step's body. Any OnboardingWizardError thrown by that
 * function (wrong step, already completed, bad input) is translated into
 * the exact HTTP status it carries; anything else is a genuine 500. */
async function handleWizardStep(
  req: VercelRequest,
  res: VercelResponse,
  run: (companyId: string, userId: string, body: Record<string, unknown>) => Promise<unknown>,
) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.COMPANY_MANAGE);
  if (!auth) return;

  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const context = await run(auth.companyId, auth.userId, body);
    res.status(200).json(context);
  } catch (err) {
    if (err instanceof OnboardingWizardError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[onboarding/wizard] Step submission failed:", err);
    res.status(500).json({ error: "Something went wrong saving this step. Your previous setup is safe." });
  }
}

/** POST /api/onboarding/wizard/first-lead - the Review screen's optional
 * "add your first lead" shortcut. Gated on LEADS_MANAGE (the same
 * permission the existing Add Customer flow requires - see
 * PERMISSIONS.LEADS_MANAGE's own comment) rather than COMPANY_MANAGE, since
 * creating a lead is what this action actually does; the auto-created Owner
 * role holds both, so this is invisible to a fresh individual signup. */
async function handleFirstLead(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.LEADS_MANAGE);
  if (!auth) return;

  try {
    const body = (req.body ?? {}) as {
      fullName?: string;
      phoneNumber?: string;
      email?: string;
      source?: string;
      notes?: string;
    };
    const lead = await addFirstLead(auth.companyId, {
      fullName: body.fullName ?? "",
      phoneNumber: body.phoneNumber,
      email: body.email,
      source: body.source,
      notes: body.notes,
    });
    res.status(201).json({ lead });
  } catch (err) {
    if (err instanceof OnboardingWizardError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[onboarding/wizard] First-lead creation failed:", err);
    res.status(500).json({ error: "Something went wrong adding this lead." });
  }
}
