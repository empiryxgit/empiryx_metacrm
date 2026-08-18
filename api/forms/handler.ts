// Forms & Lead Capture - ONE Vercel Function serving every form-related
// route, both authenticated (company-scoped builder/list/submit/submissions
// endpoints) and public (anonymous form-fetch + submit) - see
// api/auth/handler.ts for why everything in this codebase is consolidated
// like this (Vercel Hobby caps a deployment at 12 Functions total; this is
// the 12th and last available slot). vercel.json rewrites every public path
// here with formId/publicKey/sub injected as query params.
//
// Route map (see vercel.json):
//   GET/POST   /api/forms                                -> list / create
//   GET/PUT/DELETE /api/forms/{formId}                    -> read / update / delete-draft
//   POST       /api/forms/{formId}/publish                -> publish
//   POST       /api/forms/{formId}/archive                -> archive
//   POST       /api/forms/{formId}/set-default             -> make this the Add Customer form
//   POST       /api/forms/{formId}/submit                  -> internal submission (auth'd)
//   GET        /api/forms/{formId}/submissions             -> list submissions
//   GET        /api/public/forms/{publicKey}               -> public form fetch (no auth)
//   POST       /api/public/forms/{publicKey}/submit        -> public submission (no auth)

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { PERMISSIONS } from "../../src/domain/permissions";
import { assertBranchAccessible, resolveBranchAccess } from "../../src/application/branchAccess";
import {
  FORM_FIELD_TYPES,
  LEAD_SOURCES,
  SYSTEM_FIELD_KEYS,
  getIndustryTemplate,
  getInitialStageKey,
  isValidStageKey,
  type FormFieldType,
  type IndustryTemplate,
  type SystemFieldKey,
} from "../../src/domain/industryTemplates";
import { validateSubmissionValues, type ValidatableField } from "../../src/domain/formValidation";
import { getCompanyById, getUserById } from "../../src/infrastructure/db/repositories/tenancy";
import { insertFormLead, updateLeadCrmFields } from "../../src/infrastructure/db/repositories";
import {
  archiveForm,
  createForm,
  createSubmission,
  deleteDraftForm,
  getDefaultInternalForm,
  getFormById,
  getFormFields,
  getFormWithFields,
  getPublishedFormByPublicKey,
  listForms,
  listSubmissions,
  publishForm,
  replaceFormFields,
  setDefaultInternalForm,
  updateFormMeta,
  type FormFieldInput,
} from "../../src/infrastructure/db/repositories/forms";

function getQueryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------
// Field-definition validation - shared by create (POST /api/forms) and
// update (PUT /api/forms/{id}). Never trusts the client's shape; only
// known field types / system-field keys are accepted, keys must be unique
// within the form, and a system field must name a real SystemFieldKey.
// ---------------------------------------------------------------------

function isConditional(value: unknown): value is { fieldKey: string; operator: "equals" | "not_equals"; value: string } {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.fieldKey === "string" &&
    (v.operator === "equals" || v.operator === "not_equals") &&
    typeof v.value === "string"
  );
}

