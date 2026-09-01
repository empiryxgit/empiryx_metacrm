import { and, eq, inArray, ne } from "drizzle-orm";
import { getDb } from "../client";
import { companies, roles, sessions, users } from "../schema";
import { firstOrThrow } from "../util";
import { ALL_PERMISSIONS } from "../../../domain/permissions";
import {
  AGENCY_ROLE_DESCRIPTIONS,
  AGENCY_ROLE_NAMES,
  AGENCY_ROLE_PERMISSIONS,
  CLIENT_ROLE_DESCRIPTIONS,
  CLIENT_ROLE_NAMES,
  CLIENT_ROLE_PERMISSIONS,
  type AgencyRoleName,
  type ClientRoleName,
} from "../../../domain/fixedRoles";
import {
  FIRST_ONBOARDING_STEP,
  resolveOnboardingStatus,
  resolveOnboardingStep,
  type OnboardingStatus,
  type OnboardingStep,
} from "../../../domain/onboarding";

// ---- Companies --------------------------------------------------------

export async function createCompany(input: {
  name: string;
  slug: string;
  industryTemplate: string;
  accountType: string;
  // Deliberately optional and omitted by every existing caller today -
  // leaving it unset lets Postgres apply companies.onboardingStatus's own
  // column default ("COMPLETED"), preserving every current registration
  // path's behavior exactly as-is. Only a caller that has ALREADY decided
  // this company should start the guided wizard (see this phase's own
  // report on why that wiring is deferred to a later phase, not wired in
  // here) would ever pass "NOT_STARTED".
  onboardingStatus?: OnboardingStatus;
}) {
  const db = await getDb();
  const rows = await db.insert(companies).values(input).returning();
  return firstOrThrow(rows);
}

export async function getCompanyById(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  return row ?? null;
}

export async function slugExists(slug: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ id: companies.id }).from(companies).where(eq(companies.slug, slug)).limit(1);
  return Boolean(row);
}

/** Best-effort backfill of companies.createdBy right after the owner user is
 * created (see registerCompanyAndOwner in src/application/auth.ts) - the
 * user doesn't exist yet at the moment createCompany() itself runs, so this
 * is a deliberate second step, not part of the insert. */
export async function setCompanyCreatedBy(companyId: string, userId: string) {
  const db = await getDb();
  await db.update(companies).set({ createdBy: userId, updatedAt: new Date() }).where(eq(companies.id, companyId));
}

export async function updateCompanyProfile(
  companyId: string,
  // `name` added for the onboarding wizard's Business Profile step (PHASE
  // 6) - lets it correct/confirm the business name collected at
  // registration without a separate rename endpoint. Every existing caller
  // (the legacy api/onboarding/handler.ts handleCompany) is unaffected -
  // `name` is simply never present in its input object.
  input: { name?: string; industry?: string; companySize?: string; timezone?: string },
) {
  const db = await getDb();
  await db.update(companies).set({ ...input, updatedAt: new Date() }).where(eq(companies.id, companyId));
}

/**
 * Persists the guided onboarding wizard's own new fields (PHASE 6/7/9) -
 * website, leadTerminology, selectedLeadSources - deliberately kept
 * separate from updateCompanyProfile above rather than folded into it: that
 * function is also the legacy onboarding handler's company-profile save
 * path (api/onboarding/handler.ts's handleCompany), and none of these three
 * fields exist in that flow's own request shape. Every field here is
 * optional and independent - a caller sets only whichever field(s) the
 * current wizard step just collected, leaving the others (and any company
 * row entirely predating this wizard) untouched.
 */
export async function updateOnboardingProfileFields(
  companyId: string,
  input: { website?: string; leadTerminology?: string; selectedLeadSources?: string[] },
) {
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ("website" in input) set.website = input.website;
  if ("leadTerminology" in input) set.leadTerminology = input.leadTerminology;
  if ("selectedLeadSources" in input) set.selectedLeadSources = input.selectedLeadSources;
  await db.update(companies).set(set).where(eq(companies.id, companyId));
}

