// Form Branch Configuration - the ONE place that (a) validates a form's
// Branch Configuration when an admin saves it, and (b) turns that
// configuration into an actual branchId when a submission comes in. Both the
// internal (Add Customer) and public (anonymous) submit paths in
// api/forms/handler.ts call resolveFormSubmissionBranch, so a public visitor
// and a salesperson get identical, backend-enforced routing for the same
// form - "For public forms, branch routing must be validated on the
// backend" is satisfied by construction: there is no other path to a
// branchId for a form submission.

import { assertBranchAccessible, canAccessBranch, resolveBranchAccess, type BranchAssertion } from "./branchAccess";
import type { AuthContext } from "../infrastructure/auth/context";
import { getBranchById, listBranches } from "../infrastructure/db/repositories/branches";

export type BranchMode = "specific" | "all" | "field";

export const BRANCH_MODES: BranchMode[] = ["specific", "all", "field"];

export interface FormBranchConfig {
  branchMode: string;
  branchId: string | null;
  branchFieldKey: string | null;
  branchFieldMap: Record<string, string> | null;
}

// ---------------------------------------------------------------------
// Save-time validation - called from api/forms/handler.ts handleCreate and
// handleOne (PUT). Never trusts the client's branchMode/branchId/
// branchFieldKey/branchFieldMap directly:
//   - "specific": branchId goes through assertBranchAccessible (tenant
//     isolation + the SAVING user's own branch access - "Do not allow users
//     to select branches they don't have permission to manage").
//   - "field": branchFieldKey must name a select/radio field that actually
//     exists on this form (custom, not system - a system field's choices
//     are the company's live data, not a fixed option list to map from);
//     EVERY value in branchFieldMap is resolved through
//     assertBranchAccessible the same way, so a form can never be
//     configured to route into a branch its builder isn't permitted to
//     manage, and never into another tenant's branch.
//   - "all": branchId/branchFieldKey/branchFieldMap are cleared - "all"
//     never carries stale routing data from a previous mode.
// ---------------------------------------------------------------------

export interface ValidatedBranchConfig {
  branchMode: BranchMode;
  branchId: string | null;
  branchFieldKey: string | null;
  branchFieldMap: Record<string, string>;
}

export type BranchConfigValidation = { ok: true; config: ValidatedBranchConfig } | { ok: false; status: number; error: string };

export interface RawBranchConfigInput {
  branchMode?: unknown;
  branchId?: unknown;
  branchFieldKey?: unknown;
  branchFieldMap?: unknown;
}

// Loose on purpose - accepts either a freshly-validated FormFieldInput[] or
// a form_fields row read straight back out of the DB (whose columns are
// untyped text at the DB layer), same convention as
// src/domain/formValidation.ts's ValidatableField.
export interface BranchFieldCandidate {
  key: string;
  fieldType: string;
  mappingType: string;
}

