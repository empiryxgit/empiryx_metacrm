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
  check,
  type AnyPgColumn,
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
  // The CRM template key (see src/domain/industryTemplates.ts for the fixed
  // catalog - real_estate | solar | healthcare | education | ecommerce |
  // general | custom). Drives which pipeline stages, lead/customer fields
  // and list columns the CRM renders for this tenant - but is deliberately
  // OPTIONAL in spirit even though the column itself is NOT NULL: "general"
  // (the default below) means "no industry specialization," i.e. the plain
  // Core CRM (Leads/Contacts/Campaigns/Pipelines/Tasks/Users) with none of
  // Fields/Pipeline/Workflows customized - a company must be able to run
  // indefinitely on "general" and never be forced to pick a named industry.
  // Settable any time via Settings -> Business Configuration -> Industry/
  // Template (see api/onboarding/handler.ts's handleBusinessConfig), not
  // just at registration. Deliberately a separate column from `industry`
  // above - that one is a free-text description, this one is a controlled
  // key the template system indexes by. Never branch on this value
  // directly outside the template lookup - always go through
  // resolveEffectiveIndustryTemplate() (or getIndustryTemplate() when no
  // customTemplateConfig is available/relevant) in
  // src/domain/industryTemplates.ts.
  industryTemplate: text("industry_template").notNull().default("general"),
  // Only meaningful when industryTemplate = "custom" - a company-authored
  // IndustryTemplate shape (CustomTemplateConfig in
  // src/domain/industryTemplates.ts: name, pipelineName, stages, fields,
  // milestoneLabel), built through the Business Configuration screen's
  // stage/field builder rather than picked from the fixed catalog. Nullable
  // and independent of industryTemplate itself (switching to a built-in
  // template and back to "custom" never loses a saved draft) - always
  // re-validated via validateCustomTemplateConfig() before being trusted for
  // anything, both on save and on every read (a hand-edited or
  // since-invalidated row must never crash the CRM, just fall back to the
  // plain generic template exactly like having none at all).
  customTemplateConfig: jsonb("custom_template_config"),
  // Is this tenant a single individual, or an agency/team acting on behalf
  // of clients - see src/domain/accountType.ts for the fixed catalog
  // (AccountType/ACCOUNT_TYPE_KEYS), the same union-type-plus-array
  // convention industryTemplate's own catalog uses. An organization-level
  // attribute like industryTemplate/companySize/timezone, deliberately NOT
  // placed on `users` - two teammates in the same company can never
  // disagree about which kind of company they're both in. NOT NULL with a
  // default (not nullable) for the same reason industryTemplate is: every
  // company, including ones created before this column existed, must
  // always resolve to a concrete value without a backfill migration -
  // never branch on this column's raw string outside resolveAccountType()/
  // ACCOUNT_TYPE_CATALOG.
  accountType: text("account_type").notNull().default("individual"),
  // The organization's own lifecycle - independent of any one user's
  // users.status (a company can be suspended while its users' individual
  // accounts stay "active"). Not a DB enum, same convention as every other
  // status column in this schema ("active" | "suspended" today). NOT
  // enforced anywhere yet (no login/API gate checks this) - the column
  // exists so that gate can be added later without a further migration;
  // every existing company defaults to "active", identical to how it
  // behaved before this column existed.
  status: text("status").notNull().default("active"),
  // Which user caused this organization to exist. Null for the ordinary
  // self-registration path (see registerCompanyAndOwner in
  // src/application/auth.ts) - the owner user doesn't exist yet at the
  // moment the company row is inserted, so this is best-effort backfilled
  // via setCompanyCreatedBy() right after that user is created; a failure
  // there never blocks registration itself, same "best-effort, never
  // blocking" posture as provisionDefaultForms in that same function.
  // Populated going forward for the one path where a creator genuinely
  // predates the company: an agency company creating a CLIENT company on
  // a client's behalf (see agencyClients below) - createdBy there is
  // the agency user who created the link. ON DELETE SET NULL: the creating
  // user being removed later must never delete the organization they created.
  // Explicit AnyPgColumn return type (rather than plain inference) on
  // purpose - companies <-> users is a genuine circular reference
  // (users.companyId already points back at companies.id), which trips
  // TypeScript's circular-inference check unless the callback's return type
  // is annotated. This is Drizzle's own documented pattern for a circular
  // FK, not a workaround specific to this codebase.
  createdBy: uuid("created_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
  companySize: text("company_size"),
  timezone: text("timezone").notNull().default("Asia/Kolkata"),
  // --- Guided first-time onboarding (Individual users only - see
  // src/domain/onboarding.ts) -------------------------------------------
  // Same "plain text, validated at the application layer" convention as
  // accountType/industryTemplate/status above - no DB-level CHECK
  // constraint restricting the value, exactly like those sibling columns;
  // resolveOnboardingStatus()/resolveOnboardingStep() in
  // src/domain/onboarding.ts are the one place that ever trusts a raw
  // value here. Defaults to "COMPLETED" - not "NOT_STARTED" - because this
  // column is landing on a codebase where EVERY existing row already has
  // onboardingCompletedAt set (agency registration, agency-onboarded
  // clients, and today's individual registration all call
  // completeOnboarding() unconditionally) - "COMPLETED" is the value that
  // is actually already true for every pre-existing row, so this migration
  // introduces the new column without creating a single row where
  // onboarding_status and onboarding_completed_at disagree. Nothing yet
  // sets this to "NOT_STARTED" - see this phase's own report for why that
  // wiring is deliberately deferred to the phase that creates the
  // /onboarding route itself.
  onboardingStatus: text("onboarding_status").notNull().default("COMPLETED"),
  // The wizard step an IN_PROGRESS company should resume at - one of
  // ONBOARDING_STEPS in src/domain/onboarding.ts, or null whenever status
  // is NOT_STARTED (no step chosen yet) or COMPLETED (nothing left to
  // resume). This single field is deliberately both "where to resume" AND
  // "how far the user is allowed to jump ahead" - see
  // isOnboardingStepUnlocked()'s own comment: reviewing an earlier,
  // already-completed step is a read-only navigation that never moves this
  // pointer backward, so a second field to separately track "furthest step
  // reached" is not needed.
  onboardingStep: text("onboarding_step"),
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  // --- Guided onboarding step data (Individual users only) --------------
  // A company's public website - collected on the wizard's Business Profile
  // step, Optional per that step's own spec ("Website (Optional)"). Never
  // existed anywhere before this feature; nothing outside onboarding reads
  // it today, but it belongs on the company profile itself (same tier as
  // industry/companySize/timezone), not a one-off onboarding-only table.
  website: text("website"),
  // "What would you like to call your leads?" (CRM Basics step) - a
  // display-label preference, NOT a data-model change: leads.pipelineStage/
  // leads table columns are entirely unaffected, and only the NEW surfaces
  // this feature introduces (the onboarding wizard's own later screens, the
  // dashboard empty-state copy, the setup checklist) actually read this
  // value - see PHASE 7's own scoping note in the onboarding wizard code for
  // why this is intentionally NOT threaded through the rest of the
  // application's existing "Lead" copy (settings/pipeline/dashboard tables,
  // etc.) - that would be an unbounded, separate rename project, not
  // something a first-run wizard should take on. Defaults to "Lead", the
  // term already used everywhere else in the app.
  leadTerminology: text("lead_terminology").notNull().default("Lead"),
  // Which channels this company told the onboarding wizard it currently
  // uses (Lead Source step) - a plain JSON array of LEAD_SOURCES keys (see
  // src/domain/industryTemplates.ts), e.g. ["facebook","instagram","phone"].
  // Purely informational/routing signal: it decides whether the wizard's
  // Meta Connection step is shown at all (only when "facebook" or
  // "instagram" is present) and powers the dashboard's "Connect Lead
  // Source" empty-state CTA - it is NEVER used to gate or filter real lead
  // records, which continue to carry their own independent `leads.source`
  // value exactly as today. Null until the step is ever reached; an empty
  // array is a valid, deliberate "none selected" answer (the step is
  // skippable - see PHASE 9's "I'll Set This Up Later").
  selectedLeadSources: jsonb("selected_lead_sources"),
  // --- Campaign/client capacity billing (overage on top of the plan's
  // base allowance - see src/domain/billing.ts for the fixed catalog of
  // base limits and overage prices these columns are checked against, and
  // src/application/billing.ts for how a payment turns into these numbers
  // going up) ---------------------------------------------------------
  // How many EXTRA campaign slots this company has paid for, beyond its
  // plan's base allowance (baseCampaignLimit() in src/domain/billing.ts -
  // 5 for Individual, 10 for Agency). For an agency, this lives on the
  // AGENCY's own company row and applies to the pooled cross-client limit
  // (see getCampaignLimitStatus's own comment) - a client company's row
  // never carries its own extra slots, since a client never buys a plan of
  // its own (see addClientOrganization's doc comment in
  // src/application/agency.ts). Zero until the first overage purchase;
  // reverts to zero once extraCapacityExpiresAt has passed (checked lazily
  // at read time - same "no cron sweep, just compare to now()" posture as
  // onboardingStep/accountType elsewhere in this table - a future renewal/
  // auto-charge flow would need its own job, deliberately out of scope for
  // this first pass).
  extraCampaignSlots: integer("extra_campaign_slots").notNull().default(0),
  // Same idea, agency-only: extra CLIENT slots beyond the plan's base 5
  // (BASE_CLIENT_LIMIT_AGENCY). Always purchased together with campaign
  // slots as one bundle (1 client + 2 campaigns per bundle - see
  // AGENCY_BUNDLE_EXTRA_CLIENTS/AGENCY_BUNDLE_EXTRA_CAMPAIGNS), never sold
  // separately, but tracked as its own column since the two limits
  // (campaigns vs. clients) are checked at different times (campaign
  // creation vs. add-client) against different counts.
  extraClientSlots: integer("extra_client_slots").notNull().default(0),
  // Which billing cycle the CURRENT (most recent) overage purchase was
  // paid for - monthly|quarterly|halfyearly|yearly (see BillingCycle in
  // src/domain/billing.ts). Display-only (what to show on the billing
  // page as "renews on...") - the actual expiry that governs whether the
  // slots above still count is extraCapacityExpiresAt, not this column.
  extraCapacityCycle: text("extra_capacity_cycle"),
  // When the currently-active overage purchase's paid-for cycle ends - the
  // slots above are only honored while this is in the future (see
  // extraSlotsActive() in src/application/billing.ts). A top-up purchase
  // made while a cycle is still active ADDS to the existing slots and
  // extends this date rather than starting over - see
  // applyOverageCapacityPurchase's own comment for the exact rule.
  extraCapacityExpiresAt: timestamp("extra_capacity_expires_at", { withTimezone: true }),
  // --- 15-day free trial + base-plan subscription (see src/domain/trial.ts
  // for the state machine these four columns feed, and
  // src/application/billing.ts's getCampaignLimitStatus/getClientLimitStatus
  // for how that state changes the campaign/client limits above). Deliberately
  // separate from extraCampaignSlots/extraClientSlots/extraCapacityCycle/
  // extraCapacityExpiresAt above - those are OVERAGE, purchased only on top
  // of an already-active base plan; these four are whether the base plan
  // itself is currently trialing, active, or lapsed.
  //
  // trialStartedAt/trialEndsAt: null for every company that predates this
  // feature (see this migration's own SQL comment - grandfathered as
  // permanently "subscribed" via subscriptionStatus's column default
  // below, never given a retroactive trial) and for every claimed CLIENT
  // company (a client never has a plan of its own - entitlement always
  // resolves to its claiming agency's own row, see
  // resolvePoolRootCompanyId). Set together, once, only by
  // registerCompanyAndOwner (src/application/auth.ts) at the moment a
  // brand-new top-level Individual or Agency account is created - never
  // updated again afterward (a trial does not restart or extend).
  trialStartedAt: timestamp("trial_started_at", { withTimezone: true }),
  trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
  // "trialing" | "active" | "expired" - same "plain text, validated at the
  // application layer, never compared ad hoc outside its own resolver"
  // convention as accountType/onboardingStatus above; resolveEntitlementState()
  // in src/domain/trial.ts is the one place that ever trusts a raw value
  // here. Defaults to "active" (not "trialing") so every pre-existing
  // company - and every claimed client company, which never has a plan of
  // its own - resolves as permanently subscribed with no trial, exactly
  // how every company already behaved before this column existed.
  subscriptionStatus: text("subscription_status").notNull().default("active"),
  // Which billing cycle the current PAID BASE PLAN purchase (not overage -
  // see extraCapacityCycle above) was paid for, once the trial converts -
  // display-only, same role extraCapacityCycle plays for overage.
  subscriptionCycle: text("subscription_cycle"),
  // When the current paid base-plan cycle ends. Null while subscriptionStatus
  // is "trialing" (trialEndsAt governs instead) or for a grandfathered/
  // legacy "active" row with no purchase on file (treated as active
  // forever - see resolveEntitlementState's own comment). Set by
  // applyBaseSubscriptionPurchase (src/infrastructure/db/repositories/
  // tenancy.ts) the same way applyOverageCapacityPurchase already sets
  // extraCapacityExpiresAt.
  subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  slugIdx: uniqueIndex("ux_companies_slug").on(t.slug),
  // Added for admin/status-filtered listings (e.g. "suspended companies")
  // and chronological views ("newest companies first") - status isn't
  // enforced as a login/API gate yet (see the column's own comment above),
  // but the index costs nothing to have ready for when it is.
  statusIdx: index("ix_companies_status").on(t.status),
  createdAtIdx: index("ix_companies_created_at").on(t.createdAt),
}));