/**
 * Settings -> Business Configuration -> Industry/Template - see
 * api/onboarding/handler.ts's handleBusinessConfig, the only caller. Every
 * value here has ALREADY been validated by that caller (industryTemplate
 * against INDUSTRY_KEYS, customTemplateConfig - when present - via
 * validateCustomTemplateConfig) before this ever runs; this function just
 * writes what it's given. `customTemplateConfig` is deliberately OPTIONAL
 * and independent of `industryTemplate`: omitting it here leaves whatever a
 * company already saved untouched, so switching to a built-in template and
 * back to "custom" later never loses a saved custom draft - only an
 * explicit customTemplateConfig in the request ever overwrites it (passing
 * `null` explicitly is how a caller would ever clear it, though today's
 * handler never does). */
export async function updateBusinessConfiguration(
  companyId: string,
  input: { industryTemplate: string; customTemplateConfig?: unknown },
) {
  const db = await getDb();
  const set: Record<string, unknown> = { industryTemplate: input.industryTemplate, updatedAt: new Date() };
  if ("customTemplateConfig" in input) set.customTemplateConfig = input.customTemplateConfig;
  await db.update(companies).set(set).where(eq(companies.id, companyId));
}

/**
 * The one place any onboarding flow - the legacy company-profile wizard,
 * agency registration, agency-onboarded-client registration, and (once a
 * later phase wires it in) the new Individual guided wizard - marks a
 * company as fully set up. Extended (not replaced) to also clear the new
 * onboarding_status/onboarding_step columns to COMPLETED/null: every
 * existing caller of this function already means exactly that when it
 * calls this, so this change is invisible to all of them - they get the
 * new columns kept truthfully in sync for free, with no call-site changes
 * required anywhere.
 */
export async function completeOnboarding(companyId: string) {
  const db = await getDb();
  await db
    .update(companies)
    .set({ onboardingCompletedAt: new Date(), onboardingStatus: "COMPLETED" as OnboardingStatus, onboardingStep: null, updatedAt: new Date() })
    .where(eq(companies.id, companyId));
}

// ---- Guided onboarding (Individual users only - see
// src/domain/onboarding.ts's own header comment) ---------------------------

export interface OnboardingState {
  status: OnboardingStatus;
  step: OnboardingStep | null;
  completedAt: Date | null;
}

/** Raw read of a company's onboarding state, resolved through
 * resolveOnboardingStatus()/resolveOnboardingStep() so a hand-edited or
 * legacy row can never surface an invalid status/step to a caller - see
 * those functions' own doc comments for their respective safe-default
 * behavior. Returns null only when the company itself doesn't exist. */
export async function getOnboardingState(companyId: string): Promise<OnboardingState | null> {
  const company = await getCompanyById(companyId);
  if (!company) return null;
  return {
    status: resolveOnboardingStatus(company.onboardingStatus),
    step: resolveOnboardingStep(company.onboardingStep),
    completedAt: company.onboardingCompletedAt,
  };
}

/** NOT_STARTED -> IN_PROGRESS, landing on the first step. The Welcome
 * screen's "Get Started" action (a later phase) is the only caller this is
 * meant for - calling it on a company that is already IN_PROGRESS or
 * COMPLETED is harmless (it unconditionally resets to step 1) but is not
 * how any planned caller uses it, since resuming mid-wizard should always
 * go through setOnboardingStep/getOnboardingState instead of restarting. */
export async function startOnboarding(companyId: string) {
  const db = await getDb();
  await db
    .update(companies)
    .set({ onboardingStatus: "IN_PROGRESS" as OnboardingStatus, onboardingStep: FIRST_ONBOARDING_STEP, updatedAt: new Date() })
    .where(eq(companies.id, companyId));
}

/** Records which step a company has reached. Always forces status to
 * IN_PROGRESS (even if it already was) - callers are expected to have
 * already checked isOnboardingStepUnlocked() against the CURRENT state
 * (via getOnboardingState) before calling this with a new target step; this
 * function itself performs no ordering check, so it must never be exposed
 * directly to a request handler without that check happening first. */
export async function setOnboardingStep(companyId: string, step: OnboardingStep) {
  const db = await getDb();
  await db
    .update(companies)
    .set({ onboardingStatus: "IN_PROGRESS" as OnboardingStatus, onboardingStep: step, updatedAt: new Date() })
    .where(eq(companies.id, companyId));
}

// ---- Roles --------------------------------------------------------------