function validateFieldDefs(raw: unknown): { fields: FormFieldInput[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "fields must be an array." };
  const seenKeys = new Set<string>();
  const fields: FormFieldInput[] = [];

  for (const item of raw) {
    const f = (item ?? {}) as Record<string, unknown>;
    const key = typeof f.key === "string" ? f.key.trim() : "";
    const label = typeof f.label === "string" ? f.label.trim() : "";
    const fieldType = typeof f.fieldType === "string" ? f.fieldType : "";
    const mappingType = f.mappingType === "system" ? "system" : "custom";

    if (!key || !label) return { error: "Every field needs a key and a label." };
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key)) return { error: `Invalid field key: "${key}" (letters, numbers, underscore only, must start with a letter).` };
    if (!FORM_FIELD_TYPES.includes(fieldType as FormFieldType)) return { error: `Unknown field type: ${fieldType || "(none)"}` };
    if (seenKeys.has(key)) return { error: `Duplicate field key: ${key}` };
    seenKeys.add(key);

    let systemField: SystemFieldKey | null = null;
    if (mappingType === "system") {
      const sf = typeof f.systemField === "string" ? f.systemField : "";
      if (!SYSTEM_FIELD_KEYS.includes(sf as SystemFieldKey)) {
        return { error: `Unknown system field: ${sf || "(none)"}` };
      }
      systemField = sf as SystemFieldKey;
    }

    fields.push({
      key,
      label,
      fieldType,
      mappingType,
      systemField,
      options: Array.isArray(f.options) ? f.options.filter((o): o is string => typeof o === "string") : [],
      placeholder: typeof f.placeholder === "string" ? f.placeholder : null,
      helpText: typeof f.helpText === "string" ? f.helpText : null,
      defaultValue: typeof f.defaultValue === "string" ? f.defaultValue : null,
      required: Boolean(f.required),
      conditional: isConditional(f.conditional) ? f.conditional : null,
    });
  }

  return { fields };
}

// ---------------------------------------------------------------------
// Submission resolution - turns { [field.key]: rawValue } into the exact
// patch shape insertFormLead/updateLeadCrmFields already expect. Shared by
// the internal (authenticated) and public (anonymous) submit handlers so
// there is exactly one place that decides how a form value becomes a Lead
// column - never duplicated per channel.
// ---------------------------------------------------------------------

interface FormFieldLike {
  key: string;
  label: string;
  fieldType: string;
  mappingType: string;
  systemField: string | null;
}

interface ResolvedSubmission {
  systemPatch: {
    fullName?: string;
    phoneNumber?: string;
    email?: string;
    source?: string;
    ownerId?: string | null;
    pipelineStage?: string;
    nextFollowUpAt?: Date | null;
    notes?: string;
  };
  customFields: Record<string, unknown>;
}

async function resolveSubmission(
  fields: FormFieldLike[],
  values: Record<string, unknown>,
  template: IndustryTemplate,
  companyId: string,
): Promise<{ ok: true; resolved: ResolvedSubmission } | { ok: false; error: string }> {
  const systemPatch: ResolvedSubmission["systemPatch"] = {};
  const customFields: Record<string, unknown> = {};

  for (const field of fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === null || raw === "") continue;

    if (field.mappingType === "system") {
      switch (field.systemField as SystemFieldKey | null) {
        case "fullName":
          systemPatch.fullName = String(raw).trim();
          break;
        case "phoneNumber":
          systemPatch.phoneNumber = String(raw).trim();
          break;
        case "email":
          systemPatch.email = String(raw).trim();
          break;
        case "notes":
          systemPatch.notes = String(raw).trim();
          break;
        case "source": {
          const key = String(raw);
          if (!LEAD_SOURCES.some((s) => s.key === key)) return { ok: false, error: "Invalid source." };
          systemPatch.source = key;
          break;
        }
        case "ownerId": {
          const ownerId = String(raw);
          const owner = await getUserById(ownerId);
          if (!owner || owner.companyId !== companyId) return { ok: false, error: "Invalid owner." };
          systemPatch.ownerId = ownerId;
          break;
        }
        case "pipelineStage": {
          const stage = String(raw);
          if (!isValidStageKey(template, stage)) return { ok: false, error: "Invalid pipeline stage." };
          systemPatch.pipelineStage = stage;
          break;
        }
        case "nextFollowUpAt": {
          const d = new Date(String(raw));
          if (Number.isNaN(d.getTime())) return { ok: false, error: "Invalid follow-up date." };
          systemPatch.nextFollowUpAt = d;
          break;
        }
        // "crmCampaignId" is deliberately not resolved into a patch field -
        // no existing leads.* write path accepts it outside ingestion, and
        // it is never included on a public form (see provisionDefaultForms).
        default:
          break;
      }
    } else {
      customFields[field.key] = typeof raw === "string" ? raw.trim() : raw;
    }
  }

  return { ok: true, resolved: { systemPatch, customFields } };
}

