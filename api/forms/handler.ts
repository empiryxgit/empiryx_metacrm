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
import { assertBranchAccessible, canAccessBranch, resolveBranchAccess } from "../../src/application/branchAccess";
import { branchAccessCondition } from "../../src/infrastructure/db/branchFilter";
import { leads } from "../../src/infrastructure/db/schema";
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
import { getCampaign } from "../../src/infrastructure/db/repositories/campaigns";
import { insertFormLead, updateLeadCrmFields } from "../../src/infrastructure/db/repositories";
import {
  validateBranchConfig,
  resolveFormSubmissionBranch,
  type FormBranchConfig,
  type ValidatedBranchConfig,
} from "../../src/application/formBranch";
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
    crmCampaignId?: string | null;
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
        case "crmCampaignId": {
          const campaignId = String(raw);
          const campaign = await getCampaign(companyId, campaignId);
          if (!campaign) return { ok: false, error: "Invalid campaign." };
          systemPatch.crmCampaignId = campaignId;
          break;
        }
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

interface FormRow {
  branchMode: string;
  branchId: string | null;
  branchFieldKey: string | null;
  branchFieldMap: Record<string, string> | null;
  defaultPipelineStage: string | null;
  defaultCrmCampaignId: string | null;
  defaultSource: string | null;
  defaultOwnerId: string | null;
}

function formBranchConfigFrom(form: FormRow): FormBranchConfig {
  return { branchMode: form.branchMode, branchId: form.branchId, branchFieldKey: form.branchFieldKey, branchFieldMap: form.branchFieldMap };
}

/**
 * Layers a form's own Branch Configuration defaults (Pipeline/Initial Stage/
 * Campaign/Lead Source/Default Owner - see the forms table comment in
 * schema.ts) UNDER whatever the submission itself already resolved from its
 * field values - a value the submitter/salesperson actually provided always
 * wins; the form-level default only fills a gap. Every default is either
 * FK-backed (defaultCrmCampaignId/defaultOwnerId - ON DELETE SET NULL
 * guarantees a non-null value still points at a live row) or re-validated
 * here (defaultPipelineStage against the company's current industry
 * template, defaultSource against the fixed catalog) before being trusted,
 * so a stale form config (e.g. after a template change) can never write a
 * bad value to a Lead - it just falls through to the next fallback instead.
 */
function applyFormDefaults(
  form: FormRow,
  systemPatch: ResolvedSubmission["systemPatch"],
  template: IndustryTemplate,
): { pipelineStage: string; source: string | undefined; ownerId: string | undefined; crmCampaignId: string | null | undefined } {
  const pipelineStage =
    systemPatch.pipelineStage ??
    (form.defaultPipelineStage && isValidStageKey(template, form.defaultPipelineStage) ? form.defaultPipelineStage : undefined) ??
    getInitialStageKey(template);

  const source = systemPatch.source ?? (form.defaultSource && LEAD_SOURCES.some((s) => s.key === form.defaultSource) ? form.defaultSource : undefined);

  const ownerId = systemPatch.ownerId !== undefined ? (systemPatch.ownerId ?? undefined) : form.defaultOwnerId ?? undefined;

  const crmCampaignId = systemPatch.crmCampaignId !== undefined ? systemPatch.crmCampaignId : form.defaultCrmCampaignId ?? undefined;

  return { pipelineStage, source, ownerId, crmCampaignId };
}

// ---------------------------------------------------------------------
// Form-level defaults body validation - shared by handleCreate (POST
// /api/forms) and handleOne's PUT (/api/forms/{id}). Partial-update
// semantics: a key absent from the body is omitted from the returned
// object entirely (createForm/updateFormMeta both treat that as "use the
// existing/no default" - see their own `?? null` / spread-omits-undefined
// handling), an explicit ""/null clears it, and a real value is validated
// and normalized before being trusted.
// ---------------------------------------------------------------------

interface FormDefaultsBody {
  defaultPipelineStage?: string | null;
  defaultCrmCampaignId?: string | null;
  defaultSource?: string | null;
  defaultOwnerId?: string | null;
}

