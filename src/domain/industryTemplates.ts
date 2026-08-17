// The industry-template configuration system. This is the single source of
// truth for how the CRM's pipeline, cards, forms and list view look for a
// given company - nothing in the application should ever branch on
// `industry === "real_estate"` (or any other key) outside this file. To add
// a new industry later (Insurance, Education, Healthcare, ...), add a new
// entry to INDUSTRY_TEMPLATES; the pipeline UI and API read the shape from
// here and require no other changes.
//
// Stage KEYS are chosen to stay compatible with the pipeline stage values
// already stored on existing `leads` rows ("new", "contacted", "qualified",
// "site_visit", "won", "lost") wherever the concept matches, so no data
// migration/backfill is needed for a company already using those stages -
// only the *label* changes. New stages (negotiation, booking, site_survey,
// proposal, installation) get new keys.

export type IndustryKey = "real_estate" | "solar";

export const INDUSTRY_KEYS: IndustryKey[] = ["real_estate", "solar"];

export interface StageDef {
  key: string;
  label: string;
  isInitial?: boolean;
  isClosed?: boolean;
  isWon?: boolean;
}

export type FieldType = "text" | "textarea" | "currency" | "number" | "select";

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
// automatically by ingestion; the rest are chosen by a user when manually
// adding a customer (see "Add Customer" / "Not interested -> add to CRM").
export const LEAD_SOURCES: Array<{ key: string; label: string }> = [
  { key: "meta_lead_ads", label: "Meta Lead Ads" },
  { key: "facebook", label: "Facebook" },
  { key: "instagram", label: "Instagram" },
  { key: "website", label: "Website" },
  { key: "referral", label: "Referral" },
  { key: "phone", label: "Phone" },
  { key: "walk_in", label: "Walk-in" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "manual", label: "Manual" },
  { key: "other", label: "Other" },
];

export const LEAD_TYPES = {
  DIGITAL_LEAD: "digital_lead",
  MANUAL_CUSTOMER: "manual_customer",
} as const;

const REAL_ESTATE_TEMPLATE: IndustryTemplate = {
  key: "real_estate",
  name: "Real Estate",
  description: "Manage property inquiries, site visits, follow-ups and sales.",
  pipelineName: "Property Sales",
  stages: [
    { key: "new", label: "New Inquiry", isInitial: true },
    { key: "contacted", label: "Contacted" },
    { key: "qualified", label: "Qualified" },
    { key: "site_visit", label: "Site Visit" },
    { key: "negotiation", label: "Negotiation" },
    { key: "booking", label: "Booking" },
    { key: "won", label: "Won", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [
    { key: "property", label: "Property / Project", type: "text" },
    { key: "budget", label: "Budget", type: "currency", showOnCard: true },
    { key: "location", label: "Location", type: "text" },
    { key: "configuration", label: "Configuration", type: "text" }, // e.g. "2BHK"
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
    { key: "qualified", label: "Qualified" },
    { key: "site_survey", label: "Site Survey" },
    { key: "proposal", label: "Proposal" },
    { key: "negotiation", label: "Negotiation" },
    { key: "installation", label: "Installation" },
    { key: "won", label: "Won", isClosed: true, isWon: true },
    { key: "lost", label: "Lost", isClosed: true },
  ],
  fields: [
    { key: "propertyType", label: "Property Type", type: "select", options: ["Residential", "Commercial"] },
    { key: "monthlyBill", label: "Monthly Electricity Bill", type: "currency" },
    { key: "systemCapacity", label: "System Capacity", type: "number", unit: "kW", showOnCard: true },
    { key: "location", label: "Location", type: "text" },
  ],
};

export const INDUSTRY_TEMPLATES: Record<IndustryKey, IndustryTemplate> = {
  real_estate: REAL_ESTATE_TEMPLATE,
  solar: SOLAR_TEMPLATE,
};

/** Always returns a valid template - falls back to Real Estate for an
 * unrecognized/legacy value rather than throwing, since this is called on
 * every pipeline/dashboard load. */
export function getIndustryTemplate(industryKey: string | null | undefined): IndustryTemplate {
  return INDUSTRY_TEMPLATES[industryKey as IndustryKey] ?? REAL_ESTATE_TEMPLATE;
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