function toFieldsSnapshot(fields: FormFieldLike[]) {
  return fields.map((f) => ({ key: f.key, label: f.label, fieldType: f.fieldType, mappingType: f.mappingType, systemField: f.systemField }));
}

// ---------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const publicKey = getQueryString(req, "publicKey");
  const formId = getQueryString(req, "formId");
  const sub = getQueryString(req, "sub");

  if (publicKey) {
    if (sub === "public-submit") return handlePublicSubmit(req, res, publicKey);
    return handlePublicGet(req, res, publicKey);
  }

  if (!formId && sub === "default-internal") return handleDefaultInternal(req, res);

  if (!formId) {
    if (req.method === "GET") return handleList(req, res);
    if (req.method === "POST") return handleCreate(req, res);
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  switch (sub) {
    case "publish":
      return handlePublish(req, res, formId);
    case "archive":
      return handleArchive(req, res, formId);
    case "set-default":
      return handleSetDefault(req, res, formId);
    case "submit":
      return handleInternalSubmit(req, res, formId);
    case "submissions":
      return handleSubmissions(req, res, formId);
    case undefined:
      return handleOne(req, res, formId);
    default:
      res.status(404).json({ error: "Not found" });
  }
}

// ---- Collection ---------------------------------------------------------

async function handleList(req: VercelRequest, res: VercelResponse) {
  const auth = await requirePermission(req, res, PERMISSIONS.FORMS_VIEW);
  if (!auth) return;
  const type = getQueryString(req, "type");
  try {
    const rows = await listForms(auth.companyId, type, resolveBranchAccess(auth));
    res.status(200).json({ forms: rows });
  } catch (err) {
    console.error("[forms] Failed to list forms:", err);
    res.status(500).json({ error: "Failed to list forms." });
  }
}

// What public/pipeline.html loads to drive Add Customer / Not Interested ->
// Add to CRM. Gated on leads.manage (NOT forms.view/forms.manage) -
// deliberately: any salesperson who can already add customers must be able
// to use the company's configured form, without also needing permission to
// see or edit the Forms module itself. Returns { form: null, fields: [] }
// rather than 404 when the company has no default internal form yet
// (should not happen post-onboarding, but legacy tenants mid-migration
// could hit this) - the frontend falls back to its built-in fixed fields.
async function handleDefaultInternal(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.LEADS_MANAGE);
  if (!auth) return;

  const requestedBranchId = getQueryString(req, "branchId");
  const assertion = await assertBranchAccessible(auth, requestedBranchId);
  if (!assertion.ok) {
    // Fail open to the fallback rather than blocking Add Customer on a bad/
    // inaccessible branchId - same "never block" contract as the try/catch
    // below.
    res.status(200).json({ form: null, fields: [] });
    return;
  }

  try {
    const result = await getDefaultInternalForm(auth.companyId, assertion.branchId);
    if (!result) {
      res.status(200).json({ form: null, fields: [] });
      return;
    }
    res.status(200).json({ form: result.form, fields: result.fields });
  } catch (err) {
    console.error("[forms] Failed to load default internal form:", err);
    res.status(200).json({ form: null, fields: [] }); // fail open to the fallback, never block Add Customer
  }
}

interface CreateFormBody {
  name?: string;
  description?: string;
  type?: string;
  branchId?: string;
  fields?: unknown;
}

async function handleCreate(req: VercelRequest, res: VercelResponse) {
  const auth = await requirePermission(req, res, PERMISSIONS.FORMS_MANAGE);
  if (!auth) return;

  const body = (req.body ?? {}) as CreateFormBody;
  const name = body.name?.trim();
  if (!name) {
    res.status(400).json({ error: "name is required." });
    return;
  }
  const type = body.type === "public" ? "public" : "internal";

  const validated = validateFieldDefs(body.fields ?? []);
  if ("error" in validated) {
    res.status(400).json({ error: validated.error });
    return;
  }

  const branchAssertion = await assertBranchAccessible(auth, body.branchId);
  if (!branchAssertion.ok) {
    res.status(branchAssertion.status).json({ error: branchAssertion.error });
    return;
  }

  try {
    const form = await createForm({
      companyId: auth.companyId,
      branchId: branchAssertion.branchId,
      name,
      description: body.description?.trim() || undefined,
      type,
      createdBy: auth.userId,
      fields: validated.fields,
    });
    res.status(201).json({ form });
  } catch (err) {
    console.error("[forms] Failed to create form:", err);
    res.status(500).json({ error: "Failed to create form." });
  }
}

