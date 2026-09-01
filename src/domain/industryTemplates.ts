// The industry-template configuration system. This is the single source of
// truth for how the CRM's pipeline, cards, forms and list view look for a
// given company - nothing in the application should ever branch on
// `industry === "real_estate"` (or any other key) outside this file. To add
// a new built-in industry later, add a new entry to INDUSTRY_TEMPLATES; the
// pipeline UI and API read the shape from here and require no other changes.
//
// CRITICAL architecture rule this file exists to enforce ("Do not remove
// existing industry-specific functionality if it is useful. Instead convert
// it into optional templates... The CRM must function without selecting
// one."): every industry template is OPTIONAL, layered on top of Core CRM
// (Leads/Contacts/Campaigns/Pipelines/Tasks/Users), never a fork of it.
// GENERAL_TEMPLATE below is a first-class, always-available template with
// zero industry specialization - the CRM must run correctly on it
// indefinitely, and it is what every new company actually gets by default
// (see companies.industryTemplate's own schema.ts comment) until someone
// deliberately picks something else via Settings -> Business Configuration
// -> Industry/Template. This file must NEVER contain (and no caller of it
// should ever need) `if (industry === "real_estate") { ...CRM A... } else
// if (industry === "solar") { ...CRM B... }`-shaped branching - every
// template, including a company's own "custom" one (see
// CustomTemplateConfig/resolveEffectiveIndustryTemplate below), is just
// DATA (stages/fields/labels) read by the same generic Pipeline/Leads/
// Dashboard/Forms code paths. A caller that finds itself wanting to branch
// on a specific industry key belongs here instead, as a new template field
// or stage flag (isMilestone, isQualified, ... below), never a conditional
// in the caller.
//
// Stage KEYS are chosen to stay compatible with the pipeline stage values
// already stored on existing `leads` rows ("new", "contacted", "qualified",
// "site_visit", "won", "lost") wherever the concept matches, so no data
// migration/backfill is needed for a company already using those stages -
// only the *label* changes. New stages (negotiation, booking, site_survey,
// proposal, installation, ...) get new keys.

export type IndustryKey = "real_estate" | "solar" | "healthcare" | "education" | "ecommerce" | "general" | "custom";

export const INDUSTRY_KEYS: IndustryKey[] = ["real_estate", "solar", "healthcare", "education", "ecommerce", "general", "custom"];

export interface StageDef {
  key: string;
  label: string;
  isInitial?: boolean;
  isClosed?: boolean;
  isWon?: boolean;
  // Marks the stage the dashboard treats as "qualified" for its KPI card
  // and charts - kept as an explicit flag (like isWon/isClosed) rather than
  // matching on the key "qualified" directly, so the dashboard never has to
  // know a stage's literal key.
  isQualified?: boolean;
  // Marks the industry's key mid-funnel milestone stage (site visit for
  // Real Estate, site survey for Solar, ...) that the dashboard surfaces as
  // its own KPI card, labeled via the template's milestoneLabel below.
  isMilestone?: boolean;
}

export type FieldType = "text" | "textarea" | "currency" | "number" | "select";

export const FIELD_TYPES: FieldType[] = ["text", "textarea", "currency", "number", "select"];

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  options?: string[]; // for type: "select"
  unit?: string; // e.g. "kW" - rendered as a suffix
  showOnCard?: boolean; // surfaced as the industry-context line on the Kanban card
}

export interface IndustryTemplate {
  key: IndustryKey;
  name: string;
  description: string;
  pipelineName: string;
  stages: StageDef[];
  fields: FieldDef[]; // industry-specific fields, stored in leads.customFields
  // Plural, dashboard-facing label for the isMilestone stage (e.g. "Site
  // Visits" / "Site Surveys") - distinct from that stage's own singular
  // pipeline-column label ("Site Visit" / "Site Survey"). Empty string when
  // the template has no milestone stage (GENERAL_TEMPLATE, and any custom
  // template that didn't define one) - the dashboard simply omits that KPI
  // card rather than rendering an empty-labeled one.
  milestoneLabel: string;
  // The field list a brand-new company's default Forms (one internal, one
  // public) are auto-provisioned with at onboarding - see
  // provisionDefaultForms() in src/infrastructure/db/repositories/forms.ts.
  // This is the ONLY place industry drives form content; nothing downstream
  // ever branches on industry again - the Forms module only ever reads
  // src/infrastructure/db/schema.ts's forms/formFields rows from here on.
  defaultFormFields: FormFieldTemplateDef[];
}

