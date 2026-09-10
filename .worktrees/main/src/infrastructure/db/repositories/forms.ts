// Forms & Lead Capture data access. Every function here is company-scoped
// (companyId is always part of the WHERE clause on anything mutable) so
// cross-tenant access is impossible at this layer, not just enforced by the
// API handler above it - see api/forms/handler.ts for the auth checks that
// call into these.

import { randomBytes } from "crypto";
import { and, desc, eq, isNull, type Column } from "drizzle-orm";
import { getDb } from "../client";
import { formFields, formSubmissions, forms } from "../schema";
import { firstOrThrow } from "../util";
import type { FormFieldTemplateDef, IndustryTemplate } from "../../../domain/industryTemplates";
import { branchAccessCondition } from "../branchFilter";
import type { BranchAccess } from "../../../application/branchAccess";

/** NULL-safe equality for a nullable branch_id column - `eq(col, null)`
 * would compile to `col = NULL`, which SQL always evaluates to unknown/false,
 * never matching a company-wide (NULL) row. Used everywhere a form/submission
 * needs to be matched against a SPECIFIC branch scope (including "no
 * branch"), as opposed to branchAccessCondition's broader "this row OR any
 * company-wide row" read-access filter. */
function branchIs(column: Column, branchId: string | null) {
  return branchId === null ? isNull(column) : eq(column, branchId);
}

// ---- Field shape shared by create + replace --------------------------

export interface FormFieldInput {
  key: string;
  label: string;
  fieldType: string;
  mappingType: "system" | "custom";
  systemField?: string | null;
  options?: string[];
  placeholder?: string | null;
  helpText?: string | null;
  defaultValue?: string | null;
  required?: boolean;
  conditional?: { fieldKey: string; operator: "equals" | "not_equals"; value: string } | null;
}

async function insertFields(formId: string, fields: FormFieldInput[]) {
  if (fields.length === 0) return;
  const db = await getDb();
  await db.insert(formFields).values(
    fields.map((f, idx) => ({
      formId,
      key: f.key,
      label: f.label,
      fieldType: f.fieldType,
      mappingType: f.mappingType,
      systemField: f.mappingType === "system" ? f.systemField ?? null : null,
      options: f.options ?? [],
      placeholder: f.placeholder ?? null,
      helpText: f.helpText ?? null,
      defaultValue: f.defaultValue ?? null,
      required: Boolean(f.required),
      position: idx,
      conditional: f.conditional ?? null,
    })),
  );
}

// ---- Forms ----------------------------------------------------------------

export async function listForms(companyId: string, type?: string, access?: BranchAccess) {
  const db = await getDb();
  const conditions = [eq(forms.companyId, companyId)];
  if (type) conditions.push(eq(forms.type, type));
  const branchCondition = access ? branchAccessCondition(forms.branchId, access) : undefined;
  if (branchCondition) conditions.push(branchCondition);
  return db.select().from(forms).where(and(...conditions)).orderBy(desc(forms.updatedAt));
}

export async function getFormById(companyId: string, formId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(forms)
    .where(and(eq(forms.companyId, companyId), eq(forms.id, formId)))
    .limit(1);
  return row ?? null;
}

export async function getFormFields(formId: string) {
  const db = await getDb();
  const rows = await db.select().from(formFields).where(eq(formFields.formId, formId));
  return [...rows].sort((a, b) => a.position - b.position);
}

export async function getFormWithFields(companyId: string, formId: string) {
  const form = await getFormById(companyId, formId);
  if (!form) return null;
  const fields = await getFormFields(formId);
  return { form, fields };
}

/** Public lookup by publicKey - only ever returns a "published" form,
 * regardless of whether the key itself is well-formed, so a draft/archived
 * form can never be reached from its (possibly still-known) old URL. */
export async function getPublishedFormByPublicKey(publicKey: string) {
  const db = await getDb();
  const [form] = await db
    .select()
    .from(forms)
    .where(and(eq(forms.publicKey, publicKey), eq(forms.status, "published")))
    .limit(1);
  if (!form) return null;
  const fields = await getFormFields(form.id);
  return { form, fields };
}