// ---------------------------------------------------------------------------
// Agency <-> Client organization relationships
// ---------------------------------------------------------------------------
//
// "An agency can own/manage multiple client organizations." Deliberately a
// RELATIONSHIP, not a third account_type value - a "CLIENT" account_type
// would conflate two different questions ("what kind of organization is
// this" vs "who currently manages it"), and would need to keep changing
// every time a client organization's managing agency changes. This table
// is the only place that fact lives; `companies.accountType` stays exactly
// AccountType ("individual" | "agency" - see src/domain/accountType.ts),
// never "client". A client organization is simply an ordinary `companies`
// row - typically accountType "individual", but nothing here requires
// that - that happens to have a row here pointing at it.
//
// Both sides reference `companies.id`, this schema's own tenant/
// organization table (an agency and its client are each a first-class
// tenant in their own right, with their own users/branches/campaigns/
// leads) - "organization" in the product/requirements vocabulary IS
// "company" in this codebase's, same mapping already established for
// companies.accountType. This table only records the relationship between
// two organizations, never merges their data or their tenant isolation.
// Wiring actual cross-tenant access (an agency user being able to act
// inside a client's tenant) is a separate, later phase - same "schema now,
// pipeline wiring later" split already used for meta_connections/
// meta_pages above when tenant-level Meta auth was added.
export const agencyClients = crm.table(
  "agency_clients",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agencyCompanyId: uuid("agency_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    clientCompanyId: uuid("client_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // "invited" | "pending" | "active" | "suspended" | "removed" - see
    // src/domain/agencyClientStatus.ts for the fixed catalog. Not a DB
    // enum, same convention as every other status column in this schema.
    // A status TRANSITION is an UPDATE on this same row, never a new row -
    // see the composite unique index below, which is what makes that true
    // rather than just a convention someone could accidentally violate.
    status: text("status").notNull().default("invited"),
    // The (typically agency-side) user who created this link. Nullable +
    // ON DELETE SET NULL - that user being removed later must never delete
    // the relationship itself.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    agencyIdx: index("ix_agency_clients_agency_company_id").on(t.agencyCompanyId),
    clientIdx: index("ix_agency_clients_client_company_id").on(t.clientCompanyId),
    // One row EVER per (agency, client) pair - re-engaging after "removed"
    // reactivates this same row (see linkOrReactivateClient in
    // src/infrastructure/db/repositories/organizations.ts, an INSERT ...
    // ON CONFLICT DO UPDATE keyed on exactly this index), it never inserts
    // a second one. This is what "agency_id + client_id must be unique"
    // means in practice: the pair's entire history lives in one row's
    // status column, not across multiple rows.
    agencyClientPairIdx: uniqueIndex("ux_agency_clients_agency_client").on(t.agencyCompanyId, t.clientCompanyId),
    // THE cardinality rule: a client organization can be actively (in any
    // non-"removed" sense - invited, pending, active, or suspended) claimed
    // by at most one agency at a time (confirmed - not many-to-many); only
    // "removed" frees a client to be invited by a different agency. A
    // partial unique index (not a plain unique on clientCompanyId alone) so
    // a client's full relationship history with every agency it has ever
    // been connected to stays queryable - same pattern as
    // meta_connections.ux_meta_connections_one_active_per_tenant and
    // meta_pages.ux_meta_pages_one_selected_per_tenant above. Listed as a
    // positive enumeration (not "status <> 'removed'") so adding a further
    // terminal status later can't silently start occupying this slot by
    // accident - it has to be a conscious edit here.
    oneClaimedAgencyPerClientIdx: uniqueIndex("ux_agency_clients_one_claimed_agency_per_client")
      .on(t.clientCompanyId)
      .where(sql`status IN ('invited', 'pending', 'active', 'suspended')`),
    // An organization can never be its own client.
    notSelfLinkCheck: check("ck_agency_clients_not_self", sql`${t.agencyCompanyId} <> ${t.clientCompanyId}`),
    // Status-filtered listings (e.g. "active clients only") and
    // chronological ordering ("most recently linked client first") -
    // neither had its own index before; both are cheap and additive
    // alongside the composite/partial unique indexes above, which serve a
    // different purpose (correctness, not lookup speed).
    statusIdx: index("ix_agency_clients_status").on(t.status),
    createdAtIdx: index("ix_agency_clients_created_at").on(t.createdAt),
  }),
);

