// Drizzle ORM schema - the single source of truth for the Postgres shape.
// Run `npm run db:generate` to produce a migration after changing this file,
// then `npm run db:migrate` to apply it (see package.json / README).
//
// Layout: tenancy + auth (companies, users, sessions, roles) first, then
// campaigns + per-campaign webhook config, then the ingestion pipeline
// tables from the original build (raw_meta_events, leads, ...), now scoped
// to a company/campaign.

import {
  pgSchema,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  bigserial,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Everything lives in its own schema so it never collides with other
// applications sharing the same Neon/Postgres database.
export const crm = pgSchema("crm");

// ---------------------------------------------------------------------------
// Tenancy + auth
// ---------------------------------------------------------------------------

export const companies = crm.table("companies", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  // Free-text business description collected during onboarding (step 1,
  // e.g. "Real Estate Broker") - informational only, unrelated to the
  // structured CRM template below. Left untouched by the dynamic-pipeline
  // work.
  industry: text("industry"),
  // The CRM template key selected at registration (see
  // src/domain/industryTemplates.ts for the fixed catalog - "real_estate" |
  // "solar" today). Drives which pipeline stages, lead/customer fields and
  // list columns the CRM renders for this tenant. Deliberately a separate
  // column from `industry` above - that one is a free-text description,
  // this one is a controlled key the template system indexes by. Never
  // branch on this value directly outside the template lookup - always go
  // through getIndustryTemplate().
  industryTemplate: text("industry_template").notNull().default("real_estate"),
  companySize: text("company_size"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  slugIdx: uniqueIndex("ux_companies_slug").on(t.slug),
}));

/**
 * A role's permission set. `isSystem` marks the built-in "Owner" role every
 * company gets at signup (always holds every permission, cannot be edited
 * or deleted) - everything else is a fully custom role the admin defines
 * from the fixed permission catalog in src/domain/permissions.ts.
 */
export const roles = crm.table("roles", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  permissions: jsonb("permissions").notNull().default(sql`'[]'::jsonb`), // string[] of permission codes
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  companyNameIdx: uniqueIndex("ux_roles_company_name").on(t.companyId, t.name),
  companyIdx: index("ix_roles_company_id").on(t.companyId),
}));

export const users = crm.table("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(),
  status: text("status").notNull().default("active"), // active | disabled
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  emailIdx: uniqueIndex("ux_users_email").on(t.email),
  companyIdx: index("ix_users_company_id").on(t.companyId),
}));

/**
 * One row per issued refresh token, so a session can be individually
 * revoked (logout, "sign out everywhere", admin-disables-user) without
 * waiting for a short-lived access token to expire. The refresh token
 * itself is never stored - only its hash, same principle as a password.
 */
export const sessions = crm.table("sessions", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  refreshTokenHash: text("refresh_token_hash").notNull(),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (t) => ({
  userIdx: index("ix_sessions_user_id").on(t.userId),
}));

// ---------------------------------------------------------------------------
// Branches (multi-branch support)
// ---------------------------------------------------------------------------
//
// A branch is a location/office INSIDE one company - never a second tenant.
// Every branch-scoped row still carries its own company_id (leads.companyId,
// campaigns.companyId, ...) alongside the new nullable branch_id below, so
// tenant isolation is never weakened: a query always filters on company_id
// first, branch_id second. branch_id is nullable everywhere on purpose - a
// company that never creates a branch (or a row created before this feature
// existed) keeps working exactly as before, reading as "company-wide /
// unassigned", not as broken data requiring a backfill migration.

export const branches = crm.table("branches", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  // Short human-chosen identifier (e.g. "MUM01") - unique per company, not
  // globally, since two different companies commonly reuse the same codes.
  code: text("code").notNull(),
  address: text("address"),
  city: text("city"),
  state: text("state"),
  // The user who manages this branch. Nullable + ON DELETE SET NULL - a
  // branch must never be deleted just because its manager account is later
  // removed/disabled.
  managerId: uuid("manager_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull().default("active"), // active | inactive
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  companyIdx: index("ix_branches_company_id").on(t.companyId),
  companyCodeIdx: uniqueIndex("ux_branches_company_code").on(t.companyId, t.code),
  managerIdx: index("ix_branches_manager_id").on(t.managerId),
}));