// Branch Configuration - shared shape between create and update. See
// src/application/formBranch.ts for how these turn into an actual branchId
// at submission time, and for the validation every caller MUST run before
// passing these through (never trust a client-supplied branchMode/
// branchFieldMap directly - validateBranchConfig checks tenant isolation
// AND the saving user's own branch access on every branchId referenced).
export interface FormBranchConfigInput {
  branchMode?: "specific" | "all" | "field";
  branchId?: string | null; // authoritative only when branchMode="specific"
  branchFieldKey?: string | null; // authoritative only when branchMode="field"
  branchFieldMap?: Record<string, string>; // authoritative only when branchMode="field"
}

// Form-level CRM defaults - shared shape between create and update. See the
// forms table comment in schema.ts.
export interface FormDefaultsInput {
  defaultPipelineStage?: string | null;
  defaultCrmCampaignId?: string | null;
  defaultSource?: string | null;
  defaultOwnerId?: string | null;
}

export interface CreateFormInput extends FormBranchConfigInput, FormDefaultsInput {
  companyId: string;
  name: string;
  description?: string;
  type: "internal" | "public";
  createdBy?: string;
  fields: FormFieldInput[];
}

export async function createForm(input: CreateFormInput) {
  const db = await getDb();
  const rows = await db
    .insert(forms)
    .values({
      companyId: input.companyId,
      branchId: input.branchId ?? null,
      branchMode: input.branchMode ?? (input.branchId ? "specific" : "all"),
      branchFieldKey: input.branchFieldKey ?? null,
      branchFieldMap: input.branchFieldMap ?? {},
      name: input.name,
      description: input.description,
      type: input.type,
      createdBy: input.createdBy,
      defaultPipelineStage: input.defaultPipelineStage ?? null,
      defaultCrmCampaignId: input.defaultCrmCampaignId ?? null,
      defaultSource: input.defaultSource ?? null,
      defaultOwnerId: input.defaultOwnerId ?? null,
    })
    .returning();
  const form = firstOrThrow(rows);
  await insertFields(form.id, input.fields);
  return form;
}

export interface UpdateFormMetaInput extends FormBranchConfigInput, FormDefaultsInput {
  name?: string;
  description?: string;
  settings?: Record<string, unknown>;
}

export async function updateFormMeta(companyId: string, formId: string, input: UpdateFormMetaInput) {
  const db = await getDb();
  await db
    .update(forms)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(forms.companyId, companyId), eq(forms.id, formId)));
}

/** Replaces a form's entire field list - the builder always saves the full,
 * reordered set; there is no per-field PATCH. Bumps schemaVersion only when
 * the form is already published, so a submission collected under the old
 * field list stays attributable to its exact snapshot (see
 * formSubmissions.schemaVersion/fieldsSnapshot below) - a still-draft form
 * can be edited freely with no version bump since it has no submissions
 * yet. */
export async function replaceFormFields(companyId: string, formId: string, fields: FormFieldInput[]) {
  const db = await getDb();
  const form = await getFormById(companyId, formId);
  if (!form) return null;

  await db.delete(formFields).where(eq(formFields.formId, formId));
  await insertFields(formId, fields);

  const bumpVersion = form.status === "published";
  await db
    .update(forms)
    .set({ updatedAt: new Date(), schemaVersion: bumpVersion ? form.schemaVersion + 1 : form.schemaVersion })
    .where(eq(forms.id, formId));

  return getFormWithFields(companyId, formId);
}

function generatePublicKey(): string {
  return randomBytes(18).toString("base64url");
}

export async function publishForm(companyId: string, formId: string) {
  const db = await getDb();
  const form = await getFormById(companyId, formId);
  if (!form) return null;

  const patch: { status: string; publishedAt: Date; updatedAt: Date; publicKey?: string } = {
    status: "published",
    publishedAt: new Date(),
    updatedAt: new Date(),
  };
  if (form.type === "public" && !form.publicKey) {
    patch.publicKey = generatePublicKey();
  }
  await db.update(forms).set(patch).where(eq(forms.id, formId));
  return getFormById(companyId, formId);
}

/** Archiving always clears isDefault - a company can never be left pointing
 * Add Customer at a dead form. public/pipeline.html falls back to its
 * built-in fixed field set whenever no default internal form is found, so
 * this is always safe even mid-transition. */