/**
 * The invitation/onboarding-token model backing "Generate Onboarding Link"
 * (Clients -> Add Client -> Generate Onboarding Link) - distinct from
 * agencyClients above, which records an actual (agency, client)
 * RELATIONSHIP once one exists. This table exists ONLY to hand a
 * prospective client - someone with no RUTA account yet - a secure link
 * that self-registers them as this agency's client, without the agency
 * ever typing in a password on their behalf (contrast
 * addClientOrganization's system-generated temp password in
 * src/application/agency.ts) and without exposing an agency or client id in
 * the URL as the authorization mechanism.
 *
 * Named and shaped after the conventional `organization_invitations` /
 * onboarding-token model (id, agency_organization_id, email, token_hash,
 * expires_at, accepted_at, status, created_by, created_at): every one of
 * those columns is here, plus two this feature specifically needs
 * (clientName, resultingCompanyId - see their own comments below).
 * `agencyCompanyId` is this table's `agency_organization_id`: this
 * codebase's tenant/organization row IS a `companies` row - see
 * companies.accountType's own comment - there is no separate `organizations`
 * table to point at, so every other agency-facing table here
 * (agencyClients above included) already names this same FK
 * `agencyCompanyId`/`agency_company_id`; this table matches that existing
 * convention rather than introducing a one-off different name for the same
 * concept.
 *
 * Rules this schema enforces or supports (see
 * src/infrastructure/db/repositories/organizationInvitations.ts and
 * src/application/agencyOnboarding.ts for where each is actually applied):
 *   - Token must expire: expiresAt, checked by every read/accept path.
 *   - Token can be revoked: status='REVOKED' (+ revokedAt for when),
 *     scoped to the generating agency - see revokeInvitation.
 *   - Token cannot be guessed: the token itself is a 256-bit
 *     cryptographically random value (generateOnboardingToken in
 *     src/infrastructure/auth/tokens.ts); only its SHA-256 digest
 *     (tokenHash) is ever persisted, so a leaked database dump can't be
 *     replayed as a working invite link any more than a leaked sessions
 *     table can be replayed as a login.
 *   - Accepted token cannot be reused: acceptInvitation does one atomic
 *     UPDATE ... WHERE status = 'PENDING' AND expires_at > now() ...
 *     RETURNING, not a check-then-write pair - a second acceptance (or two
 *     concurrent ones racing each other) can never both succeed.
 *   - Tenant-aware: every row is scoped to the inviting agencyCompanyId;
 *     listing/revoking is always scoped to the calling agency's own id
 *     (see listInvitationsForAgency/revokeInvitation).
 *   - The client cannot pick their own agency: agencyCompanyId is set once,
 *     server-side, at generation time from the AUTHENTICATED agency
 *     session that called generateOnboardingLink - never from anything the
 *     public redemption request supplies. completeAgencyOnboarding/
 *     getOnboardingLinkPreview take a token and nothing else; there is no
 *     agencyCompanyId-shaped input for a tampered request to submit in the
 *     first place, so there is nothing for frontend manipulation to
 *     override.
 */
export const organizationInvitations = crm.table(
  "organization_invitations",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agencyCompanyId: uuid("agency_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // SHA-256 hex digest of the raw token - never the token itself. See
    // hashOnboardingToken in src/infrastructure/auth/tokens.ts.
    tokenHash: text("token_hash").notNull(),
    // What the agency typed into "Client Name" when generating the link -
    // shown on the public landing page ("ABC Digital invited you...")
    // before the prospective client has an account at all, so this can't
    // simply read from a companies row the way every other agency-facing
    // screen does. Purely informational, and not part of the conventional
    // invitation schema this table is otherwise modeled on - kept because
    // the public landing page has nothing else to show a name from until
    // the invitation is accepted. Purely a label: the prospective client
    // can still type a different company name on the actual registration
    // form the link leads to; nothing here constrains what
    // completeAgencyOnboarding ultimately creates.
    clientName: text("client_name").notNull(),
    email: text("email").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // PENDING | ACCEPTED | EXPIRED | REVOKED - see
    // src/domain/organizationInvitationStatus.ts for the fixed catalog and
    // its own comment on why EXPIRED is never actually written here.
    status: text("status").notNull().default("PENDING"),
    // The company this invitation actually created, once accepted -
    // nullable until then. Not part of the conventional invitation schema
    // this table is otherwise modeled on, but kept as the audit trail
    // linking a redeemed invitation to what it produced - the same reason
    // sessions.userId links a session to who it belongs to. ON DELETE SET
    // NULL so deleting that company later (not a flow this codebase has
    // today) can't cascade into silently deleting this audit row.
    resultingCompanyId: uuid("resulting_company_id").references(() => companies.id, { onDelete: "set null" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agencyIdx: index("ix_organization_invitations_agency_company_id").on(t.agencyCompanyId),
    // The one lookup the public redemption endpoint actually does - unique
    // so two tokens can never collide (astronomically unlikely given 256
    // bits of entropy, but the index still needs to exist for the lookup
    // itself to be fast, and uniqueness costs nothing extra to declare).
    tokenHashIdx: uniqueIndex("ux_organization_invitations_token_hash").on(t.tokenHash),
    // Status-filtered listings (Clients page's pending/accepted/revoked
    // tabs) and chronological ordering - neither had its own index before.
    statusIdx: index("ix_organization_invitations_status").on(t.status),
    createdAtIdx: index("ix_organization_invitations_created_at").on(t.createdAt),
    // generateOnboardingLink (src/application/agencyOnboarding.ts) had no
    // guard against the same agency generating a second still-outstanding
    // invite to the same email while the first is still PENDING - a
    // prospective client could end up with two valid, independent links.
    // Partial unique index (same idiom as
    // ux_agency_clients_one_claimed_agency_per_client /
    // ux_meta_connections_one_active_per_tenant above: "at most one active
    // X" expressed as a WHERE-scoped unique index, not a plain composite
    // unique) so only ONE PENDING invitation can exist per (agency, email)
    // pair at a time; ACCEPTED/EXPIRED/REVOKED rows are exempt and keep
    // accumulating as history exactly as before. The corresponding
    // migration defuses any pre-existing duplicate PENDING rows (by
    // revoking all but the newest per pair) before this index is created,
    // so it never fails against real data - see migration 0023's own
    // comment.
    onePendingPerAgencyEmailIdx: uniqueIndex("ux_organization_invitations_one_pending_per_agency_email")
      .on(t.agencyCompanyId, t.email)
      .where(sql`status = 'PENDING'`),
  }),
);

/**
 * Which specific client organization(s) a given AGENCY user is allowed to
 * see - the "Agency User -> Assigned Clients -> Client A, Client C" model
 * (see src/domain/fixedRoles.ts and src/application/agencyClientAccess.ts).
 * Deliberately per-USER, unlike agencyClients above (which is per-COMPANY:
 * "this agency manages this client at all") - two agency teammates can be
 * assigned to completely different subsets of the same agency's client
 * roster, which agencyClients alone has no way to express.
 *
 * `agencyCompanyId` is denormalized here (derivable by joining through
 * `users`) purely so every query in
 * src/infrastructure/db/repositories/agencyClientAssignments.ts can filter
 * directly on it without a join, the same tenant-safety convention
 * agencyClients/organizationInvitations above already both follow for
 * their own agency-scoped columns.
 *
 * Holding AGENCY_CLIENTS_VIEW_ALL (Owner/Admin tiers - see
 * AGENCY_ROLE_PERMISSIONS) bypasses this table entirely: those users see
 * every claimed client regardless of what is or isn't assigned here. A row
 * here only matters for a user whose role does NOT hold that permission
 * (Manager/User tiers, or any custom role an admin builds without it).
 */
export const agencyClientAssignments = crm.table(
  "agency_client_assignments",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    agencyCompanyId: uuid("agency_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    clientCompanyId: uuid("client_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agencyIdx: index("ix_agency_client_assignments_agency_company_id").on(t.agencyCompanyId),
    userIdx: index("ix_agency_client_assignments_user_id").on(t.userId),
    clientIdx: index("ix_agency_client_assignments_client_company_id").on(t.clientCompanyId),
    // One row per (user, client) pair - re-assigning is an upsert, not a
    // second row, same shape as ux_branch_users_branch_user.
    userClientIdx: uniqueIndex("ux_agency_client_assignments_user_client").on(t.userId, t.clientCompanyId),
    createdAtIdx: index("ix_agency_client_assignments_created_at").on(t.createdAt),
  }),
);

/**
 * Agency/client access audit trail - see src/application/agencyAuditLog.ts's
 * own header comment for the full design (the fixed 11-action catalog in
 * src/domain/agencyAuditAction.ts, what `agencyUserId` means per action, and
 * the write-only "never log secrets" contract). Structurally the same
 * "bigserial id + free-text event type + optional detail + indexed
 * timestamp" shape as leadProcessingLog above, adjusted to this feature's
 * exact fields: `agencyUserId` and `clientCompanyId` are both nullable
 * because several events genuinely have no agency-side actor (e.g. a client
 * accepting an invite) or no client subject (e.g. AGENCY_CREATED,
 * AGENCY_USER_CREATED) - see agencyAuditLog.ts for exactly when each is
 * null. `detail` is free text for non-secret context ONLY (an email, a
 * client name, a "declined invitation" note, a subject user id) - it must
 * NEVER hold a password, token, API secret, or other credential; every
 * call site that writes here goes through recordAgencyAuditEvent's typed
 * parameters specifically so a secret can never be passed through as an
 * arbitrary payload. ON DELETE SET NULL (not CASCADE) on every FK here,
 * deliberately - a row in an audit trail must survive the company or user
 * it refers to being deleted, same reasoning as leadFollowUps.createdBy.
 */
export const agencyAuditLog = crm.table(
  "agency_audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    agencyCompanyId: uuid("agency_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    agencyUserId: uuid("agency_user_id").references(() => users.id, { onDelete: "set null" }),
    clientCompanyId: uuid("client_company_id").references(() => companies.id, { onDelete: "set null" }),
    action: text("action").notNull(), // AgencyAuditAction - see src/domain/agencyAuditAction.ts
    detail: text("detail"), // non-secret context only - see this table's own doc comment
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    agencyIdx: index("ix_agency_audit_log_agency_company_id").on(t.agencyCompanyId),
    clientIdx: index("ix_agency_audit_log_client_company_id").on(t.clientCompanyId),
    actionIdx: index("ix_agency_audit_log_action").on(t.action),
    createdAtIdx: index("ix_agency_audit_log_created_at").on(t.createdAt),
  }),
);