/**
 * A user's membership in a branch - many-to-many, so one user (e.g. a
 * regional manager) can belong to more than one branch of the same company.
 * `role` here is a lightweight, branch-local label (e.g. "manager" | "staff")
 * shown in branch rosters - it is deliberately NOT a foreign key into the
 * company-wide `roles`/permissions table above: permissions stay exactly
 * where they already are (users.roleId), this just says which branch(es) a
 * user is attached to and whether they're that branch's primary member.
 */
export const branchUsers = crm.table("branch_users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  branchId: uuid("branch_id").notNull().references(() => branches.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("staff"), // free-text branch-local label, e.g. "manager" | "staff"
  // Whether this is the user's home/default branch (used to pick which
  // branch a newly created lead/campaign/form defaults to, and which board
  // the Pipeline page opens on). At most one true row per user - enforced
  // below by a partial unique index rather than at the application layer
  // alone, so it can never drift even under concurrent writes.
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  branchIdx: index("ix_branch_users_branch_id").on(t.branchId),
  userIdx: index("ix_branch_users_user_id").on(t.userId),
  branchUserIdx: uniqueIndex("ux_branch_users_branch_user").on(t.branchId, t.userId),
  onePrimaryPerUserIdx: uniqueIndex("ux_branch_users_one_primary_per_user").on(t.userId).where(sql`is_primary = true`),
}));

// ---------------------------------------------------------------------------
// Campaigns + per-campaign Meta webhook configuration
// ---------------------------------------------------------------------------

export const campaigns = crm.table("campaigns", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  // Nullable - null means "company-wide" (visible/usable from every branch),
  // matching every other branchId column added for multi-branch support.
  // ON DELETE SET NULL: deleting a branch demotes its campaigns to
  // company-wide rather than cascading the delete onto them.
  branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("facebook"), // facebook | instagram | both
  status: text("status").notNull().default("draft"), // draft | active | paused | archived
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  companyIdx: index("ix_campaigns_company_id").on(t.companyId),
  statusIdx: index("ix_campaigns_status").on(t.status),
  branchIdx: index("ix_campaigns_branch_id").on(t.branchId),
}));

/**
 * Every campaign gets its own Meta app secret / access token / verify
 * token, because different campaigns can belong to different Meta
 * apps/pages. `slug` is the unguessable routing segment used in the actual
 * webhook URL registered with Meta - see api/webhooks/meta/[slug].ts -
 * it is NOT the verify token, so it can be safely logged/displayed while
 * the verify token and secrets stay masked. Secrets are encrypted at rest
 * (see src/infrastructure/security/encryption.ts), never stored in plaintext.
 */
export const webhookConfigs = crm.table("webhook_configs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: uuid("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(),
  verifyToken: text("verify_token").notNull(),
  appSecretEncrypted: text("app_secret_encrypted").notNull(),
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  pageId: text("page_id"),
  formIds: jsonb("form_ids").notNull().default(sql`'[]'::jsonb`), // string[]
  status: text("status").notNull().default("pending"), // pending | verified | active | error
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  campaignIdx: uniqueIndex("ux_webhook_configs_campaign_id").on(t.campaignId),
  slugIdx: uniqueIndex("ux_webhook_configs_slug").on(t.slug),
}));

// ---------------------------------------------------------------------------
// Ingestion pipeline (from the original build, now tenant-scoped)
// ---------------------------------------------------------------------------