// ---- Single form ----------------------------------------------------

interface UpdateFormBody {
  name?: string;
  description?: string;
  settings?: Record<string, unknown>;
  branchId?: string | null;
  fields?: unknown;
}

async function handleOne(req: VercelRequest, res: VercelResponse, formId: string) {
  if (req.method === "GET") {
    const auth = await requirePermission(req, res, PERMISSIONS.FORMS_VIEW);
    if (!auth) return;
    const result = await getFormWithFields(auth.companyId, formId);
    if (!result) {
      res.status(404).json({ error: "Form not found." });
      return;
    }
    res.status(200).json(result);
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.FORMS_MANAGE);
  if (!auth) return;

  if (req.method === "PUT") {
    const body = (req.body ?? {}) as UpdateFormBody;

    if (body.branchId !== undefined) {
      const branchAssertion = await assertBranchAccessible(auth, body.branchId);
      if (!branchAssertion.ok) {
        res.status(branchAssertion.status).json({ error: branchAssertion.error });
        return;
      }
    }

    if (body.name !== undefined || body.description !== undefined || body.settings !== undefined || body.branchId !== undefined) {
      await updateFormMeta(auth.companyId, formId, {
        name: body.name?.trim(),
        description: body.description?.trim(),
        settings: body.settings,
        branchId: body.branchId === undefined ? undefined : body.branchId || null,
      });
    }

    if (body.fields !== undefined) {
      const validated = validateFieldDefs(body.fields);
      if ("error" in validated) {
        res.status(400).json({ error: validated.error });
        return;
      }
      const result = await replaceFormFields(auth.companyId, formId, validated.fields);
      if (!result) {
        res.status(404).json({ error: "Form not found." });
        return;
      }
      res.status(200).json(result);
      return;
    }

    const result = await getFormWithFields(auth.companyId, formId);
    if (!result) {
      res.status(404).json({ error: "Form not found." });
      return;
    }
    res.status(200).json(result);
    return;
  }

  if (req.method === "DELETE") {
    const deleted = await deleteDraftForm(auth.companyId, formId);
    if (!deleted) {
      res.status(409).json({ error: "Only a draft form with no submissions can be deleted. Archive it instead." });
      return;
    }
    res.status(200).json({ deleted: true });
    return;
  }

  res.status(405).json({ error: "Method not allowed" });
}

async function handlePublish(req: VercelRequest, res: VercelResponse, formId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.FORMS_MANAGE);
  if (!auth) return;

  const form = await publishForm(auth.companyId, formId);
  if (!form) {
    res.status(404).json({ error: "Form not found." });
    return;
  }
  res.status(200).json({ form });
}

async function handleArchive(req: VercelRequest, res: VercelResponse, formId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.FORMS_MANAGE);
  if (!auth) return;

  const form = await getFormById(auth.companyId, formId);
  if (!form) {
    res.status(404).json({ error: "Form not found." });
    return;
  }
  await archiveForm(auth.companyId, formId);
  res.status(200).json({ archived: true });
}

async function handleSetDefault(req: VercelRequest, res: VercelResponse, formId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.FORMS_MANAGE);
  if (!auth) return;

  const ok = await setDefaultInternalForm(auth.companyId, formId);
  if (!ok) {
    res.status(400).json({ error: "Only a published internal form can be set as the default Add Customer form." });
    return;
  }
  res.status(200).json({ updated: true });
}

