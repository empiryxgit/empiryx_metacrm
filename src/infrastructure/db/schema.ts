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
  // The CRM template key (see src/domain/industryTemplates.ts for the
  // fixed catalog - "real_estate" | "solar" today). Drives which pipeline
  // stages, lead/customer fields and list columns the CRM renders for this
  // tenant. Registration no longer asks a new user to pick one (see
  // RegisterInput in src/application/auth.ts) - the NOT NULL default below
  // is what every new company actually gets; the column stays a
  // user-settable input only for any pre-existing account whose
  // industryTemplate was chosen back when registration still asked (never
  // touched or reset by that removal - see the migration notes). Deliberately
  // a separate column from `industry` above - that one is a free-text
  // description, this one is a controlled key the template system indexes
  // by. Never branch on this value directly outside the template lookup -
  // always go through getIndustryTemplate().
  industryTemplate: text("industry_template").notNull().default("real_estate"),
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
  onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
}, (t) => ({
  slugIdx: uniqueIndex("ux_companies_slug").on(t.slug),
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
    // "completed" | "duplicate" | "retrying" | "failed" - not a DB enum,
    // same convention as every other status column in this schema.
    // "retrying" means this attempt failed but QStash retries remain;
    // "failed" is the terminal state, set only once by the dead-letter
    // callback when retries are exhausted. "enqueued" and "duplicate" are
    // two additional internal states beyond the user-facing
    // RECEIVED/PROCESSING/COMPLETED/FAILED/RETRYING model: "enqueued" is
    // load-bearing for the reconciliation sweep (getUnenqueuedMetaLeadEvents),
    // and "duplicate" is a legitimate non-failure terminal outcome.
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