export const rawMetaEvents = crm.table(
  "raw_meta_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
    objectType: text("object_type").notNull(), // "page" | "instagram"
    rawPayload: jsonb("raw_payload").notNull(),
    signatureHeader: text("signature_header"),
    metaLeadId: text("meta_lead_id"),
    pageId: text("page_id"),
    formId: text("form_id"),
    status: text("status").notNull().default("received"),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
    enqueueError: text("enqueue_error"),
    qstashMessageId: text("qstash_message_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    leadId: uuid("lead_id"),
  },
  (t) => ({
    metaLeadIdIdx: index("ix_raw_meta_events_meta_lead_id").on(t.metaLeadId),
    statusReceivedIdx: index("ix_raw_meta_events_status_received_at").on(t.status, t.receivedAt),
    campaignIdx: index("ix_raw_meta_events_campaign_id").on(t.campaignId),
  }),
);

export const leads = crm.table(
  "leads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    // Nullable - null means "company-wide / unassigned". Set automatically
    // at write time from the owning campaign's branch (Meta ingestion,
    // reconciliation) or the submitting form's branch (Add Customer /
    // public form); a manually-created customer can also be branch-tagged
    // directly. ON DELETE SET NULL so archiving/deleting a branch never
    // deletes its leads.
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    // Our internal campaign record - distinct from `campaignId` below, which
    // is Meta's OWN ad-campaign id/name from the Graph API response.
    crmCampaignId: uuid("crm_campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),

    // THE idempotency backstop. See ux_leads_meta_lead_id below - no two rows
    // can ever share a Meta Lead ID, regardless of how many times a webhook
    // fires or a QStash message is redelivered.
    metaLeadId: text("meta_lead_id").notNull(),

    // Meta-specific - null for manually-created customers (see leadType
    // below), which have no page/form/platform to speak of.
    platform: text("platform"),
    pageId: text("page_id"),
    formId: text("form_id"),
    formName: text("form_name"),

    adId: text("ad_id"),
    adName: text("ad_name"),
    adSetId: text("ad_set_id"),
    adSetName: text("ad_set_name"),
    campaignId: text("campaign_id"), // Meta's ad campaign id (not ours - see crmCampaignId)
    campaignName: text("campaign_name"),

    fullName: text("full_name"),
    email: text("email"),
    phoneNumber: text("phone_number"),

    formResponses: jsonb("form_responses").notNull().default(sql`'[]'::jsonb`),

    // Where this record originated - preserved for the life of the record,
    // even after a digital lead is worked into a customer. See
    // src/domain/industryTemplates.ts LEAD_SOURCES for the fixed catalog
    // ("meta_lead_ads" | "facebook" | "instagram" | "website" | "referral" |
    // "phone" | "walk_in" | "whatsapp" | "manual" | "other").
    source: text("source").notNull().default("meta_lead_ads"),
    // DIGITAL_LEAD - arrived automatically via a connected campaign.
    // MANUAL_CUSTOMER - entered directly by a salesperson (see "Add
    // customer" / "Not interested -> add customer to CRM"). Distinguishes
    // origin independently of `source` above so the UI never has to guess.
    leadType: text("lead_type").notNull().default("digital_lead"),
    // Assigned salesperson - null until explicitly assigned.
    ownerId: uuid("owner_id").references(() => users.id, { onDelete: "set null" }),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    notes: text("notes"),
    // Industry-template-defined field values, keyed by field.key (e.g.
    // {"budget": "7500000", "location": "Bandra"} for Real Estate, or
    // {"system_capacity": "5", "monthly_bill": "4500"} for Solar). The UI
    // renders these dynamically from the company's active template -
    // nothing here is hard-coded per industry.
    customFields: jsonb("custom_fields").notNull().default(sql`'{}'::jsonb`),

    metaCreatedAt: timestamp("meta_created_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("pending"),

    // CRM pipeline stage key - independent of ingestion `status` above, and
    // validated at the application layer against the company's active
    // industry template (see src/domain/industryTemplates.ts) rather than a
    // fixed enum, since valid stages differ per industry.
    pipelineStage: text("pipeline_stage").notNull().default("new"),

    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    recoveredByReconciliation: boolean("recovered_by_reconciliation").notNull().default(false),

    // Null for manually-created customers - there is no raw Meta event
    // behind them.
    rawEventId: uuid("raw_event_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    uxMetaLeadId: uniqueIndex("ux_leads_meta_lead_id").on(t.metaLeadId),
    statusIdx: index("ix_leads_status").on(t.status),
    formIdx: index("ix_leads_form_id").on(t.formId),
    campaignIdx: index("ix_leads_campaign_id").on(t.campaignId),
    createdAtIdx: index("ix_leads_created_at").on(t.createdAt),
    crmCampaignIdx: index("ix_leads_crm_campaign_id").on(t.crmCampaignId),
    pipelineStageIdx: index("ix_leads_pipeline_stage").on(t.pipelineStage),
    leadTypeIdx: index("ix_leads_lead_type").on(t.leadType),
    ownerIdx: index("ix_leads_owner_id").on(t.ownerId),
    branchIdx: index("ix_leads_branch_id").on(t.branchId),
    companyBranchIdx: index("ix_leads_company_id_branch_id").on(t.companyId, t.branchId),
  }),
);

export const leadProcessingLog = crm.table(
  "lead_processing_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    leadId: uuid("lead_id"),
    rawEventId: uuid("raw_event_id"),
    eventType: text("event_type").notNull(), // Enqueued, RetryScheduled, Processed, DeadLettered, Reconciled, Duplicate
    detail: text("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index("ix_lead_processing_log_lead_id").on(t.leadId),
    occurredIdx: index("ix_lead_processing_log_occurred_at").on(t.occurredAt),
  }),
);