export async function validateBranchConfig(
  auth: AuthContext,
  raw: RawBranchConfigInput,
  fields: BranchFieldCandidate[],
): Promise<BranchConfigValidation> {
  const branchMode: BranchMode = BRANCH_MODES.includes(raw.branchMode as BranchMode) ? (raw.branchMode as BranchMode) : "specific";

  if (branchMode === "all") {
    return { ok: true, config: { branchMode: "all", branchId: null, branchFieldKey: null, branchFieldMap: {} } };
  }

  if (branchMode === "specific") {
    const branchAssertion = await assertBranchAccessible(auth, raw.branchId);
    if (!branchAssertion.ok) return branchAssertion;
    return { ok: true, config: { branchMode: "specific", branchId: branchAssertion.branchId, branchFieldKey: null, branchFieldMap: {} } };
  }

  // branchMode === "field"
  const branchFieldKey = typeof raw.branchFieldKey === "string" ? raw.branchFieldKey.trim() : "";
  if (!branchFieldKey) {
    return { ok: false, status: 400, error: "A branch-determining field is required for \"Determine branch from form field\"." };
  }
  const target = fields.find((f) => f.key === branchFieldKey);
  if (!target) {
    return { ok: false, status: 400, error: `The branch field "${branchFieldKey}" is not on this form.` };
  }
  if (target.mappingType !== "custom" || !["select", "radio"].includes(target.fieldType)) {
    return { ok: false, status: 400, error: "The branch-determining field must be a Dropdown or Radio field with fixed options." };
  }

  const mapRaw = (raw.branchFieldMap && typeof raw.branchFieldMap === "object" ? raw.branchFieldMap : {}) as Record<string, unknown>;
  const branchFieldMap: Record<string, string> = {};
  // One query for every mapped option, same tenant-isolation + permission
  // checks assertBranchAccessible does (404 for a branchId outside this
  // company, 403 for one inside it the saving user can't manage) - but
  // batched into a single listBranches() call up front instead of a
  // separate getBranchById round-trip per option (a "Which location..."
  // field with, say, 5 branch options previously meant 5 sequential DB
  // calls just to save the form).
  const companyBranchIds = new Set((await listBranches(auth.companyId)).map((b) => b.id));
  const access = resolveBranchAccess(auth);
  for (const [optionValue, branchIdValue] of Object.entries(mapRaw)) {
    if (typeof branchIdValue !== "string" || !branchIdValue) continue; // an unmapped option is allowed - falls back to company-wide at submit time
    if (!companyBranchIds.has(branchIdValue)) {
      return { ok: false, status: 404, error: "Branch not found." };
    }
    if (!canAccessBranch(access, branchIdValue)) {
      return { ok: false, status: 403, error: "You do not have access to this branch." };
    }
    branchFieldMap[optionValue] = branchIdValue;
  }

  return { ok: true, config: { branchMode: "field", branchId: null, branchFieldKey, branchFieldMap } };
}

// ---------------------------------------------------------------------
// Submit-time resolution - called from api/forms/handler.ts
// handleInternalSubmit and handlePublicSubmit.
// ---------------------------------------------------------------------

export type FormBranchResolution = { ok: true; branchId: string | null } | { ok: false; status: number; error: string };

/**
 * `auth` is present for internal submissions only (undefined/null for a
 * public, anonymous submission) - when present, every resolved branchId is
 * re-checked against the submitting user's own branch access via
 * assertBranchAccessible, so a restricted salesperson can never land a lead
 * in a branch outside their assignment, however the branch was resolved
 * (the form's own config, or the field-driven map). `override` is the
 * existing multi-branch Add Customer picker value (internal only, see
 * public/pipeline.html) - takes precedence over the form's own Branch
 * Configuration entirely when explicitly provided, same contract as before
 * this feature existed.
 *
 * Never blocks a submission over a branch-configuration problem (a
 * deleted/archived branch, an unanswered or unmapped field) - always fails
 * open to company-wide (branchId: null), consistent with every other
 * "never block ingestion" contract in this codebase (see
 * handleDefaultInternal above). The one case that DOES reject the
 * submission is an internal user's resolved branch failing their own access
 * check - that is a genuine authorization boundary, not a data gap.
 */
export async function resolveFormSubmissionBranch(
  companyId: string,
  form: FormBranchConfig,
  values: Record<string, unknown>,
  auth?: AuthContext | null,
  override?: string | null,
): Promise<FormBranchResolution> {
  if (auth && override !== undefined) {
    return assertBranchAccessible(auth, override);
  }

  async function checkAccessible(branchId: string): Promise<FormBranchResolution> {
    const branch = await getBranchById(companyId, branchId);
    if (!branch || branch.status !== "active") return { ok: true, branchId: null }; // fail open - never block on a stale config
    if (auth) {
      const assertion: BranchAssertion = await assertBranchAccessible(auth, branchId);
      if (!assertion.ok) return assertion; // genuine authorization boundary - not fail-open
    }
    return { ok: true, branchId };
  }

  if (form.branchMode === "specific") {
    if (!form.branchId) return { ok: true, branchId: null };
    return checkAccessible(form.branchId);
  }

  if (form.branchMode === "field") {
    if (!form.branchFieldKey) return { ok: true, branchId: null };
    const raw = values[form.branchFieldKey];
    if (raw === undefined || raw === null || raw === "") return { ok: true, branchId: null };
    const mapped = (form.branchFieldMap ?? {})[String(raw)];
    if (!mapped) return { ok: true, branchId: null }; // no mapping configured for this option - company-wide
    return checkAccessible(mapped);
  }

  // "all"
  return { ok: true, branchId: null };
}