/** Every new company gets one non-editable Owner role holding every permission. */
export async function createOwnerRole(companyId: string) {
  const db = await getDb();
  const rows = await db
    .insert(roles)
    .values({
      companyId,
      name: "Owner",
      description: "Full access to every area of the account. Cannot be edited or deleted.",
      permissions: ALL_PERMISSIONS,
      isSystem: true,
    })
    .returning();
  return firstOrThrow(rows);
}

/**
 * Seeds the four fixed AGENCY_OWNER/ADMIN/MANAGER/USER roles (see
 * src/domain/fixedRoles.ts) for a brand-new agency company, INSTEAD OF the
 * single generic createOwnerRole() below - only called from
 * registerCompanyAndOwner (src/application/auth.ts) when accountType is
 * "agency". Returns a name -> role map so the caller can pick out
 * AGENCY_OWNER for the registering user without a second query.
 */
export async function createAgencyFixedRoles(companyId: string): Promise<Map<AgencyRoleName, typeof roles.$inferSelect>> {
  const db = await getDb();
  const rows = await db
    .insert(roles)
    .values(
      AGENCY_ROLE_NAMES.map((name) => ({
        companyId,
        name,
        description: AGENCY_ROLE_DESCRIPTIONS[name],
        permissions: AGENCY_ROLE_PERMISSIONS[name],
        isSystem: true,
      })),
    )
    .returning();
  return new Map(rows.map((r) => [r.name as AgencyRoleName, r]));
}

/**
 * Seeds the four fixed CLIENT_OWNER/ADMIN/MANAGER/USER roles for a
 * brand-new client company an agency itself originates - see
 * addClientOrganization/completeAgencyOnboarding
 * (src/application/agency.ts / agencyOnboarding.ts) for the two call sites.
 * A client company an agency merely links via inviteExistingClient
 * deliberately does NOT go through this - that company predates the
 * relationship and keeps whatever role system it already had.
 */
export async function createClientFixedRoles(companyId: string): Promise<Map<ClientRoleName, typeof roles.$inferSelect>> {
  const db = await getDb();
  const rows = await db
    .insert(roles)
    .values(
      CLIENT_ROLE_NAMES.map((name) => ({
        companyId,
        name,
        description: CLIENT_ROLE_DESCRIPTIONS[name],
        permissions: CLIENT_ROLE_PERMISSIONS[name],
        isSystem: true,
      })),
    )
    .returning();
  return new Map(rows.map((r) => [r.name as ClientRoleName, r]));
}

export async function listRoles(companyId: string) {
  const db = await getDb();
  return db.select().from(roles).where(eq(roles.companyId, companyId));
}

export async function getRoleById(companyId: string, roleId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(roles)
    .where(and(eq(roles.companyId, companyId), eq(roles.id, roleId)))
    .limit(1);
  return row ?? null;
}

export async function createRole(input: {
  companyId: string;
  name: string;
  description?: string;
  permissions: string[];
}) {
  const db = await getDb();
  const rows = await db.insert(roles).values({ ...input, isSystem: false }).returning();
  return firstOrThrow(rows);
}

export async function updateRole(
  companyId: string,
  roleId: string,
  input: { name?: string; description?: string; permissions?: string[] },
) {
  const db = await getDb();
  await db
    .update(roles)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(roles.companyId, companyId), eq(roles.id, roleId), eq(roles.isSystem, false)));
}

export async function deleteRole(companyId: string, roleId: string) {
  const db = await getDb();
  await db.delete(roles).where(and(eq(roles.companyId, companyId), eq(roles.id, roleId), eq(roles.isSystem, false)));
}

export async function roleInUse(roleId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.roleId, roleId)).limit(1);
  return Boolean(row);
}

// ---- Users ----------------------------------------------------------------

export async function getUserByEmail(email: string) {
  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  return row ?? null;
}

export async function getUserById(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row ?? null;
}

export async function emailExists(email: string): Promise<boolean> {
  return Boolean(await getUserByEmail(email));
}

export async function createUser(input: {
  companyId: string;
  roleId: string;
  email: string;
  passwordHash: string;
  fullName: string;
  mustChangePassword?: boolean;
  // See users.phoneNumber's own comment in schema.ts - optional, only ever
  // sent today by an Agency registration's "Contact Person" step.
  phoneNumber?: string;
}) {
  const db = await getDb();
  const rows = await db
    .insert(users)
    .values({ ...input, email: input.email.toLowerCase() })
    .returning();
  return firstOrThrow(rows);
}