/**
 * A role's permission set. `isSystem` marks a built-in, non-editable role -
 * either the single generic "Owner" role every ordinary company gets at
 * signup, or one of the four fixed AGENCY_ or CLIENT_ prefixed roles an
 * agency-context company gets instead (see src/domain/fixedRoles.ts) -
 * always holding a fixed permission set that only the application layer
 * changes (never the admin UI, which refuses to edit/delete any isSystem
 * row - see api/admin/roles/handler.ts). Everything else is a fully custom
 * role the admin defines from the fixed permission catalog in
 * src/domain/permissions.ts.
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
  createdAtIdx: index("ix_roles_created_at").on(t.createdAt),
}));

export const users = crm.table("users", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(),
  // Contact mobile number - nullable, no format validation at this layer
  // (kept deliberately simple, unlike the E.164-validated phone field a
  // prior, now-removed feature once added here - see git history). Only
  // ever populated today for an agency account's registering "Contact
  // Person" (public/register.html's Agency form; see RegisterInput.phoneNumber
  // in src/application/auth.ts) - null for every Individual account and for
  // any user created afterward via the admin "Add user" flow, which
  // doesn't collect one.
  phoneNumber: text("phone_number"),
  status: text("status").notNull().default("active"), // active | disabled
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  emailIdx: uniqueIndex("ux_users_email").on(t.email),
  companyIdx: index("ix_users_company_id").on(t.companyId),
  // Status-filtered listings (admin "active users" / "disabled users") and
  // chronological ordering - neither had its own index before.
  statusIdx: index("ix_users_status").on(t.status),
  createdAtIdx: index("ix_users_created_at").on(t.createdAt),
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
  // "Remember me" (login.html) - the tenant's own choice, captured at login
  // and carried forward across every silent refresh (see refresh() in
  // src/application/auth.ts) so it can't drift back to the long-lived
  // default partway through a session. Defaults false: a login that omits
  // it (or a malformed value) gets the SHORT session, never the 30-day one
  // - "forget unless told to remember," not the other way around. Purely
  // determines expiresAt's TTL and whether the browser cookie itself is a
  // persistent (Max-Age) or session cookie (see cookieOptions in
  // src/infrastructure/auth/tokens.ts) - never a separate grant of access;
  // the refresh token's own signature/hash is what's actually checked.
  rememberMe: boolean("remember_me").notNull().default(false),
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
// Tenant-level Meta integration (Phase 2)
// ---------------------------------------------------------------------------
//
// Meta authentication now belongs to the TENANT (company), not to an
// individual campaign - one company connects its Meta Business account
// once via OAuth, then chooses which of its Pages/ad accounts/lead forms
// to use across however many CRM campaigns it has. This replaces the old
// model where every campaign held its own hand-entered App Secret/Access
// Token (see `webhookConfigs` below, kept in place unmodified - existing
// campaigns and their webhook config keep working exactly as before; nothing
// here deletes or migrates that data). Wiring the ingestion pipeline itself
// to these new tables is a later phase - this phase only adds the schema.

/**
 * One row per Meta OAuth grant for a tenant. A tenant should normally have
 * exactly one ACTIVE connection at a time (enforced below by a partial
 * unique index on tenantId where status='active') - but old
 * revoked/expired/error rows are never deleted, so reconnecting (e.g. a
 * different Meta user re-authorizes after the first grant was revoked)
 * keeps full history rather than overwriting it.
 */
export const metaConnections = crm.table(
  "meta_connections",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // The Meta user id who completed the OAuth grant (not a Page id).
    metaUserId: text("meta_user_id").notNull(),
    // Display name only ("John"), fetched once at connect time (step 7,
    // GET /me?fields=id,name,email) and persisted purely so the Settings ->
    // Integrations -> Meta screen can show "Meta Account: <name> / <company>"
    // without a live Graph API call on every page load. Nullable: never
    // backfilled for connections made before this column existed.
    metaUserName: text("meta_user_name"),
    // No DB-level enum, validated at the application layer - same
    // convention as every other status column in this schema:
    // "active" | "revoked" | "error" | "needs_reauth".
    // "revoked" is reserved for the tenant's OWN deliberate Disconnect
    // button (disconnectActiveMetaConnection) - a choice, not a problem.
    // "needs_reauth" (Phase 16) is the system-detected counterpart: Meta
    // itself rejected a Graph API call for an auth reason (expired token,
    // revoked authorization, missing permission, or removed Page access -
    // see graphClient.classifyMetaAuthError) - set by
    // markMetaConnectionNeedsReauth, surfaced by the Settings -> Meta
    // screen's "Needs Reauthorization" card. "error" stays reserved for a
    // non-auth technical failure (a 5xx, a network blip) that reconnecting
    // isn't actually the fix for. "expired" was reserved here since Phase 3
    // but never implemented as its own status - token expiry is classified
    // under "needs_reauth" instead (see the comment above), so this value
    // is not currently written by any code path.
    status: text("status").notNull().default("active"),
    // The long-lived Meta user access token, encrypted the same way
    // webhookConfigs' secrets already are (see
    // src/infrastructure/security/encryption.ts) - never stored in
    // plaintext, never returned over an API response unmasked.
    accessTokenEncrypted: text("access_token_encrypted").notNull(),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
    // Last time Pages/ad accounts/forms were synced from the Graph API
    // using this connection.
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_connections_tenant_id").on(t.tenantId),
    // "A tenant should normally have one active Meta connection" - a
    // partial unique index (not a plain unique on tenantId) so historical
    // revoked/expired/error rows can coexist without being deleted, the
    // same pattern already used for branch_users.isPrimary above.
    oneActivePerTenantIdx: uniqueIndex("ux_meta_connections_one_active_per_tenant")
      .on(t.tenantId)
      .where(sql`status = 'active'`),
  }),
);

/**
 * A Facebook Page the tenant has access to via its Meta connection, and
 * whether they've chosen ("selected") it for lead capture in this CRM.
 * Carries its own page-scoped access token (separate from the connection's
 * user token) because Graph API lead-retrieval calls are made with the
 * Page token, not the user token.
 */
export const metaPages = crm.table(
  "meta_pages",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    metaConnectionId: uuid("meta_connection_id").notNull().references(() => metaConnections.id, { onDelete: "cascade" }),
    // Meta's own Page id - plain text, same convention as
    // webhookConfigs.pageId (Meta's ids are never our own uuid PKs).
    pageId: text("page_id").notNull(),
    pageName: text("page_name").notNull(),
    pageAccessTokenEncrypted: text("page_access_token_encrypted").notNull(),
    instagramBusinessAccountId: text("instagram_business_account_id"),
    isSelected: boolean("is_selected").notNull().default(false),
    // Phase 7: whether the CRM has successfully subscribed this Page to
    // Meta's leadgen webhook event - set automatically the moment this
    // Page is selected (see metaWebhookService.ts), never entered manually.
    webhookSubscribed: boolean("webhook_subscribed").notNull().default(false),
    // "pending" | "active" | "failed" - not a DB enum, same convention as
    // every other status column in this schema. "pending" only while a
    // subscribe attempt is actually in flight (it's synchronous, so this
    // should rarely be observed at rest).
    webhookStatus: text("webhook_status").notNull().default("pending"),
    // Last time the subscribe call actually succeeded - NOT touched by a
    // later failed retry, so "was this ever verified" survives a
    // subsequent transient failure.
    webhookLastVerifiedAt: timestamp("webhook_last_verified_at", { withTimezone: true }),
    // Human-readable reason for the most recent FAILURE - "Do not silently
    // fail" (Phase 7): cleared on success, always populated on failure.
    webhookLastError: text("webhook_last_error"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_pages_tenant_id").on(t.tenantId),
    connectionIdx: index("ix_meta_pages_meta_connection_id").on(t.metaConnectionId),
    tenantPageIdx: uniqueIndex("ux_meta_pages_tenant_page").on(t.tenantId, t.pageId),
    // Phase 5: "Select Facebook Page" is a single-select radio list - at
    // most one Page can be the tenant's selected one at a time. Enforced
    // here (not just app-layer "unselect all, then select one") as a
    // backstop against a genuinely concurrent double-save; partial so any
    // number of NOT-selected rows never trips it.
    oneSelectedPerTenantIdx: uniqueIndex("ux_meta_pages_one_selected_per_tenant")
      .on(t.tenantId)
      .where(sql`is_selected = true`),
  }),
);

/** A Meta ad account the tenant has access to, and whether it's been
 * selected for use (e.g. to scope which ad campaigns are offered when
 * linking a CRM campaign - see campaigns.metaAdAccountId below). */
export const metaAdAccounts = crm.table(
  "meta_ad_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    metaConnectionId: uuid("meta_connection_id").notNull().references(() => metaConnections.id, { onDelete: "cascade" }),
    // Meta's own ad account id (e.g. "act_1234567890") - plain text, same
    // convention as pageId above.
    adAccountId: text("ad_account_id").notNull(),
    name: text("name").notNull(),
    isSelected: boolean("is_selected").notNull().default(false),
    // Loosely mirrors Meta's own ad account status; not a DB enum, same
    // convention as every other status column in this schema.
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_ad_accounts_tenant_id").on(t.tenantId),
    connectionIdx: index("ix_meta_ad_accounts_meta_connection_id").on(t.metaConnectionId),
    // Not explicitly requested in the Phase 2 spec, but added for the same
    // reason meta_pages has one: prevents the same Meta ad account from
    // being synced into duplicate rows for one tenant.
    tenantAccountIdx: uniqueIndex("ux_meta_ad_accounts_tenant_account").on(t.tenantId, t.adAccountId),
    // Phase 5: same "single-select, DB-enforced" backstop as meta_pages above.
    oneSelectedPerTenantIdx: uniqueIndex("ux_meta_ad_accounts_one_selected_per_tenant")
      .on(t.tenantId)
      .where(sql`is_selected = true`),
  }),
);

/**
 * A Meta Instagram professional/business account the tenant has access to,
 * discovered via one of their connected Pages (Meta always links an IG
 * business account to exactly one Page - see meta_pages.instagram_business_account_id
 * for the same id surfaced there). Kept as its own first-class, independently
 * selectable resource (rather than reusing meta_pages.isSelected) because
 * Phase 5's selection flow treats "which Page" and "which Instagram account"
 * as two separate choices - a tenant can select a Page that has no IG
 * account linked while still choosing a DIFFERENT page's IG account here.
 */