export async function archiveForm(companyId: string, formId: string) {
  const db = await getDb();
  await db
    .update(forms)
    .set({ status: "archived", archivedAt: new Date(), updatedAt: new Date(), isDefault: false })
    .where(and(eq(forms.companyId, companyId), eq(forms.id, formId)));
}

/** Only a draft with zero submissions may be hard-deleted - anything ever
 * published, or ever submitted against, is kept forever (archive instead),
 * so a submission's fieldsSnapshot can never end up pointing at a form row
 * that no longer exists. */
export async function deleteDraftForm(companyId: string, formId: string): Promise<boolean> {
  const db = await getDb();
  const form = await getFormById(companyId, formId);
  if (!form || form.status !== "draft") return false;
  const [existingSubmission] = await db
    .select({ id: formSubmissions.id })
    .from(formSubmissions)
    .where(eq(formSubmissions.formId, formId))
    .limit(1);
  if (existingSubmission) return false;
  await db.delete(formFields).where(eq(formFields.formId, formId));
  await db.delete(forms).where(eq(forms.id, formId));
  return true;
}

/** Marks `formId` the default internal form for its OWN branch scope (auto-
 * loaded by Add Customer / Not Interested -> Add to CRM), clearing the flag
 * on every other internal form in that SAME scope first - company-wide
 * (branchId null) and each individual branch each get their own independent
 * "one default at a time" invariant, so setting a branch's default can never
 * clobber the company-wide default or another branch's. Only a published
 * internal form may be set as default. */
export async function setDefaultInternalForm(companyId: string, formId: string): Promise<boolean> {
  const db = await getDb();
  const form = await getFormById(companyId, formId);
  if (!form || form.type !== "internal" || form.status !== "published") return false;
  await db
    .update(forms)
    .set({ isDefault: false, updatedAt: new Date() })
    .where(and(eq(forms.companyId, companyId), eq(forms.type, "internal"), branchIs(forms.branchId, form.branchId)));
  await db.update(forms).set({ isDefault: true, updatedAt: new Date() }).where(eq(forms.id, formId));
  return true;
}

/** What public/pipeline.html loads to drive Add Customer / Not Interested ->
 * Add to CRM. When `branchId` is omitted, behaves exactly as before this
 * feature existed - no branch filtering at all - so every existing caller
 * (which never passes one) is completely unaffected. When a branchId IS
 * given: prefers that branch's own flagged default, then falls back to the
 * company-wide (branchId null) default, then to the most-recently-published
 * internal form in either scope, and finally to null - in which case the
 * caller falls back to its own hard-coded field set unchanged, so this
 * feature can never regress an existing tenant either way. */
export async function getDefaultInternalForm(companyId: string, branchId?: string | null) {
  const db = await getDb();
  const base = [eq(forms.companyId, companyId), eq(forms.type, "internal"), eq(forms.status, "published")];

  async function findFlagged(scopeBranchId: string | null) {
    const [row] = await db.select().from(forms).where(and(...base, eq(forms.isDefault, true), branchIs(forms.branchId, scopeBranchId))).limit(1);
    return row;
  }
  async function findLatest(scopeBranchId: string | null) {
    const rows = await db
      .select()
      .from(forms)
      .where(and(...base, branchIs(forms.branchId, scopeBranchId)))
      .orderBy(desc(forms.publishedAt))
      .limit(1);
    return rows[0];
  }

  let form;
  if (branchId === undefined) {
    // Legacy, branch-unaware path - identical query to before this feature.
    form = (await db.select().from(forms).where(and(...base, eq(forms.isDefault, true))).limit(1))[0]
      ?? (await db.select().from(forms).where(and(...base)).orderBy(desc(forms.publishedAt)).limit(1))[0];
  } else {
    form =
      (branchId ? await findFlagged(branchId) : undefined) ??
      (await findFlagged(null)) ??
      (branchId ? await findLatest(branchId) : undefined) ??
      (await findLatest(null));
  }

  if (!form) return null;
  const fields = await getFormFields(form.id);
  return { form, fields };
}

// ---- Submissions ------------------------------------------------------