async function handleSubmissions(req: VercelRequest, res: VercelResponse, formId: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requirePermission(req, res, PERMISSIONS.SUBMISSIONS_VIEW);
  if (!auth) return;

  const form = await getFormById(auth.companyId, formId);
  if (!form) {
    res.status(404).json({ error: "Form not found." });
    return;
  }
  const rows = await listSubmissions(auth.companyId, formId, 200, resolveBranchAccess(auth));
  res.status(200).json({ submissions: rows });
}

// ---- Internal submission (Add Customer / Not Interested -> Add to CRM) --

interface InternalSubmitBody {
  values?: Record<string, unknown>;
  leadId?: string; // present = "convert" (enrich an existing lead); absent = "create"
}

async function handleInternalSubmit(req: VercelRequest, res: VercelResponse, formId: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  // Submitting this form always results in a Lead write, so it is gated on
  // leads.manage - the same permission the pre-existing /api/leads POST/PATCH
  // already require, not forms.manage (a salesperson who can add customers
  // should be able to use the configured form without also being able to
  // edit it).
  const auth = await requirePermission(req, res, PERMISSIONS.LEADS_MANAGE);
  if (!auth) return;

  const form = await getFormById(auth.companyId, formId);
  if (!form || form.type !== "internal" || form.status !== "published") {
    res.status(404).json({ error: "Form not found or not published." });
    return;
  }
  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);
  const fields = await getFormFields(formId);

  const body = (req.body ?? {}) as InternalSubmitBody;
  const values = body.values ?? {};

  const validationErrors = validateSubmissionValues(fields as unknown as ValidatableField[], values);
  if (Object.keys(validationErrors).length > 0) {
    res.status(400).json({ error: "Please fix the highlighted fields.", fieldErrors: validationErrors });
    return;
  }

  const resolved = await resolveSubmission(fields, values, template, auth.companyId);
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  const { systemPatch, customFields } = resolved.resolved;

  try {
    let lead;
    if (body.leadId) {
      // "convert" - Not Interested -> Add to CRM (or a re-edit of an
      // existing customer). source is intentionally never included in this
      // patch - see updateLeadCrmFields' own contract for why.
      lead = await updateLeadCrmFields(auth.companyId, body.leadId, {
        fullName: systemPatch.fullName,
        email: systemPatch.email,
        phoneNumber: systemPatch.phoneNumber,
        ownerId: systemPatch.ownerId,
        pipelineStage: systemPatch.pipelineStage,
        nextFollowUpAt: systemPatch.nextFollowUpAt,
        notes: systemPatch.notes,
        customFields,
      });
      if (!lead) {
        res.status(404).json({ error: "Lead not found." });
        return;
      }
    } else {
      // "create" - brand-new manually-entered customer.
      if (!systemPatch.fullName || !systemPatch.phoneNumber) {
        res.status(400).json({ error: "Customer name and phone are required." });
        return;
      }
      lead = await insertFormLead({
        companyId: auth.companyId,
        branchId: form.branchId,
        fullName: systemPatch.fullName,
        phoneNumber: systemPatch.phoneNumber,
        email: systemPatch.email,
        source: systemPatch.source || "manual",
        leadType: "manual_customer",
        ownerId: systemPatch.ownerId ?? undefined,
        pipelineStage: systemPatch.pipelineStage || getInitialStageKey(template),
        nextFollowUpAt: systemPatch.nextFollowUpAt ?? undefined,
        notes: systemPatch.notes,
        customFields,
      });
    }

    const submission = await createSubmission({
      formId,
      companyId: auth.companyId,
      branchId: form.branchId,
      leadId: lead.id,
      schemaVersion: form.schemaVersion,
      fieldsSnapshot: toFieldsSnapshot(fields),
      values,
      channel: "internal",
    });

    res.status(200).json({ lead, submission });
  } catch (err) {
    console.error("[forms] Failed to submit internal form:", err);
    res.status(500).json({ error: "Failed to save customer." });
  }
}

// ---- Public form (no auth) -----------------------------------------