export type FormFieldType =
  | "text"
  | "textarea"
  | "number"
  | "currency"
  | "email"
  | "phone"
  | "date"
  | "datetime"
  | "select"
  | "radio"
  | "checkbox"
  | "multiselect";

// Runtime-checkable companion to FormFieldType/SystemFieldKey above - a
// type alone can't be validated against an untrusted request body, so the
// Forms API (api/forms/handler.ts) checks incoming field definitions
// against these arrays.
export const FORM_FIELD_TYPES: FormFieldType[] = [
  "text",
  "textarea",
  "number",
  "currency",
  "email",
  "phone",
  "date",
  "datetime",
  "select",
  "radio",
  "checkbox",
  "multiselect",
];

// A system field's leads.* target. "source" | "ownerId" | "pipelineStage" |
// "crmCampaignId" carry no static `options` here - the form renderer always
// resolves their choices at render time from the company's live data (the
// same sources/owners/stages/campaigns the Pipeline board already fetches),
// so a stale static list can never drift from what Pipeline itself offers.
export type SystemFieldKey =
  | "fullName"
  | "phoneNumber"
  | "email"
  | "source"
  | "ownerId"
  | "pipelineStage"
  | "crmCampaignId"
  | "nextFollowUpAt"
  | "notes";

export const SYSTEM_FIELD_KEYS: SystemFieldKey[] = [
  "fullName",
  "phoneNumber",
  "email",
  "source",
  "ownerId",
  "pipelineStage",
  "crmCampaignId",
  "nextFollowUpAt",
  "notes",
];

export interface FormFieldTemplateDef {
  key: string;
  label: string;
  fieldType: FormFieldType;
  mappingType: "system" | "custom";
  systemField?: SystemFieldKey; // required when mappingType === "system"
  options?: string[]; // for select/radio/multiselect custom fields only
  required?: boolean;
  placeholder?: string;
  helpText?: string;
}

// Universal fields every lead/customer has regardless of industry - these
// map to real `leads` columns, not customFields, and are always shown
// first in forms/list/detail views before the industry-specific fields.
export const BASE_FIELD_KEYS = [
  "name",
  "phone",
  "email",
  "source",
  "campaign",
  "owner",
  "stage",
  "nextFollowUp",
  "notes",
] as const;

// Where a lead/customer can originate from. "meta_lead_ads" is set
// automatically by ingestion and is never offered as a manual choice; the
// rest are chosen by a user when manually adding a customer (see "Add
// Customer" / "Not interested -> add to CRM"). MANUAL_LEAD_SOURCE_KEYS is
// the exact picklist for that form.
export const LEAD_SOURCES: Array<{ key: string; label: string }> = [
  { key: "meta_lead_ads", label: "Meta Lead Ads" },
  // Set automatically by a public form submission (see api/forms/handler.ts
  // handlePublicSubmit) - never offered as a manual choice, same as
  // meta_lead_ads above.
  { key: "public_form", label: "Website Form" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "referral", label: "Referral" },
  { key: "phone", label: "Phone" },
  { key: "walk_in", label: "Walk-in" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "website", label: "Website" },
  { key: "manual", label: "Manual" },
  // Added for the guided onboarding wizard's Lead Source step ("How do you
  // get your leads?"), which lists Email as one of its checkboxes - a
  // small, backward-compatible addition (nothing existing changes meaning),
  // also usable as an ordinary manual-entry source going forward.
  { key: "email", label: "Email" },
  { key: "other", label: "Other" },
];