export interface CreateSubmissionInput {
  formId: string;
  companyId: string;
  /** Denormalized from the parent form at submission time (see
   * api/forms/handler.ts) rather than looked up here, so a later branch
   * reassignment of the form never rewrites history for submissions already
   * collected under its old branch. */
  branchId?: string | null;
  leadId?: string | null;
  schemaVersion: number;
  fieldsSnapshot: unknown;
  values: Record<string, unknown>;
  channel: "internal" | "public" | "manual_prefill";
  submitterIp?: string;
  submitterUserAgent?: string;
  status?: "received" | "rejected";
  rejectionReason?: string;
}

export async function createSubmission(input: CreateSubmissionInput) {
  const db = await getDb();
  const rows = await db
    .insert(formSubmissions)
    .values({
      formId: input.formId,
      companyId: input.companyId,
      branchId: input.branchId ?? null,
      leadId: input.leadId ?? null,
      schemaVersion: input.schemaVersion,
      fieldsSnapshot: input.fieldsSnapshot as unknown[],
      values: input.values,
      channel: input.channel,
      submitterIp: input.submitterIp,
      submitterUserAgent: input.submitterUserAgent,
      status: input.status ?? "received",
      rejectionReason: input.rejectionReason,
    })
    .returning();
  return firstOrThrow(rows);
}

export async function listSubmissions(companyId: string, formId?: string, limit = 200, access?: BranchAccess) {
  const db = await getDb();
  const conditions = [eq(formSubmissions.companyId, companyId)];
  if (formId) conditions.push(eq(formSubmissions.formId, formId));
  const branchCondition = access ? branchAccessCondition(formSubmissions.branchId, access) : undefined;
  if (branchCondition) conditions.push(branchCondition);
  return db
    .select()
    .from(formSubmissions)
    .where(and(...conditions))
    .orderBy(desc(formSubmissions.createdAt))
    .limit(limit);
}

export async function getSubmissionById(companyId: string, submissionId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(formSubmissions)
    .where(and(eq(formSubmissions.companyId, companyId), eq(formSubmissions.id, submissionId)))
    .limit(1);
  return row ?? null;
}

// ---- Onboarding auto-provisioning -----------------------------------

function toFieldInput(f: FormFieldTemplateDef): FormFieldInput {
  return {
    key: f.key,
    label: f.label,
    fieldType: f.fieldType,
    mappingType: f.mappingType,
    systemField: f.systemField ?? null,
    options: f.options ?? [],
    placeholder: f.placeholder ?? null,
    helpText: f.helpText ?? null,
    required: Boolean(f.required),
  };
}

/**
 * Called once, right after a company is created (see
 * registerCompanyAndOwner in src/application/auth.ts), so a brand-new
 * tenant always has a working "Add Customer" form from minute one - no
 * separate manual setup step required. Provisions purely from the industry
 * template's defaultFormFields (see industryTemplates.ts) - this function
 * never branches on the industry key itself, so adding a new industry later
 * needs no change here.
 *
 * Creates two forms:
 *  - one "internal" form, published immediately and flagged default, so
 *    Pipeline's Add Customer / Not Interested -> Add to CRM work right away.
 *  - one "public" form, left as a draft - the company chooses if/when to
 *    publish it for external lead capture, rather than exposing a public
 *    URL nobody asked for on day one. Owner/pipeline-stage fields are
 *    dropped from the public copy - an anonymous external visitor never
 *    assigns their own salesperson or pipeline stage.
 */
export async function provisionDefaultForms(companyId: string, template: IndustryTemplate, createdBy?: string) {
  const fieldInputs = template.defaultFormFields.map(toFieldInput);

  const internal = await createForm({
    companyId,
    name: `${template.name} - Add Customer`,
    description: "Default internal form used by Add Customer and Not Interested → Add to CRM on the Pipeline board.",
    type: "internal",
    createdBy,
    fields: fieldInputs,
  });
  await publishForm(companyId, internal.id);
  await setDefaultInternalForm(companyId, internal.id);

  const publicFieldInputs = fieldInputs.filter((f) => f.systemField !== "ownerId" && f.systemField !== "pipelineStage");
  const publicForm = await createForm({
    companyId,
    name: `${template.name} - Lead Capture`,
    description: "Default public lead-capture form. Publish it to get a shareable URL for landing pages and ads.",
    type: "public",
    createdBy,
    fields: publicFieldInputs,
  });

  return { internal, public: publicForm };
}