export const metaInstagramAccounts = crm.table(
  "meta_instagram_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    metaConnectionId: uuid("meta_connection_id").notNull().references(() => metaConnections.id, { onDelete: "cascade" }),
    // The Page (Meta's own id, text - same convention as meta_forms.pageId)
    // this Instagram account is linked to, for display/reference only.
    pageId: text("page_id").notNull(),
    // Meta's own Instagram Business Account id - plain text, same "Meta's
    // id, not ours" convention as pageId/adAccountId above.
    instagramAccountId: text("instagram_account_id").notNull(),
    // "@handle" without the "@" - nullable because Meta doesn't always
    // return it (e.g. a not-fully-set-up IG business profile).
    username: text("username"),
    isSelected: boolean("is_selected").notNull().default(false),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_instagram_accounts_tenant_id").on(t.tenantId),
    connectionIdx: index("ix_meta_instagram_accounts_meta_connection_id").on(t.metaConnectionId),
    tenantAccountIdx: uniqueIndex("ux_meta_instagram_accounts_tenant_account").on(t.tenantId, t.instagramAccountId),
    oneSelectedPerTenantIdx: uniqueIndex("ux_meta_instagram_accounts_one_selected_per_tenant")
      .on(t.tenantId)
      .where(sql`is_selected = true`),
  }),
);

/** A Meta lead form discovered under one of the tenant's connected Pages.
 * Deliberately keyed by the Page's Meta id (text), not a FK to
 * meta_pages.id - a form belongs to a Page in Meta's own model regardless
 * of whether that Page has been "selected" as a metaPages row yet. */
export const metaForms = crm.table(
  "meta_forms",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    pageId: text("page_id").notNull(),
    formId: text("form_id").notNull(),
    formName: text("form_name").notNull(),
    // "active" | "archived" | "deleted" - Meta's own lead-form lifecycle;
    // not a DB enum, same convention as every other status column here.
    status: text("status").notNull().default("active"),
    // Phase 10 - THIS form's own questions, exactly as Meta defines them
    // (key/label/type), refreshed on every sync. This is what makes field
    // mapping dynamic per form rather than hard-coded: every question here
    // gets (or already has) a corresponding row in metaFormFieldMappings
    // below - see ensureDefaultFieldMappings. Never itself read by the
    // ingestion pipeline (that reads metaFormFieldMappings only) - this is
    // purely "what does Meta say this form currently asks," for the admin
    // mapping screen and for re-seeding new questions as they appear.
    questions: jsonb("questions").$type<{ key: string; label: string; type: string }[]>().notNull().default(sql`'[]'::jsonb`),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_forms_tenant_id").on(t.tenantId),
    pageIdx: index("ix_meta_forms_page_id").on(t.pageId),
    // Not explicitly requested in the Phase 2 spec, but added for the same
    // reason meta_pages has one: prevents the same Meta form from being
    // synced into duplicate rows for one tenant.
    tenantFormIdx: uniqueIndex("ux_meta_forms_tenant_form").on(t.tenantId, t.formId),
  }),
);

/**
 * Phase 10 - THE Meta Field -> CRM Field mapping, one row per (tenant,
 * synced Meta form, question). Every Meta lead form can ask different
 * questions (see metaForms.questions above) - an incoming lead's
 * field_data is keyed by these exact same metaFieldKey values (see
 * graphClient.getLeadDetails/MetaLeadDetails.fieldData), so THIS table is
 * what lets ingestion resolve each answer to a CRM destination without any
 * field name ever being hard-coded in application code (see
 * src/application/metaSync/resolveLeadFields.ts, the only reader).
 *
 * Auto-seeded with a best-guess mapping whenever a form's questions are
 * (re)synced (see ensureDefaultFieldMappings in
 * src/infrastructure/db/repositories/metaFormMappings.ts) using a small
 * built-in dictionary of common Meta field keys (full_name, email,
 * phone_number, ...) - but that dictionary is only ever a starting
 * SUGGESTION for a brand-new row; once a row exists here it is never
 * touched by a re-sync again (same "never clobber the tenant's own later
 * choice" convention as upsertMetaCampaign/replaceMetaPages elsewhere) -
 * only an administrator's explicit Save Mapping action changes it.
 * A question Meta added that has no known default becomes an unmapped
 * "custom" row (customFieldKey defaults to its own metaFieldKey) rather
 * than being skipped - no field is ever silently dropped.
 */
export const metaFormFieldMappings = crm.table(
  "meta_form_field_mappings",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    metaFormId: uuid("meta_form_id").notNull().references(() => metaForms.id, { onDelete: "cascade" }),
    // Meta's own question/field key (matches an incoming lead's
    // field_data[].name) - always stored lowercased so ingestion's own
    // lowercase lookup is guaranteed to hit.
    metaFieldKey: text("meta_field_key").notNull(),
    // Meta's own display label for this question ("What's your budget?")
    // - denormalized purely for the admin mapping screen, refreshed on
    // every re-sync. Never drives ingestion behavior itself.
    metaFieldLabel: text("meta_field_label").notNull(),
    // "system" | "custom" - deliberately the exact same vocabulary as
    // forms.formFields.mappingType (see that table's own comment) rather
    // than inventing a second one for what is conceptually the same idea.
    mappingType: text("mapping_type").notNull().default("custom"),
    // Only set when mappingType="system" - one of "fullName" |
    // "phoneNumber" | "email" (leads.* columns). Deliberately a narrower
    // set than forms.formFields.systemField's full SystemFieldKey catalog
    // - a Meta lead-form answer is a single piece of contact info, never
    // something like "assign this lead to owner X".
    systemField: text("system_field"),
    // Only set when mappingType="custom" - the key written into
    // leads.customFields, the same jsonb column every other dynamic/custom
    // field in this schema already uses (see the Forms module and
    // industryTemplates.ts's FieldDef.key). Defaults to metaFieldKey
    // itself when a row is auto-seeded, so nothing is ever unaddressable.
    customFieldKey: text("custom_field_key"),
    // Display label for the custom field, editable independently of
    // Meta's own metaFieldLabel (the admin's "Preferred Location" vs
    // Meta's "location" in the Phase 10 example UI).
    customFieldLabel: text("custom_field_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_form_field_mappings_tenant_id").on(t.tenantId),
    formIdx: index("ix_meta_form_field_mappings_meta_form_id").on(t.metaFormId),
    // The auto-seed's conflict arbiter AND what guarantees ingestion's
    // lookup (tenantId, formId's own metaFormId row, metaFieldKey) can
    // never resolve to more than one row.
    tenantFormFieldIdx: uniqueIndex("ux_meta_form_field_mappings_tenant_form_field").on(t.tenantId, t.metaFormId, t.metaFieldKey),
  }),
);

/**
 * One row per Meta webhook "leadgen" change notification, at the TENANT
 * level - the eventual successor to the campaign-scoped `rawMetaEvents`
 * below once the ingestion pipeline is repointed at the tenant-level
 * connection in a later phase. Mandatory per the Phase 2 spec even though
 * nothing writes to it yet. The unique (tenantId, leadgenId) constraint is
 * the idempotency backstop - it is what will prevent a redelivered or
 * duplicate Meta webhook call from ever producing two rows (and therefore
 * two leads) for the same Meta leadgen event.
 */
export const metaLeadEvents = crm.table(
  "meta_lead_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    leadgenId: text("leadgen_id").notNull(),
    pageId: text("page_id"),
    formId: text("form_id"),
    adId: text("ad_id"),
    adsetId: text("adset_id"),
    // Meta's OWN ad campaign id from the webhook payload - distinct from
    // our internal campaigns.id, same "Meta's id, not ours" convention as
    // leads.campaignId (see crmCampaignId there for the internal FK).
    campaignId: text("campaign_id"),
    rawPayload: jsonb("raw_payload").notNull(),
    // Phase 14 status vocabulary - "received" | "enqueued" | "processing" |
    // "completed" | "duplicate" | "retrying" | "failed" | "blocked" - not a
    // DB enum, same convention as every other status column in this
    // schema. "retrying" means this attempt failed but QStash retries
    // remain; "failed" is the terminal state, set only once by the
    // dead-letter callback when retries are exhausted. "enqueued" and
    // "duplicate" are two additional internal states beyond the
    // user-facing RECEIVED/PROCESSING/COMPLETED/FAILED/RETRYING model:
    // "enqueued" is load-bearing for the reconciliation sweep
    // (getUnenqueuedMetaLeadEvents), and "duplicate" is a legitimate
    // non-failure terminal outcome. "blocked" (Phase 16 - trial/
    // subscription entitlement, see isLeadIngestionBlocked in
    // src/application/billing.ts) is the same kind of legitimate
    // non-failure terminal outcome as "duplicate": the event was correctly
    // captured, but the tenant's account was trial_expired/
    // subscription_expired at processing time, so no lead was created.
    status: text("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_lead_events_tenant_id").on(t.tenantId),
    statusReceivedIdx: index("ix_meta_lead_events_status_received_at").on(t.status, t.receivedAt),
    pageIdx: index("ix_meta_lead_events_page_id").on(t.pageId),
    formIdx: index("ix_meta_lead_events_form_id").on(t.formId),
    // Mandatory per the Phase 2 spec - prevents a duplicate/redelivered
    // Meta webhook event from ever creating duplicate leads.
    tenantLeadgenIdx: uniqueIndex("ux_meta_lead_events_tenant_leadgen").on(t.tenantId, t.leadgenId),
  }),
);

// ---------------------------------------------------------------------------
// Campaigns + per-campaign Meta webhook configuration
// ---------------------------------------------------------------------------

