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
// Campaigns + per-campaign Meta webhook configuration
// ---------------------------------------------------------------------------

export const campaigns = crm.table("campaigns", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  platform: text("platform").notNull().default("facebook"), // facebook | instagram | both
  status: text("status").notNull().default("draft"), // draft | active | paused | archived
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  companyIdx: index("ix_campaigns_company_id").on(t.companyId),
  statusIdx: index("ix_campaigns_status").on(t.status),
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