export const MANUAL_LEAD_SOURCE_KEYS = ["referral", "phone", "walk_in", "whatsapp", "website", "email", "other"];

export const MANUAL_LEAD_SOURCES = LEAD_SOURCES.filter((s) => MANUAL_LEAD_SOURCE_KEYS.includes(s.key));

export const LEAD_TYPES = {
  DIGITAL_LEAD: "digital_lead",
  MANUAL_CUSTOMER: "manual_customer",
} as const;

// Shared by every industry's default form - the universal, non-industry
// fields every form starts with (name/phone/email) and ends with
// (source/owner/stage/follow-up/notes), matching exactly what the Add
// Customer / Not Interested modals already collect today (see
// public/pipeline.html customerModalHtml) so a freshly-provisioned default
// form changes nothing about the fields a salesperson sees, only that they
// are now data-driven instead of hard-coded. Exported (not just used
// locally) so buildCustomIndustryTemplate below can wrap a company's own
// custom fields with exactly the same universal envelope every built-in
// template already uses - a custom template's default form is held to the
// same "always start with name/phone/email, always end with source/owner/
// stage/follow-up/notes" contract, never a bespoke one.
export const SYSTEM_FIELDS_LEAD: FormFieldTemplateDef[] = [
  { key: "fullName", label: "Customer Name", fieldType: "text", mappingType: "system", systemField: "fullName", required: true },
  { key: "phoneNumber", label: "Phone", fieldType: "phone", mappingType: "system", systemField: "phoneNumber", required: true },
  { key: "email", label: "Email", fieldType: "email", mappingType: "system", systemField: "email" },
];
export const SYSTEM_FIELDS_CRM: FormFieldTemplateDef[] = [
  { key: "source", label: "Source", fieldType: "select", mappingType: "system", systemField: "source" },
  { key: "ownerId", label: "Owner", fieldType: "select", mappingType: "system", systemField: "ownerId" },
  { key: "pipelineStage", label: "Pipeline Stage", fieldType: "select", mappingType: "system", systemField: "pipelineStage" },
  { key: "nextFollowUpAt", label: "Next Follow-up", fieldType: "date", mappingType: "system", systemField: "nextFollowUpAt" },
  { key: "notes", label: "Requirement / Notes", fieldType: "textarea", mappingType: "system", systemField: "notes" },
];

// Maps a FieldDef (industry-specific pipeline/card field) to the equivalent
// custom FormFieldTemplateDef shape - the exact transform every built-in
// template already applies by hand in its own defaultFormFields (see
// REAL_ESTATE_TEMPLATE/SOLAR_TEMPLATE below); factored out once here so
// buildCustomIndustryTemplate can apply the identical rule to a company's
// own fields instead of duplicating it a third time.
function fieldDefToFormField(field: FieldDef): FormFieldTemplateDef {
  return {
    key: field.key,
    label: field.label,
    fieldType: field.type === "select" ? "select" : field.type,
    mappingType: "custom",
    options: field.options,
  };
}