/**
 * THE CRM CAMPAIGN - an internal business object ("Ahmedabad Residential
 * Project"), independent of any external ad platform. Phase 9 deliberately
 * UNDOES Phase 6/8's original "reuse this table for a synced Meta campaign
 * too" shortcut: a Meta campaign ("Ahmedabad 3BHK Leads", meta_campaign_id
 * 123456) is now its own first-class entity (see metaCampaigns below),
 * connected to a CRM campaign via metaCampaigns.crmCampaignId, NOT by
 * being one. A CRM campaign can have zero, one, or many Meta campaigns
 * mapped to it (and, looking ahead, could just as easily have a Google Ads
 * campaign or a walk-in source mapped to it too) - this table never again
 * carries a raw Meta id or ad-account FK itself.
 */
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
  // Provenance only. "manual" - created directly via Create Campaign (or
  // any other person-initiated action). "meta_sync" - auto-created, either
  // by the one-time Phase 9 migration backfilling a pre-Phase-9 row that
  // used to double as both the CRM campaign AND its Meta campaign (see
  // migration 0009), or - as of the sync pipeline auto-mapping a brand-new
  // Meta campaign the first time it's ever synced (see
  // syncCampaignsForSelectedAdAccount in metaCampaignService.ts) -
  // ongoing, going forward. Either way this is only ever a starting point:
  // a "meta_sync" row is a completely normal campaigns row from that
  // moment on, freely renamable/reassignable, and re-mapping a Meta
  // campaign to a DIFFERENT existing CRM campaign never creates or renames
  // a `campaigns` row - that still only happens on first sync. Not a DB
  // enum, same convention as every other status/source column in this
  // schema.
  source: text("source").notNull().default("manual"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  companyIdx: index("ix_campaigns_company_id").on(t.companyId),
  statusIdx: index("ix_campaigns_status").on(t.status),
  branchIdx: index("ix_campaigns_branch_id").on(t.branchId),
}));

/**
 * THE META CAMPAIGN - an external Meta object ("Ahmedabad 3BHK Leads",
 * meta_campaign_id 123456), synced automatically once a tenant selects an
 * Ad Account (see src/application/metaSync/metaCampaignService.ts). Exists
 * independently of any CRM campaign - crmCampaignId starts null
 * ("unmapped") and is only ever set by an explicit user action ("map to
 * CRM campaign" on the Campaigns screen), never by the sync itself (a
 * re-sync only ever refreshes name/status/lastSyncAt, see
 * upsertMetaCampaign's own comment). Many meta_campaigns rows may point at
 * the same crmCampaignId - "a CRM campaign can be connected to one or more
 * Meta campaigns" - there is deliberately no uniqueness constraint on
 * crmCampaignId enforcing 1:1.
 *
 * meta_ad_sets (and, through them, meta_ads) hang off THIS table now, not
 * `campaigns` - the Meta ad hierarchy (Campaign -> Ad Set -> Ad) belongs
 * entirely to the Meta campaign, never to the CRM campaign it may or may
 * not be mapped to.
 */
export const metaCampaigns = crm.table(
  "meta_campaigns",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Which of the tenant's synced ad accounts this campaign was pulled
    // from. ON DELETE SET NULL: losing access to an ad account must never
    // delete the synced campaign or the leads/mapping attached to it.
    metaAdAccountId: uuid("meta_ad_account_id").references(() => metaAdAccounts.id, { onDelete: "set null" }),
    // THE mapping - null until a person explicitly maps this Meta campaign
    // to a CRM campaign (see mapMetaCampaignToCrmCampaign). ON DELETE SET
    // NULL: deleting the CRM campaign unmaps the Meta campaign rather than
    // deleting Meta's own synced record of it.
    crmCampaignId: uuid("crm_campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    // Meta's OWN ad campaign id (raw Graph API id) - plain text, same
    // "Meta's id, not ours" convention as leads.campaignId.
    metaCampaignId: text("meta_campaign_id").notNull(),
    name: text("name").notNull(),
    // Meta's OWN status vocabulary (active/paused/archived/deleted,
    // lowercased) - deliberately NOT forced into the CRM's own
    // draft/active/paused/archived catalog the way the old conflated
    // `campaigns.status` was, since this row is a representation of an
    // external object, not a CRM-owned one. Not a DB enum, same convention
    // as every other status column in this schema.
    status: text("status").notNull().default("active"),
    // Meta's OWN campaign schedule (Graph API `start_time`/`stop_time` on
    // the campaign node) - surfaced read-only in the Performance popup
    // (campaigns.html) so a person can see when a campaign ran without
    // leaving RUTA. `stopTime` is nullable: an ad set with no end date
    // configured (runs until paused) simply has no stop_time on Meta's
    // side either - never defaulted/guessed here, always what Meta itself
    // reports, including null.
    startTime: timestamp("start_time", { withTimezone: true }),
    stopTime: timestamp("stop_time", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_campaigns_tenant_id").on(t.tenantId),
    crmCampaignIdx: index("ix_meta_campaigns_crm_campaign_id").on(t.crmCampaignId),
    adAccountIdx: index("ix_meta_campaigns_meta_ad_account_id").on(t.metaAdAccountId),
    // Re-running a sync can never create two rows for the same Meta ad
    // campaign within one tenant - same "safe to run multiple times"
    // requirement the old partial index on `campaigns` enforced.
    tenantMetaCampaignIdx: uniqueIndex("ux_meta_campaigns_tenant_meta_campaign").on(t.tenantId, t.metaCampaignId),
  }),
);

// ---------------------------------------------------------------------------
// Meta asset hierarchy synced under a selected ad account: Campaign (see
// metaCampaigns above) -> Ad Set -> Ad. As of Phase 9 this hierarchy hangs
// entirely off metaCampaigns, never off the CRM `campaigns` table.
// ---------------------------------------------------------------------------

/** A Meta ad set under one synced Meta campaign (metaCampaigns row). */
export const metaAdSets = crm.table(
  "meta_ad_sets",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Phase 9: the Meta ad hierarchy belongs to the META campaign, never
    // the CRM campaign it may or may not be mapped to - this used to
    // reference `campaigns` directly (back when a synced campaign WAS a
    // `campaigns` row); see migration 0009 for the backfill.  Cascades -
    // an ad set cannot outlive its parent Meta campaign row.
    metaCampaignId: uuid("meta_campaign_id").notNull().references(() => metaCampaigns.id, { onDelete: "cascade" }),
    // Denormalized for scoping/lookups that don't need the campaign join -
    // ON DELETE SET NULL (not cascade): losing the ad account row itself
    // (never actually deleted by this app today) must not delete synced ad
    // sets, same "CRM data outlives a revoked/removed connection" posture
    // metaCampaigns.metaAdAccountId already takes.
    metaAdAccountId: uuid("meta_ad_account_id").references(() => metaAdAccounts.id, { onDelete: "set null" }),
    // Meta's own ad set id - plain text, same convention as every other
    // "Meta's id, not ours" column in this schema.
    adSetId: text("ad_set_id").notNull(),
    adSetName: text("ad_set_name").notNull(),
    // Loosely mirrors Meta's own status (ACTIVE/PAUSED/ARCHIVED/DELETED,
    // lowercased) - not a DB enum, same convention as every other status
    // column here.
    status: text("status").notNull().default("active"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_ad_sets_tenant_id").on(t.tenantId),
    metaCampaignIdx: index("ix_meta_ad_sets_meta_campaign_id").on(t.metaCampaignId),
    // "must be unique within the appropriate tenant/context" (Phase 6) -
    // re-running a sync can never create two rows for the same Meta ad set.
    tenantAdSetIdx: uniqueIndex("ux_meta_ad_sets_tenant_ad_set").on(t.tenantId, t.adSetId),
  }),
);

/** A Meta ad under one synced ad set. */
export const metaAds = crm.table(
  "meta_ads",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    adSetId: uuid("ad_set_id").notNull().references(() => metaAdSets.id, { onDelete: "cascade" }),
    // Meta's own ad id - plain text, same convention as above. This is the
    // same kind of id leads.adId / meta_lead_events.adId already carry as
    // raw ingestion data - this table is the synced *catalog* of ads, those
    // are per-lead attribution snapshots; deliberately not cross-referenced.
    adId: text("ad_id").notNull(),
    adName: text("ad_name").notNull(),
    status: text("status").notNull().default("active"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_ads_tenant_id").on(t.tenantId),
    adSetIdx: index("ix_meta_ads_ad_set_id").on(t.adSetId),
    tenantAdIdx: uniqueIndex("ux_meta_ads_tenant_ad").on(t.tenantId, t.adId),
  }),
);

// ---------------------------------------------------------------------------
// WhatsApp Lead Capture feature - discovered WhatsApp assets, resolved
// lead-approach routing, and inbound message durability. All three follow
// the exact same shape/conventions as their Meta-Instant-Form counterparts
// above (meta_pages / meta_lead_events) - see each table's own comment for
// what it mirrors and why.
// ---------------------------------------------------------------------------

/**
 * A WhatsApp Business phone number the tenant's connected Meta Business
 * Manager account owns, discovered automatically through the SAME Meta
 * connection used for Pages/ad accounts (Phase 5: "the customer does not
 * manually enter a WhatsApp Business Account ID, Phone Number ID, or
 * webhook URL") - never typed in by the tenant, only ever selected from
 * what discovery finds. Mirrors meta_pages' shape/selection pattern
 * exactly: isSelected is single-select-per-tenant (a tenant sends/receives
 * through exactly one WhatsApp number in this CRM at a time), enforced the
 * same way (a partial unique index), because that's the number
 * processWhatsAppMessageEvent.ts resolves inbound webhook events against.
 */