async function handlePublicGet(req: VercelRequest, res: VercelResponse, publicKey: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const result = await getPublishedFormByPublicKey(publicKey);
  if (!result) {
    res.status(404).json({ error: "This form is not available." });
    return;
  }

  // Safe, minimal projection only - never leak companyId, createdBy,
  // internal settings beyond the display-facing ones, or any other
  // company-private data to an anonymous visitor.
  const { form, fields } = result;
  res.status(200).json({
    form: {
      id: form.id,
      name: form.name,
      description: form.description,
      settings: {
        submitButtonLabel: (form.settings as Record<string, unknown> | null)?.submitButtonLabel ?? "Submit",
        successMessage: (form.settings as Record<string, unknown> | null)?.successMessage ?? "Thank you — we'll be in touch shortly.",
      },
    },
    fields: fields
      .filter((f) => f.systemField !== "ownerId" && f.systemField !== "pipelineStage" && f.systemField !== "source") // never exposed publicly regardless of how the form was built
      .map((f) => ({
        key: f.key,
        label: f.label,
        fieldType: f.fieldType,
        options: f.options,
        placeholder: f.placeholder,
        helpText: f.helpText,
        defaultValue: f.defaultValue,
        required: f.required,
        conditional: f.conditional,
      })),
  });
}

interface PublicSubmitBody {
  values?: Record<string, unknown>;
}

function getClientIp(req: VercelRequest): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]?.trim();
  return req.socket?.remoteAddress;
}

async function handlePublicSubmit(req: VercelRequest, res: VercelResponse, publicKey: string) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const result = await getPublishedFormByPublicKey(publicKey);
  if (!result) {
    res.status(404).json({ error: "This form is not available." });
    return;
  }
  const { form, fields: allFields } = result;
  // Owner/pipeline-stage can never be set from a public submission even if
  // somehow present on the form definition (defense in depth alongside the
  // GET projection above and provisionDefaultForms never adding them).
  const fields = allFields.filter((f) => f.systemField !== "ownerId" && f.systemField !== "pipelineStage" && f.systemField !== "source");

  const company = await getCompanyById(form.companyId);
  if (!company) {
    res.status(404).json({ error: "This form is not available." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);

  const body = (req.body ?? {}) as PublicSubmitBody;
  const values = body.values ?? {};

  const validationErrors = validateSubmissionValues(fields as unknown as ValidatableField[], values);
  if (Object.keys(validationErrors).length > 0) {
    res.status(400).json({ error: "Please fix the highlighted fields.", fieldErrors: validationErrors });
    return;
  }

  const resolved = await resolveSubmission(fields, values, template, form.companyId);
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  const { systemPatch, customFields } = resolved.resolved;

  if (!systemPatch.fullName || !systemPatch.phoneNumber) {
    res.status(400).json({ error: "Name and phone are required." });
    return;
  }

  try {
    const lead = await insertFormLead({
      companyId: form.companyId,
      branchId: form.branchId,
      fullName: systemPatch.fullName,
      phoneNumber: systemPatch.phoneNumber,
      email: systemPatch.email,
      // A public form never collects "source" (it's never in the field
      // list an external visitor sees) - always tagged automatically, same
      // idea as Meta ingestion tagging "meta_lead_ads".
      source: "public_form",
      leadType: "digital_lead",
      pipelineStage: getInitialStageKey(template),
      notes: systemPatch.notes,
      customFields,
    });

    const submission = await createSubmission({
      formId: form.id,
      companyId: form.companyId,
      branchId: form.branchId,
      leadId: lead.id,
      schemaVersion: form.schemaVersion,
      fieldsSnapshot: toFieldsSnapshot(fields),
      values,
      channel: "public",
      submitterIp: getClientIp(req),
      submitterUserAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });

    res.status(201).json({
      submitted: true,
      message: (form.settings as Record<string, unknown> | null)?.successMessage ?? "Thank you — we'll be in touch shortly.",
      submissionId: submission.id,
    });
  } catch (err) {
    console.error("[forms] Failed to submit public form:", err);
    res.status(500).json({ error: "Something went wrong submitting the form. Please try again." });
  }
}