async function validateFormDefaultsBody(
  companyId: string,
  body: FormDefaultsBody,
  template: IndustryTemplate,
): Promise<{ ok: true; defaults: FormDefaultsBody } | { ok: false; error: string }> {
  const defaults: FormDefaultsBody = {};

  if (body.defaultPipelineStage !== undefined) {
    if (!body.defaultPipelineStage) {
      defaults.defaultPipelineStage = null;
    } else if (!isValidStageKey(template, body.defaultPipelineStage)) {
      return { ok: false, error: "Invalid initial stage." };
    } else {
      defaults.defaultPipelineStage = body.defaultPipelineStage;
    }
  }

  if (body.defaultCrmCampaignId !== undefined) {
    if (!body.defaultCrmCampaignId) {
      defaults.defaultCrmCampaignId = null;
    } else {
      const campaign = await getCampaign(companyId, body.defaultCrmCampaignId);
      if (!campaign) return { ok: false, error: "Invalid campaign." };
      defaults.defaultCrmCampaignId = campaign.id;
    }
  }

  if (body.defaultSource !== undefined) {
    if (!body.defaultSource) {
      defaults.defaultSource = null;
    } else if (!LEAD_SOURCES.some((s) => s.key === body.defaultSource)) {
      return { ok: false, error: "Invalid lead source." };
    } else {
      defaults.defaultSource = body.defaultSource;
    }
  }

  if (body.defaultOwnerId !== undefined) {
    if (!body.defaultOwnerId) {
      defaults.defaultOwnerId = null;
    } else {
      const owner = await getUserById(body.defaultOwnerId);
      if (!owner || owner.companyId !== companyId) return { ok: false, error: "Invalid owner." };
      defaults.defaultOwnerId = owner.id;
    }
  }

  return { ok: true, defaults };
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
  branchMode?: string;
  branchFieldKey?: string;
  branchFieldMap?: Record<string, string>;
  fields?: unknown;
  defaultPipelineStage?: string | null;
  defaultCrmCampaignId?: string | null;
  defaultSource?: string | null;
  defaultOwnerId?: string | null;
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

  const branchConfig = await validateBranchConfig(auth, body, validated.fields);
  if (!branchConfig.ok) {
    res.status(branchConfig.status).json({ error: branchConfig.error });
    return;
  }

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);
  const defaultsResult = await validateFormDefaultsBody(auth.companyId, body, template);
  if (!defaultsResult.ok) {
    res.status(400).json({ error: defaultsResult.error });
    return;
  }

  try {
    const form = await createForm({
      companyId: auth.companyId,
      branchId: branchConfig.config.branchId,
      branchMode: branchConfig.config.branchMode,
      branchFieldKey: branchConfig.config.branchFieldKey,
      branchFieldMap: branchConfig.config.branchFieldMap,
      name,
      description: body.description?.trim() || undefined,
      type,
      createdBy: auth.userId,
      fields: validated.fields,
      ...defaultsResult.defaults,
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
  branchMode?: string;
  branchFieldKey?: string;
  branchFieldMap?: Record<string, string>;
  fields?: unknown;
  defaultPipelineStage?: string | null;
  defaultCrmCampaignId?: string | null;
  defaultSource?: string | null;
  defaultOwnerId?: string | null;
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
    // Tenant isolation (companyId, above) is not enough on its own - a
    // branch-restricted viewer must never read a form (including its
    // Branch Configuration / CRM defaults) scoped to a branch outside
    // their own access.
    if (!canAccessBranch(resolveBranchAccess(auth), result.form.branchId)) {
      res.status(403).json({ error: "You do not have access to this branch." });
      return;
    }
    res.status(200).json(result);
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.FORMS_MANAGE);
  if (!auth) return;

  if (req.method === "PUT") {
    const body = (req.body ?? {}) as UpdateFormBody;

    const existingForm = await getFormById(auth.companyId, formId);
    if (!existingForm) {
      res.status(404).json({ error: "Form not found." });
      return;
    }
    // Guards the form's CURRENT branch - a branch-restricted manager can
    // never edit a form already scoped outside their access (any NEW
    // branchId being set is separately validated by validateBranchConfig
    // below, which itself routes through assertBranchAccessible).
    if (!canAccessBranch(resolveBranchAccess(auth), existingForm.branchId)) {
      res.status(403).json({ error: "You do not have access to this branch." });
      return;
    }

    // Branch Configuration's "field" mode needs the form's OTHER field
    // definitions to validate branchFieldKey against - use body.fields when
    // this same request is also replacing them (the Form Builder always
    // saves meta + fields together), otherwise fall back to what's already
    // on the form.
    let validatedFields: FormFieldInput[] | null = null;
    if (body.fields !== undefined) {
      const validated = validateFieldDefs(body.fields);
      if ("error" in validated) {
        res.status(400).json({ error: validated.error });
        return;
      }
      validatedFields = validated.fields;
    }
    const fieldsForValidation = validatedFields ?? (await getFormFields(formId));

    const branchTouched =
      body.branchId !== undefined || body.branchMode !== undefined || body.branchFieldKey !== undefined || body.branchFieldMap !== undefined;
    let branchPatch: Partial<ValidatedBranchConfig> = {};
    if (branchTouched) {
      const branchConfig = await validateBranchConfig(
        auth,
        {
          branchMode: body.branchMode ?? existingForm.branchMode,
          branchId: body.branchId !== undefined ? body.branchId : existingForm.branchId,
          branchFieldKey: body.branchFieldKey !== undefined ? body.branchFieldKey : existingForm.branchFieldKey,
          branchFieldMap: body.branchFieldMap !== undefined ? body.branchFieldMap : existingForm.branchFieldMap,
        },
        fieldsForValidation,
      );
      if (!branchConfig.ok) {
        res.status(branchConfig.status).json({ error: branchConfig.error });
        return;
      }
      branchPatch = branchConfig.config;
    }

    const defaultsTouched =
      body.defaultPipelineStage !== undefined ||
      body.defaultCrmCampaignId !== undefined ||
      body.defaultSource !== undefined ||
      body.defaultOwnerId !== undefined;
    let defaultsPatch: FormDefaultsBody = {};
    if (defaultsTouched) {
      const company = await getCompanyById(auth.companyId);
      if (!company) {
        res.status(401).json({ error: "Account no longer exists." });
        return;
      }
      const template = getIndustryTemplate(company.industryTemplate);
      const defaultsResult = await validateFormDefaultsBody(auth.companyId, body, template);
      if (!defaultsResult.ok) {
        res.status(400).json({ error: defaultsResult.error });
        return;
      }
      defaultsPatch = defaultsResult.defaults;
    }

    if (
      body.name !== undefined ||
      body.description !== undefined ||
      body.settings !== undefined ||
      branchTouched ||
      defaultsTouched
    ) {
      await updateFormMeta(auth.companyId, formId, {
        name: body.name?.trim(),
        description: body.description?.trim(),
        settings: body.settings,
        ...branchPatch,
        ...defaultsPatch,
      });
    }

    if (validatedFields !== null) {
      const result = await replaceFormFields(auth.companyId, formId, validatedFields);
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
    const formToDelete = await getFormById(auth.companyId, formId);
    if (!formToDelete) {
      res.status(404).json({ error: "Form not found." });
      return;
    }
    if (!canAccessBranch(resolveBranchAccess(auth), formToDelete.branchId)) {
      res.status(403).json({ error: "You do not have access to this branch." });
      return;
    }
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

  const existingForm = await getFormById(auth.companyId, formId);
  if (!existingForm) {
    res.status(404).json({ error: "Form not found." });
    return;
  }
  if (!canAccessBranch(resolveBranchAccess(auth), existingForm.branchId)) {
    res.status(403).json({ error: "You do not have access to this branch." });
    return;
  }

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
  if (!canAccessBranch(resolveBranchAccess(auth), form.branchId)) {
    res.status(403).json({ error: "You do not have access to this branch." });
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

  const existingForm = await getFormById(auth.companyId, formId);
  if (!existingForm) {
    res.status(404).json({ error: "Form not found." });
    return;
  }
  if (!canAccessBranch(resolveBranchAccess(auth), existingForm.branchId)) {
    res.status(403).json({ error: "You do not have access to this branch." });
    return;
  }

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
  branchId?: string | null; // optional override - see resolution below the form lookup
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

  // Multi-branch user override: the Add Customer modal preselects the
  // caller's branch but lets a multi-branch user pick a different permitted
  // one - takes precedence over the form's own Branch Configuration
  // entirely when explicitly provided (pre-existing behavior, unchanged).
  // Otherwise resolved from the form's own Branch Configuration - specific/
  // all/field (see src/application/formBranch.ts) - re-validated against
  // the caller's own branch access either way, so a value the client didn't
  // actually have permission for can never slip through.
  const branchResolution = await resolveFormSubmissionBranch(auth.companyId, formBranchConfigFrom(form), values, auth, body.branchId);
  if (!branchResolution.ok) {
    res.status(branchResolution.status).json({ error: branchResolution.error });
    return;
  }
  const effectiveBranchId = branchResolution.branchId;

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
      // patch - see updateLeadCrmFields' own contract for why. branchCondition
      // guards the target lead's CURRENT branch, same "company_id + branch_id
      // enforced on the backend" contract as every other branch-scoped
      // write - a branch-restricted salesperson could otherwise pass any
      // leadId here and edit a lead outside their own branch access.
      const branchCondition = branchAccessCondition(leads.branchId, resolveBranchAccess(auth));
      lead = await updateLeadCrmFields(auth.companyId, body.leadId, {
        fullName: systemPatch.fullName,
        email: systemPatch.email,
        phoneNumber: systemPatch.phoneNumber,
        ownerId: systemPatch.ownerId,
        pipelineStage: systemPatch.pipelineStage,
        nextFollowUpAt: systemPatch.nextFollowUpAt,
        notes: systemPatch.notes,
        customFields,
      }, branchCondition);
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
      const defaults = applyFormDefaults(form, systemPatch, template);
      lead = await insertFormLead({
        companyId: auth.companyId,
        branchId: effectiveBranchId,
        crmCampaignId: defaults.crmCampaignId ?? null,
        fullName: systemPatch.fullName,
        phoneNumber: systemPatch.phoneNumber,
        email: systemPatch.email,
        source: defaults.source || "manual",
        leadType: "manual_customer",
        ownerId: defaults.ownerId,
        pipelineStage: defaults.pipelineStage,
        nextFollowUpAt: systemPatch.nextFollowUpAt ?? undefined,
        notes: systemPatch.notes,
        customFields,
      });
    }

    const submission = await createSubmission({
      formId,
      companyId: auth.companyId,
      branchId: effectiveBranchId,
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
      // never exposed publicly regardless of how the form was built - owner/
      // stage/source/campaign are always either the form's own configured
      // default (see forms.default* / Branch Configuration's sibling
      // settings) or left unset, never a visitor's own choice.
      .filter((f) => !["ownerId", "pipelineStage", "source", "crmCampaignId"].includes(f.systemField ?? ""))
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
  // Owner/pipeline-stage/source/campaign can never be set from a public
  // submission even if somehow present on the form definition (defense in
  // depth alongside the GET projection above and provisionDefaultForms
  // never adding them) - each is either the form's own configured default
  // or left unset for this lead, never a visitor's own choice.
  const fields = allFields.filter((f) => !["ownerId", "pipelineStage", "source", "crmCampaignId"].includes(f.systemField ?? ""));

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

  // Branch routing for an anonymous submission - resolved ENTIRELY
  // server-side from the form's own Branch Configuration (specific/all/
  // field, see src/application/formBranch.ts) and the submitted field
  // values. No `auth`, no client-supplied override: a public visitor never
  // controls their own branch assignment directly, only indirectly through
  // an answer like "Which location are you interested in?" that the form's
  // branchFieldMap (set up by an admin who has permission to manage that
  // branch) translates into a branchId. This is the "must be validated on
  // the backend" requirement for public forms, satisfied by construction -
  // there is no other path to a branchId here.
  const branchResolution = await resolveFormSubmissionBranch(form.companyId, formBranchConfigFrom(form), values);
  if (!branchResolution.ok) {
    res.status(branchResolution.status).json({ error: branchResolution.error });
    return;
  }
  const effectiveBranchId = branchResolution.branchId;

  // A public form never collects owner/stage/source/campaign from the
  // visitor (filtered out above) - defaults here come entirely from the
  // form's own configuration; "source" falls back to "public_form" (the
  // fixed, automatic tag for this channel) when the form has no explicit
  // defaultSource override.
  const defaults = applyFormDefaults(form, systemPatch, template);

  try {
    const lead = await insertFormLead({
      companyId: form.companyId,
      branchId: effectiveBranchId,
      crmCampaignId: defaults.crmCampaignId ?? null,
      fullName: systemPatch.fullName,
      phoneNumber: systemPatch.phoneNumber,
      email: systemPatch.email,
      source: defaults.source || "public_form",
      leadType: "digital_lead",
      ownerId: defaults.ownerId,
      pipelineStage: defaults.pipelineStage,
      notes: systemPatch.notes,
      customFields,
    });

    const submission = await createSubmission({
      formId: form.id,
      companyId: form.companyId,
      branchId: effectiveBranchId,
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