// ---------------------------------------------------------------------------
// Forms & Lead Capture
// ---------------------------------------------------------------------------
//
// A "form" is a company-defined, industry-agnostic field list - never a
// per-industry component (there is no RealEstateForm/SolarForm anywhere in
// this codebase; see src/domain/industryTemplates.ts). Two form `type`s
// share this exact same shape:
//   "internal" - used by the CRM's own "Add Customer" / "Not interested ->
//                Add to CRM" flows on the Pipeline page.
//   "public"   - published to an unguessable public URL (see `publicKey`)
//                for external lead capture (embeds, landing pages, ...).
// Every field on a form is EITHER a system field (maps to a real `leads`
// column, e.g. fullName/phoneNumber/pipelineStage) OR a custom field (maps
// into `leads.customFields` jsonb by key) - see formFields.mappingType. This
// is the same system-vs-custom split the rest of the app already uses
// (BASE_FIELD_KEYS vs template.fields in industryTemplates.ts); forms just
// let a company additionally control the ORDER, labels, requiredness and
// which of those fields actually appear on a given form.

export const forms = crm.table(
  "forms",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Nullable - null means the form is company-wide (usable/visible from
    // every branch, and from the "no branch selected" default view). Set,
    // it scopes the form (and the "default Add Customer form" invariant
    // below) to just that one branch. Only authoritative when
    // branchMode="specific" below - kept as the actual FK column (rather
    // than folding it into branchFieldMap) so every existing branch-scoping
    // query (listForms/listSubmissions/getDefaultInternalForm, all written
    // before Branch Configuration existed) keeps working unchanged for
    // "specific" and "all" forms with zero modification.
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    // Branch Configuration - how a lead captured through this form is
    // assigned a branch at submission time (see
    // src/application/formBranch.ts, the one place that turns this into an
    // actual branchId for both the internal and public submit paths):
    //   "specific" - always branchId above (or company-wide if that's null).
    //   "all"      - always company-wide (branchId is ignored/cleared).
    //   "field"    - resolved per-submission from the value of the form
    //                field named by branchFieldKey, mapped through
    //                branchFieldMap. Lets one public form (e.g. "Which
    //                location are you interested in?") route different
    //                submitters to different branches automatically.
    // No DB-level enum - validated at the application layer in
    // src/application/formBranch.ts, same convention as forms.status/type.
    branchMode: text("branch_mode").notNull().default("specific"),
    // Only meaningful when branchMode="field" - the key of a select/radio
    // field already on this form whose submitted value determines the
    // branch. Null for "specific"/"all".
    branchFieldKey: text("branch_field_key"),
    // Only meaningful when branchMode="field" - maps that field's option
    // value (e.g. "Ahmedabad") to a branchId. Every value is validated at
    // save time (src/application/formBranch.ts validateBranchConfig) against
    // both tenant isolation and the saving user's own branch access, so a
    // form can never be configured to route into a branch its builder isn't
    // permitted to manage.
    branchFieldMap: jsonb("branch_field_map").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    name: text("name").notNull(),
    description: text("description"),
    // "internal" | "public" - see comment above.
    type: text("type").notNull().default("internal"),
    // "draft" | "published" | "archived". A draft is only visible/usable in
    // the builder; only a published form can be used by Add Customer / Not
    // Interested, or (for type=public) reached at its public URL. Archiving
    // never deletes the form or its past submissions - see formSubmissions
    // below for why old submissions must always stay readable.
    status: text("status").notNull().default("draft"),
    // Unguessable routing key for a published public form's URL
    // (/form.html?key=...), same pattern as webhookConfigs.slug - safe to
    // display/share, NOT a secret credential. Null for internal forms and
    // for public forms that have never been published.
    publicKey: text("public_key"),
    // Bumped every time this form's field list changes after its first
    // publish. Each submission stores the schemaVersion it was submitted
    // against (see formSubmissions.schemaVersion) plus a full field-list
    // snapshot, so editing a form later can never make an old submission
    // unreadable or mis-attributed to the wrong fields.
    schemaVersion: integer("schema_version").notNull().default(1),
    // At most one form per (companyId, branchId, type="internal") should
    // have this set - the form Pipeline's "Add Customer" / "Not interested
    // -> Add to CRM" load automatically for that branch (or company-wide,
    // when branchId is null). Enforced at the application layer
    // (setDefaultInternalForm), not a DB constraint, so a company is never
    // left with zero usable forms mid-transition.
    isDefault: boolean("is_default").notNull().default(false),
    // ---- Form-level CRM defaults -------------------------------------
    // Applied to every lead this form creates, independent of whether the
    // form also exposes a corresponding fillable field for it - a company
    // can pin a landing-page form to one campaign/stage/owner without
    // asking every visitor (or salesperson) to choose. When the form DOES
    // include the matching system field (e.g. a pipelineStage dropdown) and
    // a value is actually submitted, the submitted value wins - see
    // api/forms/handler.ts resolveSubmission/applyFormDefaults for the exact
    // precedence. Pipeline itself is never stored here - it's derived
    // display-only from the company's industry template (one pipeline per
    // company, see src/domain/industryTemplates.ts), never a per-form choice.
    defaultPipelineStage: text("default_pipeline_stage"),
    defaultCrmCampaignId: uuid("default_crm_campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    defaultSource: text("default_source"),
    defaultOwnerId: uuid("default_owner_id").references(() => users.id, { onDelete: "set null" }),
    // Free-form per-form UI settings (e.g. successMessage, redirectUrl,
    // submitButtonLabel) - deliberately jsonb rather than new columns per
    // setting, consistent with leads.customFields.
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => ({
    companyIdx: index("ix_forms_company_id").on(t.companyId),
    publicKeyIdx: uniqueIndex("ux_forms_public_key").on(t.publicKey),
    companyTypeIdx: index("ix_forms_company_id_type").on(t.companyId, t.type),
    branchIdx: index("ix_forms_branch_id").on(t.branchId),
  }),
);

export const formFields = crm.table(
  "form_fields",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    formId: uuid("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
    // Stable identifier for this field within the form. For a system field
    // this is one of BASE_FIELD_KEYS-ish leads columns (see systemField
    // below, which carries the actual column name); for a custom field this
    // IS the key written into leads.customFields.
    key: text("key").notNull(),
    label: text("label").notNull(),
    // text | textarea | number | currency | email | phone | date | datetime
    // | select | radio | checkbox | multiselect
    fieldType: text("field_type").notNull(),
    // "system" | "custom" - see the forms table comment above.
    mappingType: text("mapping_type").notNull().default("custom"),
    // Only set when mappingType="system" - the exact leads.* column (or
    // "customFields" pseudo-target is never used here, that's the "custom"
    // path) this field writes to: fullName | phoneNumber | email | source |
    // crmCampaignId | ownerId | pipelineStage | nextFollowUpAt | notes.
    systemField: text("system_field"),
    options: jsonb("options").$type<string[]>().notNull().default(sql`'[]'::jsonb`), // for select/radio/multiselect
    placeholder: text("placeholder"),
    helpText: text("help_text"),
    defaultValue: text("default_value"),
    required: boolean("required").notNull().default(false),
    position: integer("position").notNull().default(0),
    // Basic conditional visibility: { fieldKey, operator: "equals"|"not_equals", value }
    // - shows/hides this field client-side based on another field's current
    // value. Null means always shown. Never enforced as a hard requirement
    // server-side (a hidden field is simply optional), so a stale rule can
    // never block a legitimate submission.
    conditional: jsonb("conditional").$type<{ fieldKey: string; operator: string; value: string }>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    formIdx: index("ix_form_fields_form_id").on(t.formId),
    formPositionIdx: index("ix_form_fields_form_id_position").on(t.formId, t.position),
  }),
);

export const formSubmissions = crm.table(
  "form_submissions",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    formId: uuid("form_id").notNull().references(() => forms.id, { onDelete: "cascade" }),
    // Denormalized alongside formId so every tenant-isolation check on this
    // table can filter on company_id directly, without a join back through
    // forms - the same defense-in-depth pattern leads.companyId already
    // uses relative to crmCampaignId.
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Denormalized from the form the same way companyId is - the branch (if
    // any) the submitted form belonged to at submission time.
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    // The Lead/Customer record this submission created or enriched. Null
    // only in the rare case a submission was received but Lead creation
    // itself failed server-side (status will be "rejected" then).
    leadId: uuid("lead_id").references(() => leads.id, { onDelete: "set null" }),
    // The form's schemaVersion at the moment of this submission - together
    // with fieldsSnapshot below, guarantees this submission stays fully
    // readable (correct labels/types/order) even after the form is edited
    // or fields are removed later.
    schemaVersion: integer("schema_version").notNull(),
    fieldsSnapshot: jsonb("fields_snapshot").$type<unknown[]>().notNull(),
    values: jsonb("values").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`), // { [field.key]: submittedValue }
    // "internal" | "public" | "manual_prefill" - how this submission was
    // captured, independent of the form's own type (an internal form can
    // still be filled by a salesperson working a public-form lead).
    channel: text("channel").notNull().default("internal"),
    // Only meaningful for public submissions - basic abuse-visibility, never
    // used for anything beyond that.
    submitterIp: text("submitter_ip"),
    submitterUserAgent: text("submitter_user_agent"),
    status: text("status").notNull().default("received"), // received | rejected
    rejectionReason: text("rejection_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    formIdx: index("ix_form_submissions_form_id").on(t.formId),
    companyIdx: index("ix_form_submissions_company_id").on(t.companyId),
    createdAtIdx: index("ix_form_submissions_created_at").on(t.createdAt),
    branchIdx: index("ix_form_submissions_branch_id").on(t.branchId),
  }),
);

export const reconciliationRuns = crm.table("reconciliation_runs", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  formsScanned: integer("forms_scanned").notNull().default(0),
  metaLeadsSeen: integer("meta_leads_seen").notNull().default(0),
  missingLeadsFound: integer("missing_leads_found").notNull().default(0),
  missingLeadsRecovered: integer("missing_leads_recovered").notNull().default(0),
  errors: integer("errors").notNull().default(0),
  notes: text("notes"),
});