export const metaWhatsappAccounts = crm.table(
  "meta_whatsapp_accounts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    metaConnectionId: uuid("meta_connection_id").notNull().references(() => metaConnections.id, { onDelete: "cascade" }),
    // Meta's own WhatsApp Business Account id (the Graph API node this
    // phone number hangs off) - plain text, same "Meta's id, not ours"
    // convention as meta_pages.pageId.
    wabaId: text("waba_id").notNull(),
    wabaName: text("waba_name"),
    // Meta's own phone_number_id (the id used on every Cloud API call and
    // the id the inbound webhook's metadata.phone_number_id carries -
    // THIS is how an inbound message is resolved back to a tenant, see
    // processWhatsAppMessageEvent.ts).
    phoneNumberId: text("phone_number_id").notNull(),
    // Meta's own display_phone_number ("+91 XXXXX XXXXX") - shown to the
    // tenant as-is; the CRM never formats or validates this itself.
    displayPhoneNumber: text("display_phone_number"),
    verifiedName: text("verified_name"),
    isSelected: boolean("is_selected").notNull().default(false),
    // Mirrors meta_pages' webhook_subscribed/webhook_status/webhook_last_error
    // columns exactly (see metaPages below) - whether THIS specific WABA has
    // actually been subscribed to send its `messages` events to this app's
    // webhook. Discovering/selecting a number is necessary but NOT
    // sufficient for inbound messages to ever arrive - Meta only delivers
    // webhook events for a WABA that was explicitly subscribed via
    // POST /{waba-id}/subscribed_apps (see metaWhatsappWebhookService.ts) -
    // so this column exists to make that second, easy-to-miss step visible
    // and self-healing rather than a silent gap.
    webhookSubscribed: boolean("webhook_subscribed").notNull().default(false),
    webhookStatus: text("webhook_status"), // "active" | "failed" | null (never attempted)
    webhookLastError: text("webhook_last_error"),
    webhookLastVerifiedAt: timestamp("webhook_last_verified_at", { withTimezone: true }),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_whatsapp_accounts_tenant_id").on(t.tenantId),
    connectionIdx: index("ix_meta_whatsapp_accounts_meta_connection_id").on(t.metaConnectionId),
    tenantPhoneNumberIdx: uniqueIndex("ux_meta_whatsapp_accounts_tenant_phone_number").on(t.tenantId, t.phoneNumberId),
    oneSelectedPerTenantIdx: uniqueIndex("ux_meta_whatsapp_accounts_one_selected_per_tenant")
      .on(t.tenantId)
      .where(sql`is_selected = true`),
  }),
);

/**
 * Persistent Meta-ad -> lead-approach routing (Phase 4). Remembers, per
 * synced ad, whether it was resolved as META_INSTANT_FORM or WHATSAPP (or
 * left UNKNOWN) so the webhook processors never have to re-derive this from
 * the Graph API on every incoming event - resolved once by
 * metaLeadApproachResolver.ts right after each campaign sync
 * (metaCampaignService.ts), refreshed on every re-sync. Keyed on the ad
 * (metaAdId), the finest-grained level Meta's own data actually
 * distinguishes at (destination_type lives on the ad SET; the linked lead
 * form lives on the individual AD's creative - see the resolver's own
 * comment) - metaAdSetId is denormalized alongside for lookups that don't
 * need the join. ON DELETE CASCADE on metaAdId: a route is meaningless
 * without the ad it describes; deleting the ad's own catalog row (never
 * done by this app today, but a legitimate future admin action) should
 * simply remove its route too, not orphan it - existing LEAD rows already
 * carry their own attribution snapshot (leads.adId/campaignId/etc.) and are
 * never touched by this table either way.
 */
export const metaLeadRoutes = crm.table(
  "meta_lead_routes",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    metaConnectionId: uuid("meta_connection_id").references(() => metaConnections.id, { onDelete: "set null" }),
    metaAdAccountId: uuid("meta_ad_account_id").references(() => metaAdAccounts.id, { onDelete: "set null" }),
    metaCampaignId: uuid("meta_campaign_id").references(() => metaCampaigns.id, { onDelete: "set null" }),
    metaAdSetId: uuid("meta_ad_set_id").references(() => metaAdSets.id, { onDelete: "set null" }),
    metaAdId: uuid("meta_ad_id").notNull().references(() => metaAds.id, { onDelete: "cascade" }),
    // src/domain/leadApproach.ts LEAD_APPROACHES key - "meta_instant_form" |
    // "whatsapp" | "unknown" (only these three are ever WRITTEN by the
    // resolver today; the catalog's other entries are reserved for future
    // ingestion pipelines this table's shape already supports).
    approach: text("approach").notNull().default("unknown"),
    // src/domain/leadApproach.ts LEAD_APPROACH_CONFIDENCE - "DETERMINED"
    // (resolved from real Meta configuration data) | "UNDETERMINED" (Meta's
    // data did not reliably indicate an approach - approach is "unknown" in
    // this case, never guessed).
    confidence: text("confidence").notNull().default("UNDETERMINED"),
    // Set only when approach = "meta_instant_form" - Meta's own form id
    // (matches meta_forms.formId), resolved from the ad creative's
    // object_story_spec.link_data.call_to_action.value.lead_gen_form_id.
    formId: text("form_id"),
    // Set only when approach = "whatsapp" - the meta_whatsapp_accounts row
    // this ad's Click-to-WhatsApp destination resolves to, when the ad's
    // destination phone number could be matched against a discovered
    // WhatsApp asset for this tenant (nullable even for a WHATSAPP-approach
    // route: Meta's ad-set-level destination_type does not itself name
    // WHICH phone number, so this is best-effort attribution, not a hard
    // requirement for the WHATSAPP classification itself).
    whatsappAccountId: uuid("whatsapp_account_id").references(() => metaWhatsappAccounts.id, { onDelete: "set null" }),
    status: text("status").notNull().default("active"), // active | stale (ad no longer exists/is deleted, see reconciliation)
    // Free-form diagnostic detail (e.g. "no destination_type or
    // lead_gen_form_id present on this ad/ad set") - never a raw API error,
    // never a secret; purely for the Settings screen's "Action required"
    // surfacing and internal logs (Phase 14).
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_meta_lead_routes_tenant_id").on(t.tenantId),
    approachIdx: index("ix_meta_lead_routes_approach").on(t.approach),
    // One route per ad, re-resolved (not re-inserted) on every sync.
    tenantAdIdx: uniqueIndex("ux_meta_lead_routes_tenant_ad").on(t.tenantId, t.metaAdId),
  }),
);

/**
 * WhatsApp inbound-message durability + idempotency (Phase 6/7) - mirrors
 * meta_lead_events exactly: persist BEFORE acking the webhook, unique on
 * (tenantId, waMessageId) so a redelivered WhatsApp webhook (Meta retries
 * on anything but a fast 200) can never create a duplicate Lead, same
 * "durability row is the idempotency backstop, not the Lead insert itself"
 * pattern used throughout this codebase.
 */
export const whatsappMessageEvents = crm.table(
  "whatsapp_message_events",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    tenantId: uuid("tenant_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // Meta's own WhatsApp message id ("wamid...") - THE idempotency key.
    waMessageId: text("wa_message_id").notNull(),
    wabaId: text("waba_id"),
    phoneNumberId: text("phone_number_id"),
    fromPhoneNumber: text("from_phone_number"),
    contactName: text("contact_name"),
    messageType: text("message_type"), // Meta's own messages[].type ("text", "image", ...)
    messageText: text("message_text"),
    // Click-to-WhatsApp ad attribution, when Meta's webhook includes a
    // messages[].referral object - {source_id, source_type, source_url,
    // headline, body, media_type, ctwa_clid}, exactly as Meta documents it
    // (no invented fields). Null for an ordinary organic WhatsApp message
    // with no ad behind it.
    referral: jsonb("referral"),
    rawPayload: jsonb("raw_payload").notNull(),
    // Same status vocabulary as meta_lead_events - "received" | "enqueued" |
    // "processing" | "completed" | "duplicate" | "retrying" | "failed" |
    // "blocked" (Phase 16 - trial/subscription entitlement).
    status: text("status").notNull().default("received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    tenantIdx: index("ix_whatsapp_message_events_tenant_id").on(t.tenantId),
    statusReceivedIdx: index("ix_whatsapp_message_events_status_received_at").on(t.status, t.receivedAt),
    phoneNumberIdx: index("ix_whatsapp_message_events_phone_number_id").on(t.phoneNumberId),
    // Mandatory - prevents a duplicate/redelivered WhatsApp webhook event
    // from ever creating duplicate leads.
    tenantMessageIdx: uniqueIndex("ux_whatsapp_message_events_tenant_message").on(t.tenantId, t.waMessageId),
  }),
);