export async function listUsers(companyId: string) {
  const db = await getDb();
  return db
    .select({
      id: users.id,
      email: users.email,
      fullName: users.fullName,
      status: users.status,
      roleId: users.roleId,
      roleName: roles.name,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.companyId, companyId));
}

/** Users across MULTIPLE companies in one query - the cross-client
 * "Assigned User" filter option list for the Agency Leads report (see
 * getAgencyLeadsReport in src/application/agency.ts), where `companyIds`
 * is always the caller's already-authorized client set. Includes
 * companyId (unlike listUsers, which omits it since that function is
 * already scoped to one known company) so the caller can label which
 * client each user belongs to. Same "repository trusts its caller, no
 * auth of its own" convention as every other repository; empty input
 * short-circuits to `[]`. */
export async function listUsersForCompanies(companyIds: string[]) {
  if (companyIds.length === 0) return [];
  const db = await getDb();
  return db
    .select({ id: users.id, companyId: users.companyId, fullName: users.fullName, email: users.email })
    .from(users)
    .where(inArray(users.companyId, companyIds));
}

export async function updateUser(
  companyId: string,
  userId: string,
  // phoneNumber added for the onboarding wizard's Business Profile step
  // (PHASE 6) - lets it fill in a missing/changed mobile number for the
  // CALLING user, the same column registration itself already writes to
  // (see users.phoneNumber's own schema.ts comment). Every other existing
  // caller of updateUser is unaffected - phoneNumber is simply never
  // present in their input objects.
  input: { roleId?: string; status?: string; fullName?: string; phoneNumber?: string },
) {
  const db = await getDb();
  await db
    .update(users)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(users.companyId, companyId), eq(users.id, userId)));
}

export async function setUserPassword(userId: string, passwordHash: string, mustChangePassword: boolean) {
  const db = await getDb();
  await db.update(users).set({ passwordHash, mustChangePassword, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function touchLastLogin(userId: string) {
  const db = await getDb();
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId));
}

/** True if this is the last active user holding this role in the company - used to stop an
 * admin from locking themselves (or everyone) out by disabling the only Owner-capable account. */
export async function countOtherActiveUsersWithRole(companyId: string, roleId: string, excludingUserId: string) {
  const db = await getDb();
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.companyId, companyId),
        eq(users.roleId, roleId),
        eq(users.status, "active"),
        ne(users.id, excludingUserId),
      ),
    );
  return rows.length;
}

// ---- Sessions ---------------------------------------------------------

export async function createSession(input: {
  userId: string;
  refreshTokenHash: string;
  userAgent?: string;
  ipAddress?: string;
  expiresAt: Date;
  // "Remember me" - see schema.ts's own comment on this column. Optional
  // here (defaults to the column's own `false`) so refresh()'s token
  // rotation, which always knows and passes the real value explicitly,
  // reads no differently from any call site that genuinely means "not
  // remembered" and simply omits it.
  rememberMe?: boolean;
}) {
  const db = await getDb();
  const rows = await db.insert(sessions).values(input).returning();
  return firstOrThrow(rows);
}

export async function getActiveSessionByHash(refreshTokenHash: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, refreshTokenHash))
    .limit(1);
  if (!row || row.revokedAt || row.expiresAt < new Date()) return null;
  return row;
}

// Security hardening: unlike getActiveSessionByHash above, this returns the
// row regardless of revoked/expired state - used ONLY by refresh()'s reuse
// detection (src/application/auth.ts) to tell "this refresh token was never
// issued" apart from "this refresh token WAS issued, but has already been
// rotated out." The latter is the signal that matters: refresh tokens are
// rotated on every use (see revokeSession in refresh()), so a legitimate
// client only ever presents the CURRENT one - a revoked token being replayed
// means either a client bug/race, or that the token leaked and an attacker
// (or the original client, whichever got there second) is now racing the
// rightful owner for it. Either way, the safe response is to burn every
// session for that user, not just silently 401 the replay and let whichever
// side "won" the rotation keep going unnoticed.
export async function getSessionByHashIncludingRevoked(refreshTokenHash: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.refreshTokenHash, refreshTokenHash))
    .limit(1);
  return row ?? null;
}

export async function revokeSession(sessionId: string) {
  const db = await getDb();
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function revokeAllSessionsForUser(userId: string) {
  const db = await getDb();
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, userId));
}