const REAL_ESTATE_TEMPLATE: IndustryTemplate = {
  key: "real_estate",
  name: "Real Estate",
  description: "Manage property inquiries, site visits, follow-ups and sales.",
  pipelineName: "Property Sales",
  stages: [
    { key: "new", label: "New Inquiry", isInitial: true },
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified", isQualified: true },
    { key: "site_visit", label: "Site Visit", isMilestone: true },
    { key: "negotiation", label: "Negotiation" },
    { key: "booking", label: "Booking" },
    { key: "won", label: "Won", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [
    { key: "property", label: "Property / Project", type: "text" },
    { key: "propertyType", label: "Property Type", type: "select", options: ["Apartment", "Villa", "Plot", "Commercial", "Other"] },
    { key: "budget", label: "Budget", type: "currency", showOnCard: true },
    { key: "location", label: "Preferred Location", type: "text" },
  ],
  milestoneLabel: "Site Visits",
  defaultFormFields: [
    ...SYSTEM_FIELDS_LEAD,
    { key: "property", label: "Property / Project", fieldType: "text", mappingType: "custom" },
    { key: "propertyType", label: "Property Type", fieldType: "select", mappingType: "custom", options: ["Apartment", "Villa", "Plot", "Commercial", "Other"] },
    { key: "budget", label: "Budget", fieldType: "currency", mappingType: "custom" },
    { key: "location", label: "Preferred Location", fieldType: "text", mappingType: "custom" },
    ...SYSTEM_FIELDS_CRM,
  ],
};

const SOLAR_TEMPLATE: IndustryTemplate = {
  key: "solar",
  name: "Solar",
  description: "Manage solar inquiries, site surveys, proposals and installations.",
  pipelineName: "Solar Sales",
  stages: [
    { key: "new", label: "New Inquiry", isInitial: true },
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified", isQualified: true },
    { key: "site_survey", label: "Site Survey", isMilestone: true },
    { key: "proposal", label: "Proposal" },
    { key: "negotiation", label: "Negotiation" },
    { key: "installation", label: "Installation" },
    { key: "won", label: "Won", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [
    { key: "propertyType", label: "Property Type", type: "select", options: ["Residential", "Commercial"] },
    { key: "monthlyBill", label: "Monthly Electricity Bill", type: "currency" },
    { key: "systemCapacity", label: "Required System Capacity", type: "number", unit: "kW", showOnCard: true },
    { key: "location", label: "Location", type: "text" },
  ],
  milestoneLabel: "Site Surveys",
  defaultFormFields: [
    ...SYSTEM_FIELDS_LEAD,
    { key: "propertyType", label: "Property Type", fieldType: "select", mappingType: "custom", options: ["Residential", "Commercial"] },
    { key: "monthlyBill", label: "Monthly Electricity Bill", fieldType: "currency", mappingType: "custom" },
    { key: "systemCapacity", label: "Required System Capacity (kW)", fieldType: "number", mappingType: "custom" },
    { key: "location", label: "Location", fieldType: "text", mappingType: "custom" },
    ...SYSTEM_FIELDS_CRM,
  ],
};

const HEALTHCARE_TEMPLATE: IndustryTemplate = {
  key: "healthcare",
  name: "Healthcare",
  description: "Manage patient inquiries, consultations and treatment follow-ups.",
  pipelineName: "Patient Pipeline",
  stages: [
    { key: "new", label: "New Inquiry", isInitial: true },
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified", isQualified: true },
    { key: "consultation", label: "Consultation Scheduled", isMilestone: true },
    { key: "treatment_plan", label: "Treatment Plan Shared" },
    { key: "won", label: "Enrolled", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [
    { key: "serviceInterest", label: "Service / Procedure Interest", type: "text" },
    { key: "patientType", label: "Patient Type", type: "select", options: ["New Patient", "Existing Patient", "Referral"] },
    { key: "preferredDoctor", label: "Preferred Doctor / Department", type: "text" },
    { key: "insuranceProvider", label: "Insurance Provider", type: "text", showOnCard: true },
  ],
  milestoneLabel: "Consultations",
  defaultFormFields: [
    ...SYSTEM_FIELDS_LEAD,
    { key: "serviceInterest", label: "Service / Procedure Interest", fieldType: "text", mappingType: "custom" },
    { key: "patientType", label: "Patient Type", fieldType: "select", mappingType: "custom", options: ["New Patient", "Existing Patient", "Referral"] },
    { key: "preferredDoctor", label: "Preferred Doctor / Department", fieldType: "text", mappingType: "custom" },
    { key: "insuranceProvider", label: "Insurance Provider", fieldType: "text", mappingType: "custom" },
    ...SYSTEM_FIELDS_CRM,
  ],
};

const EDUCATION_TEMPLATE: IndustryTemplate = {
  key: "education",
  name: "Education",
  description: "Manage admissions inquiries, counseling sessions and enrollments.",
  pipelineName: "Admissions Pipeline",
  stages: [
    { key: "new", label: "New Inquiry", isInitial: true },
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified", isQualified: true },
    { key: "counseling", label: "Counseling Session", isMilestone: true },
    { key: "application", label: "Application Submitted" },
    { key: "won", label: "Enrolled", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [
    { key: "courseInterest", label: "Course / Program Interest", type: "text" },
    { key: "preferredIntake", label: "Preferred Intake", type: "text" },
    { key: "studentType", label: "Student Type", type: "select", options: ["Domestic", "International"] },
    { key: "budget", label: "Budget", type: "currency", showOnCard: true },
  ],
  milestoneLabel: "Counseling Sessions",
  defaultFormFields: [
    ...SYSTEM_FIELDS_LEAD,
    { key: "courseInterest", label: "Course / Program Interest", fieldType: "text", mappingType: "custom" },
    { key: "preferredIntake", label: "Preferred Intake", fieldType: "text", mappingType: "custom" },
    { key: "studentType", label: "Student Type", fieldType: "select", mappingType: "custom", options: ["Domestic", "International"] },
    { key: "budget", label: "Budget", fieldType: "currency", mappingType: "custom" },
    ...SYSTEM_FIELDS_CRM,
  ],
};

const ECOMMERCE_TEMPLATE: IndustryTemplate = {
  key: "ecommerce",
  name: "E-commerce",
  description: "Manage product inquiries, quotes and bulk/wholesale orders.",
  pipelineName: "Sales Pipeline",
  stages: [
    { key: "new", label: "New Inquiry", isInitial: true },
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified", isQualified: true },
    { key: "quote_sent", label: "Quote Sent", isMilestone: true },
    { key: "negotiation", label: "Negotiation" },
    { key: "won", label: "Order Won", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [
    { key: "productInterest", label: "Product / SKU Interest", type: "text" },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "orderValue", label: "Estimated Order Value", type: "currency", showOnCard: true },
    { key: "channel", label: "Sales Channel", type: "select", options: ["Website", "Marketplace", "Wholesale", "Retail"] },
  ],
  milestoneLabel: "Quotes Sent",
  defaultFormFields: [
    ...SYSTEM_FIELDS_LEAD,
    { key: "productInterest", label: "Product / SKU Interest", fieldType: "text", mappingType: "custom" },
    { key: "quantity", label: "Quantity", fieldType: "number", mappingType: "custom" },
    { key: "orderValue", label: "Estimated Order Value", fieldType: "currency", mappingType: "custom" },
    { key: "channel", label: "Sales Channel", fieldType: "select", mappingType: "custom", options: ["Website", "Marketplace", "Wholesale", "Retail"] },
    ...SYSTEM_FIELDS_CRM,
  ],
};

// THE plain Core CRM shape: a generic sales funnel, zero industry-specific
// fields. This is what "no industry template selected" actually means at
// runtime - never Real Estate, never any other named industry. Also what a
// company sees while its own "custom" template is unset/not-yet-defined/
// invalid (see resolveEffectiveIndustryTemplate below), so the CRM is never
// one bad or missing config away from breaking.
export const GENERAL_TEMPLATE: IndustryTemplate = {
  key: "general",
  name: "General",
  description: "A generic sales pipeline with no industry-specific fields - pick an industry template any time from Settings, or stay here indefinitely.",
  pipelineName: "Sales Pipeline",
  stages: [
    { key: "new", label: "New", isInitial: true },
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified", isQualified: true },
    { key: "won", label: "Won", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [],
  milestoneLabel: "",
  defaultFormFields: [...SYSTEM_FIELDS_LEAD, ...SYSTEM_FIELDS_CRM],
};

export const INDUSTRY_TEMPLATES: Record<IndustryKey, IndustryTemplate> = {
  real_estate: REAL_ESTATE_TEMPLATE,
  solar: SOLAR_TEMPLATE,
  healthcare: HEALTHCARE_TEMPLATE,
  education: EDUCATION_TEMPLATE,
  ecommerce: ECOMMERCE_TEMPLATE,
  general: GENERAL_TEMPLATE,
  // "custom" has no fixed shape of its own - a company's real custom shape
  // is built from its own saved CustomTemplateConfig by
  // resolveEffectiveIndustryTemplate below. This entry is only what a
  // caller that reads this map directly (or calls getIndustryTemplate
  // without a customTemplateConfig to hand it) gets: the exact same safe,
  // zero-specialization shape as GENERAL_TEMPLATE, by reference - never a
  // second, divergent definition to keep in sync.
  custom: GENERAL_TEMPLATE,
};

/** Every built-in template a Settings picker should offer, "custom"
 * deliberately excluded (it has no fixed preview shape of its own - see
 * INDUSTRY_TEMPLATES' own comment - the Business Configuration screen
 * offers it as a distinct "build your own" choice instead of a catalog
 * preview). */
export const SELECTABLE_BUILT_IN_TEMPLATES: IndustryTemplate[] = [
  REAL_ESTATE_TEMPLATE,
  SOLAR_TEMPLATE,
  HEALTHCARE_TEMPLATE,
  EDUCATION_TEMPLATE,
  ECOMMERCE_TEMPLATE,
  GENERAL_TEMPLATE,
];

/** Always returns a valid template - falls back to the plain GENERAL
 * template (never a specific named industry - see this file's own header
 * comment) for a null/undefined/unrecognized value, since this is called on
 * every pipeline/dashboard load and "no template chosen" must always be a
 * fully-functional state, not a silent default into one industry's shape.
 * Does NOT resolve a company's own "custom" shape - use
 * resolveEffectiveIndustryTemplate for that (this function alone always
 * returns the same safe placeholder for industryKey === "custom", by
 * design, since it has no access to a customTemplateConfig here). */
export function getIndustryTemplate(industryKey: string | null | undefined): IndustryTemplate {
  return INDUSTRY_TEMPLATES[industryKey as IndustryKey] ?? GENERAL_TEMPLATE;
}

// ---------------------------------------------------------------------------
// Custom (company-authored) templates - Settings -> Business Configuration
// -> Industry/Template -> "Custom". A company defines its own stages/fields
// through that screen's builder UI; this is the ONLY place that data is
// ever turned into a real IndustryTemplate, and it is held to exactly the
// same shape/validation rules a built-in template's author already follows
// by hand above - never a looser, unchecked path.
// ---------------------------------------------------------------------------

const MAX_CUSTOM_STAGES = 20;
const MAX_CUSTOM_FIELDS = 30;
const KEY_PATTERN = /^[a-z][a-z0-9_]{0,49}$/; // same lowercase_snake_case convention every built-in stage/field key already uses

export interface CustomTemplateConfig {
  name: string;
  pipelineName: string;
  stages: StageDef[];
  fields: FieldDef[];
  milestoneLabel?: string;
}

export type CustomTemplateValidationResult = { ok: true; config: CustomTemplateConfig } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Full structural + semantic validation of a company-submitted custom
 * template - the ONE gate between "a person typed something into the
 * Business Configuration builder" and this ever being trusted as a real
 * IndustryTemplate. Never partially accepts a malformed submission (all-or-
 * nothing, like every other validator in this codebase - see
 * formValidation.ts) - a stored row is guaranteed to already be exactly
 * this shape, so a read-time re-check (resolveEffectiveIndustryTemplate)
 * only exists to defend against a hand-edited/legacy row, not to repair a
 * malformed one on the fly.
 */
export function validateCustomTemplateConfig(input: unknown): CustomTemplateValidationResult {
  if (!isPlainObject(input)) return { ok: false, error: "Custom template must be an object." };

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) return { ok: false, error: "Template name is required." };
  if (name.length > 80) return { ok: false, error: "Template name must be 80 characters or fewer." };

  const pipelineName = typeof input.pipelineName === "string" ? input.pipelineName.trim() : "";
  if (!pipelineName) return { ok: false, error: "Pipeline name is required." };
  if (pipelineName.length > 80) return { ok: false, error: "Pipeline name must be 80 characters or fewer." };

  if (!Array.isArray(input.stages) || input.stages.length === 0) {
    return { ok: false, error: "At least one pipeline stage is required." };
  }
  if (input.stages.length > MAX_CUSTOM_STAGES) {
    return { ok: false, error: `A custom template can have at most ${MAX_CUSTOM_STAGES} stages.` };
  }

  const stageKeys = new Set<string>();
  const stages: StageDef[] = [];
  for (const raw of input.stages) {
    if (!isPlainObject(raw)) return { ok: false, error: "Each stage must be an object." };
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    if (!KEY_PATTERN.test(key)) {
      return { ok: false, error: `Stage key "${key || "(empty)"}" must be lowercase letters, numbers, and underscores only, starting with a letter.` };
    }
    if (stageKeys.has(key)) return { ok: false, error: `Stage key "${key}" is used more than once.` };
    stageKeys.add(key);
    if (!label) return { ok: false, error: `Stage "${key}" needs a label.` };
    if (label.length > 60) return { ok: false, error: `Stage label "${label}" must be 60 characters or fewer.` };
    stages.push({
      key,
      label,
      isInitial: raw.isInitial === true,
      isClosed: raw.isClosed === true,
      isWon: raw.isWon === true,
      isQualified: raw.isQualified === true,
      isMilestone: raw.isMilestone === true,
    });
  }
  // Never let a company end up with zero winnable/closeable outcome and no
  // initial stage at all - resolveStageKey/getInitialStageKey both already
  // tolerate this gracefully (fall back to stages[0]), but requiring an
  // explicit isInitial here means the Pipeline board's leftmost column and
  // "new lead" default are always a deliberate choice, not an accident of
  // array order.
  if (!stages.some((s) => s.isInitial)) return { ok: false, error: "Exactly one stage must be marked as the initial stage." };
  if (stages.filter((s) => s.isInitial).length > 1) return { ok: false, error: "Only one stage can be marked as the initial stage." };

  if (input.fields !== undefined && !Array.isArray(input.fields)) {
    return { ok: false, error: "fields must be an array." };
  }
  const rawFields = Array.isArray(input.fields) ? input.fields : [];
  if (rawFields.length > MAX_CUSTOM_FIELDS) {
    return { ok: false, error: `A custom template can have at most ${MAX_CUSTOM_FIELDS} fields.` };
  }
  const fieldKeys = new Set<string>();
  const fields: FieldDef[] = [];
  for (const raw of rawFields) {
    if (!isPlainObject(raw)) return { ok: false, error: "Each field must be an object." };
    const key = typeof raw.key === "string" ? raw.key.trim() : "";
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const type = raw.type;
    if (!KEY_PATTERN.test(key)) {
      return { ok: false, error: `Field key "${key || "(empty)"}" must be lowercase letters, numbers, and underscores only, starting with a letter.` };
    }
    if (fieldKeys.has(key)) return { ok: false, error: `Field key "${key}" is used more than once.` };
    // A field key must never collide with a stage key OR a system field key
    // - both end up namespaced together on the default form (see
    // buildCustomIndustryTemplate) and a collision there would silently
    // shadow one of them.
    if ((SYSTEM_FIELD_KEYS as string[]).includes(key)) return { ok: false, error: `Field key "${key}" is reserved.` };
    fieldKeys.add(key);
    if (!label) return { ok: false, error: `Field "${key}" needs a label.` };
    if (label.length > 60) return { ok: false, error: `Field label "${label}" must be 60 characters or fewer.` };
    if (typeof type !== "string" || !FIELD_TYPES.includes(type as FieldType)) {
      return { ok: false, error: `Field "${key}" has an invalid type - must be one of: ${FIELD_TYPES.join(", ")}.` };
    }
    let options: string[] | undefined;
    if (type === "select") {
      if (!Array.isArray(raw.options) || raw.options.length === 0 || !raw.options.every((o: unknown) => typeof o === "string" && o.trim())) {
        return { ok: false, error: `Field "${key}" is a select field and needs at least one option.` };
      }
      options = raw.options.map((o: string) => o.trim());
    }
    fields.push({
      key,
      label,
      type: type as FieldType,
      options,
      unit: typeof raw.unit === "string" && raw.unit.trim() ? raw.unit.trim() : undefined,
      showOnCard: raw.showOnCard === true,
    });
  }

  const milestoneLabel = typeof input.milestoneLabel === "string" ? input.milestoneLabel.trim().slice(0, 60) : "";

  return { ok: true, config: { name, pipelineName, stages, fields, milestoneLabel: milestoneLabel || undefined } };
}

/** Builds a real IndustryTemplate from an already-validated custom config -
 * the exact same envelope (SYSTEM_FIELDS_LEAD + the company's own fields,
 * mapped via fieldDefToFormField + SYSTEM_FIELDS_CRM) every built-in
 * template's defaultFormFields already uses by hand, so a custom template's
 * default form looks and behaves identically in shape to a built-in one's. */
export function buildCustomIndustryTemplate(config: CustomTemplateConfig): IndustryTemplate {
  return {
    key: "custom",
    name: config.name,
    description: "Custom template - defined in Settings -> Business Configuration.",
    pipelineName: config.pipelineName,
    stages: config.stages,
    fields: config.fields,
    milestoneLabel: config.milestoneLabel ?? "",
    defaultFormFields: [...SYSTEM_FIELDS_LEAD, ...config.fields.map(fieldDefToFormField), ...SYSTEM_FIELDS_CRM],
  };
}

/**
 * THE entry point every caller that has both a company's industryTemplate
 * key AND its customTemplateConfig should use (getIndustryTemplate above
 * stays for the handful of places - onboarding-time default-forms
 * provisioning - that only ever have the key, by construction, because no
 * custom config can exist yet for a company being created this instant).
 * "custom" with no config yet, or a config that fails re-validation (a
 * hand-edited row, or a future stricter validator on an old row), safely
 * falls through to getIndustryTemplate's own "custom" entry - the plain
 * GENERAL_TEMPLATE shape - rather than ever throwing or rendering broken.
 */
export function resolveEffectiveIndustryTemplate(
  industryKey: string | null | undefined,
  customTemplateConfig: unknown,
): IndustryTemplate {
  if (industryKey === "custom" && customTemplateConfig != null) {
    const validated = validateCustomTemplateConfig(customTemplateConfig);
    if (validated.ok) return buildCustomIndustryTemplate(validated.config);
  }
  return getIndustryTemplate(industryKey);
}

export function getInitialStageKey(template: IndustryTemplate): string {
  const initial = template.stages.find((s) => s.isInitial) ?? template.stages[0];
  return initial?.key ?? "new";
}

export function isValidStageKey(template: IndustryTemplate, stageKey: string): boolean {
  return template.stages.some((s) => s.key === stageKey);
}

/** A lead's stored pipelineStage may predate a template change (or belong
 * to a template that no longer defines that key) - fall back to the
 * template's initial stage for display/grouping rather than dropping the
 * record, per the "never lose existing data" rule. */
export function resolveStageKey(template: IndustryTemplate, stageKey: string | null | undefined): string {
  if (stageKey && isValidStageKey(template, stageKey)) return stageKey;
  return getInitialStageKey(template);
}

/** A stage's position in the funnel (0 = first). Used by the dashboard to
 * ask "has this lead reached at least stage X" without ever comparing
 * stage keys directly - callers compare indexes instead. */
export function getStageIndex(template: IndustryTemplate, stageKey: string): number {
  const idx = template.stages.findIndex((s) => s.key === stageKey);
  return idx === -1 ? 0 : idx;
}