/**
 * LEGACY per-campaign Meta connection model, kept as-is and fully
 * functional - Phase 2 moves Meta AUTHENTICATION to the tenant level (see
 * metaConnections/metaPages/metaAdAccounts/metaForms above) without
 * deleting or migrating this table. Every existing campaign and its
 * webhook config keeps working exactly as before; a later phase decides
 * how/whether to backfill existing rows here into the new tenant-level
 * tables and retire this one.
 *
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
    // WhatsApp Lead Capture feature (Phase 1) - the HOW, orthogonal to
    // `source`'s WHERE. Nullable and additive: every lead captured before
    // this feature existed is simply null here, treated by the UI exactly
    // like the explicit "unknown" catalog entry (see
    // src/domain/leadApproach.ts leadApproachLabel) - no backfill
    // migration reclassifies historical rows. Not a DB enum, same
    // convention as every other status/source column in this schema; see
    // src/domain/leadApproach.ts LEAD_APPROACHES for the fixed catalog
    // ("meta_instant_form" | "whatsapp" | "website" | "messenger" |
    // "instagram" | "phone" | "manual" | "unknown"). Stamped going forward
    // by processMetaLeadEvent.ts ("meta_instant_form") and the new
    // processWhatsAppMessageEvent.ts ("whatsapp") - never guessed from a
    // campaign/ad name.
    leadApproach: text("lead_approach"),
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

    // Rule-based lead quality scoring (v1 - see src/domain/leadQuality.ts).
    // All three are null for a digital lead captured before this feature
    // existed, AND for every manually-entered customer (insertManualLead
    // never sets these - a human already vetted that record by typing it
    // in themselves) - always distinct from an actual computed score of 0.
    // Never gates or blocks a lead's insert; a scoring failure just leaves
    // these null rather than losing the lead (see scoreLeadSafely in
    // repositories.ts).
    qualityScore: integer("quality_score"), // 0-100, higher is better
    qualityLabel: text("quality_label"), // "hot" | "warm" | "cold" | "likely_fake"
    qualityFlags: jsonb("quality_flags").notNull().default(sql`'[]'::jsonb`), // string[] of human-readable reasons
    qualityScoredAt: timestamp("quality_scored_at", { withTimezone: true }),

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
    // Justified by the new Leads UI's "Lead Approach" filter (Phase 10) -
    // same "filter column gets an index" convention as pipelineStageIdx/
    // leadTypeIdx above.
    leadApproachIdx: index("ix_leads_lead_approach").on(t.leadApproach),
    ownerIdx: index("ix_leads_owner_id").on(t.ownerId),
    branchIdx: index("ix_leads_branch_id").on(t.branchId),
    companyBranchIdx: index("ix_leads_company_id_branch_id").on(t.companyId, t.branchId),
    // Backs hasRecentLeadWithSameContact's duplicate-submission lookup
    // (repositories.ts) - one new lead's quality check queries this by
    // (companyId, phoneNumber) on every insert, so it's worth an index
    // rather than a table scan.
    companyPhoneIdx: index("ix_leads_company_id_phone_number").on(t.companyId, t.phoneNumber),
  }),
);

// A salesperson-logged follow-up entry against a lead/customer - the
// structured history behind the Pipeline page's lead-details popup ("Follow-
// ups" section). Deliberately separate from `leads.notes` (a single freeform
// field) and `leads.nextFollowUpAt` (just the next due date): this table is
// an append-only log of every call/contact attempt made, each with its own
// remarks/outcome/timestamp/author, so a salesperson can see the full
// history of contact with a lead, not just the latest note. Logging an entry
// with a `nextFollowUpAt` also updates the parent lead's own
// `nextFollowUpAt` column (see insertLeadFollowUp in repositories.ts) so the
// list view's "Next follow-up" column always reflects the latest one set
// here, without duplicating date-tracking logic in two places.
export const leadFollowUps = crm.table(
  "lead_follow_ups",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Denormalized alongside leadId (rather than joining through leads for
    // every tenant-isolation check) - same defense-in-depth pattern as other
    // company-scoped tables in this file.
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    remarks: text("remarks").notNull(),
    // Small fixed catalog (connected/no_answer/left_voicemail/not_interested/
    // rescheduled/converted/other) enforced at the application layer, not a
    // DB enum, so adding an outcome later never needs a migration - see
    // FOLLOW_UP_OUTCOMES in public/pipeline.html and api/leads/handler.ts.
    outcome: text("outcome"),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    // Who logged this entry. Nullable + ON DELETE SET NULL (not NOT NULL) so
    // a user being removed later never breaks or deletes the follow-up
    // history they left behind - same reasoning as leads.ownerId.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    leadIdx: index("ix_lead_follow_ups_lead_id").on(t.leadId),
    companyIdx: index("ix_lead_follow_ups_company_id").on(t.companyId),
    createdAtIdx: index("ix_lead_follow_ups_created_at").on(t.createdAt),
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

/** Platform operators are deliberately independent from customer users.
 * They do not belong to a company, agency, or client relationship. */
export const platformAdmins = crm.table("platform_admins", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  fullName: text("full_name").notNull(),
  status: text("status").notNull().default("active"),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  emailIdx: uniqueIndex("ux_platform_admins_email").on(t.email),
  statusIdx: index("ix_platform_admins_status").on(t.status),
}));

// ---------------------------------------------------------------------------
// Billing - Razorpay overage orders (extra campaign/client capacity bought
// on top of a plan's base allowance - see companies.extraCampaignSlots/
// extraClientSlots above for where a PAID order actually lands, and
// src/application/billing.ts for the flow end to end).
// ---------------------------------------------------------------------------

/**
 * One row per Razorpay Order this app has ever created for an overage
 * purchase - created in "created" status the moment the /api/billing/order
 * endpoint asks Razorpay for an order (before the buyer has paid anything),
 * then flipped to "paid" exactly once by whichever of the two independent
 * confirmation paths gets there first:
 *   1. The BROWSER round-trip - Checkout.js hands the completed payment's
 *      razorpay_payment_id/razorpay_signature back to /api/billing/verify,
 *      which HMAC-verifies them and applies capacity immediately (fast
 *      path - the buyer sees their new limit right away).
 *   2. The Razorpay WEBHOOK (payment.captured) - the authoritative
 *      fallback for when step 1 never completes (buyer closes the tab
 *      mid-payment, a network blip eats the browser's own verify call,
 *      etc.) - see api/webhooks/meta/handler.ts's razorpay-webhook branch.
 * Both paths go through markBillingOrderPaid()'s conditional "UPDATE ...
 * WHERE status = 'created'" (src/infrastructure/db/repositories/
 * billing.ts) - only the one that actually wins that race applies
 * companies.extraCampaignSlots/extraClientSlots; the loser just stamps its
 * own confirmation timestamp. This is what makes a duplicate webhook
 * delivery (Razorpay's own docs say to expect retries) or a buyer
 * refreshing the success page never grant capacity twice for one payment.
 *
 * razorpayOrderId is UNIQUE and is the join key both paths look this row
 * up by - never companyId+quantity+cycle, which could collide across two
 * genuinely separate purchases.
 */
export const billingOrders = crm.table(
  "billing_orders",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
    // Always the PAYING company - for an agency's overage purchase this is
    // the agency's own id, never a client's (a client never buys a plan of
    // its own - see companies.extraCampaignSlots' own comment above and
    // resolvePoolRootCompanyId in src/application/billing.ts, which is what
    // guarantees this is always the correct root before an order is ever
    // created).
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    // The user who clicked "Pay" - nullable + ON DELETE SET NULL, same
    // "never let removing a user delete history" posture as every other
    // createdBy column in this schema.
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    // "individual_campaigns" | "agency_bundles" - see OverageKind in
    // src/domain/billing.ts. Determines both the unit price this order was
    // priced at and what buying `quantity` of it actually grants (raw
    // campaign slots vs. client+campaign bundles) - see
    // overageSlotsForQuantity().
    kind: text("kind").notNull(),
    // How many units of `kind` this order is for (raw campaigns for
    // Individual, bundles for Agency) - always a positive whole number,
    // validated at the API layer before an order is ever created.
    quantity: integer("quantity").notNull(),
    // "monthly" | "quarterly" | "halfyearly" | "yearly" - see BillingCycle
    // in src/domain/billing.ts. Which upfront cycle this specific purchase
    // paid for; drives both the price charged (computeOverageAmountInPaise)
    // and how far out extraCapacityExpiresAt is pushed once paid.
    cycle: text("cycle").notNull(),
    // Razorpay's own smallest-unit convention (paise, not rupees) - the
    // exact amount the Razorpay Order was created for, snapshotted here so
    // this row is a true historical receipt even if the pricing catalog in
    // src/domain/billing.ts changes later.
    amountInPaise: integer("amount_in_paise").notNull(),
    currency: text("currency").notNull().default("INR"),
    // Razorpay's own order id (order_XXXXXXXX) - the id Checkout.js opens
    // client-side and the id both confirmation paths look this row up by.
    // UNIQUE: exactly one billing_orders row per Razorpay order, ever.
    razorpayOrderId: text("razorpay_order_id").notNull(),
    // Populated once a payment attempt against this order completes -
    // Razorpay's own payment id (pay_XXXXXXXX). Null while status is still
    // "created" (order exists, nobody has paid yet).
    razorpayPaymentId: text("razorpay_payment_id"),
    // The razorpay_signature Checkout.js returned alongside
    // razorpayPaymentId - kept for audit only (the HMAC check itself
    // already happened before this row was ever marked "paid"; this is not
    // re-validated on read). Null for a webhook-only confirmation (the
    // webhook carries no browser-side signature triple of its own - see
    // confirmOveragePaymentFromWebhook's own comment).
    razorpaySignature: text("razorpay_signature"),
    // "created" | "paid" | "failed" - not a DB enum, same convention as
    // every other status column in this schema. The ONLY column
    // markBillingOrderPaid's conditional UPDATE gates on - see this
    // table's own doc comment above for why that matters.
    status: text("status").notNull().default("created"),
    // Set when the BROWSER round-trip (step 1 above) is what won the
    // created->paid race for this order. Independent of
    // webhookConfirmedAt below - a genuinely paid order commonly has only
    // one of the two set, and that is expected, not a data-quality problem.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // Set whenever the Razorpay webhook (step 2 above) has independently
    // confirmed this payment - whether or not IT was the one that won the
    // created->paid race (see stampBillingOrderWebhookConfirmed's own
    // comment: an order the browser round-trip already paid still gets
    // this stamped for the audit trail).
    webhookConfirmedAt: timestamp("webhook_confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
  },
  (t) => ({
    companyIdx: index("ix_billing_orders_company_id").on(t.companyId),
    razorpayOrderIdx: uniqueIndex("ux_billing_orders_razorpay_order_id").on(t.razorpayOrderId),
    statusIdx: index("ix_billing_orders_status").on(t.status),
    createdAtIdx: index("ix_billing_orders_created_at").on(t.createdAt),
  }),
);
