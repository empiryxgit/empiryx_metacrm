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
