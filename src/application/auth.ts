import {
  createAgencyFixedRoles,
  createCompany,
  getCompanyById,
  createOwnerRole,
  createUser,
  emailExists,
  getRoleById,
  getUserByEmail,
  getUserById,
  slugExists,
  touchLastLogin,
  createSession,
  getActiveSessionByHash,
  getSessionByHashIncludingRevoked,
  revokeAllSessionsForUser,
  revokeSession,
  setCompanyCreatedBy,
  completeOnboarding,
} from "../infrastructure/db/repositories/tenancy";
import { getUserBranchIds } from "../infrastructure/db/repositories/branches";
import { getUserAssignedClientIds } from "../infrastructure/db/repositories/agencyClientAssignments";
import { hashPassword, verifyPassword } from "../infrastructure/auth/password";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  SESSION_REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
} from "../infrastructure/auth/tokens";
import { INDUSTRY_KEYS, getIndustryTemplate, type IndustryKey } from "../domain/industryTemplates";
import { resolveAccountType } from "../domain/accountType";
import { trialEndDate } from "../domain/trial";
import { isFullAccessSystemRoleName, fullAccessPermissionsForRoleName } from "../domain/fixedRoles";
import { provisionDefaultForms } from "../infrastructure/db/repositories/forms";
import { recordAgencyAuditEvent } from "./agencyAuditLog";
import { upsertUserWhatsappLink } from "../infrastructure/db/repositories/whatsapp";
import { sendOnboardingWelcomeMessage } from "./metaSync/rutaAiAssistant";

/** The built-in "full access" system roles (the legacy single "Owner" role,
 * plus AGENCY_OWNER/CLIENT_OWNER from the fixed role catalogs - see
 * isFullAccessSystemRoleName's own comment) are documented as "always holds
 * every permission, cannot be edited" - but their `permissions` column is a
 * point-in-time snapshot taken when the role was created, so it silently
 * falls behind whenever a new PERMISSIONS.* constant is added later. Rather
 * than requiring a data migration every time that happens, those specific
 * roles are always granted the current live full permission set (see
 * fullAccessPermissionsForRoleName - AGENCY_OWNER alone additionally gets
 * AGENCY_CLIENTS_VIEW_ALL, the "All clients" access rule; "Owner" and
 * CLIENT_OWNER never do, since it's meaningless for them) at the point
 * they're turned into a token/response. Every OTHER isSystem role (the
 * tiered AGENCY_ADMIN/MANAGER/USER and CLIENT_ADMIN/MANAGER/USER roles -
 * isSystem only means "cannot be edited/deleted via the admin UI", not
 * "always full access") reads its stored `permissions` column literally,
 * same as any fully custom role - see api/admin/roles/handler.ts's isSystem
 * check for where "cannot be edited" is actually enforced. */
function effectivePermissions(role: { isSystem: boolean; name: string; permissions: unknown }): string[] {
  return role.isSystem && isFullAccessSystemRoleName(role.name)
    ? fullAccessPermissionsForRoleName(role.name)
    : (role.permissions as string[]);
}

export class AuthError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

// Exported for src/application/agency.ts's addClientOrganization(), which
// needs the exact same "make a unique slug from a display name" logic when
// an agency creates a brand-new client company - kept here as the one
// place this logic lives rather than duplicated.
export async function uniqueSlug(base: string): Promise<string> {
  let candidate = slugify(base) || "company";
  let suffix = 0;
  while (await slugExists(candidate)) {
    suffix++;
    candidate = `${slugify(base)}-${suffix}`;
  }
  return candidate;
}

export interface RegisterInput {
  companyName: string;
  fullName: string;
  email: string;
  password: string;
  // Which CRM template to provision the company with (see
  // src/domain/industryTemplates.ts's INDUSTRY_KEYS for the full catalog).
  // Registration no longer collects this from the user - public/register.html
  // never sends it, so every new signup gets the default below: "general",
  // i.e. plain Core CRM with no industry specialization at all, never a
  // named industry picked on their behalf. Kept optional (rather than
  // removed) only for backward compatibility with any existing direct API
  // caller that still sends it; a value here is still honored if present -
  // the company can always pick (or change) a real industry template later
  // from Settings -> Business Configuration -> Industry/Template. Defaults
  // to "general" for any missing/unrecognized value rather than rejecting
  // registration outright - see resolveIndustryKey().
  industry?: string;
  // Whether this tenant is a single individual or an agency/team - see
  // src/domain/accountType.ts. Collected by public/register.html's second
  // step (Basic Information -> Account Type -> Create Account). Optional
  // here for the same "never hard-fail registration over a classification
  // choice" reason industry is - resolveAccountType() defaults an absent/
  // unrecognized value to "individual" rather than rejecting the request.
  accountType?: string;
  // The registering user's mobile number - collected by both of
  // public/register.html's forms (labeled "Mobile" in each). Unlike
  // industry/accountType, this is genuinely REQUIRED regardless of
  // accountType - see the check in registerCompanyAndOwner below - an
  // account with no way to reach whoever registered it defeats the point
  // of asking for one. Typed optional here only because it arrives as a
  // plain string over the wire before that check runs, same convention as
  // every other field in this interface.
  phoneNumber?: string;
}

function resolveIndustryKey(industry: string | undefined): IndustryKey {
  return INDUSTRY_KEYS.includes(industry as IndustryKey) ? (industry as IndustryKey) : "general";
}

/**
 * Registration IS the first step of company onboarding: it atomically
 * creates the company, its built-in Owner role, and the first user (who
 * holds that role). The onboarding wizard the user lands on next
 * (POST /api/onboarding/company, /api/onboarding/complete) only collects
 * profile details and the first campaign - the tenant itself already
 * exists by the time that flow starts.
 */
export async function registerCompanyAndOwner(input: RegisterInput) {
  if (input.password.length < 10) {
    throw new AuthError("Password must be at least 10 characters.");
  }
  if (await emailExists(input.email)) {
    throw new AuthError("An account with this email already exists.", 409);
  }

  const industryTemplate = resolveIndustryKey(input.industry);
  const accountType = resolveAccountType(input.accountType);
  // Enforced here, not just as an HTML `required` attribute on
  // register.html's Mobile field - a request that skips the client
  // entirely (a direct API call, or a tampered form) must not be able to
  // create an account with no way to reach whoever registered it.
  // Required for every accountType (not just "agency") - see
  // RegisterInput.phoneNumber's own comment above.
  if (!input.phoneNumber?.trim()) {
    throw new AuthError("Mobile number is required.");
  }
  const phoneNumber = input.phoneNumber.trim();

  const slug = await uniqueSlug(input.companyName);
  const passwordHash = await hashPassword(input.password);

  // Not wrapped in a single SQL transaction because the Neon HTTP driver
  // does not support multi-statement transactions over `neon-http` - each
  // step is individually idempotent-safe to retry, and a partial failure
  // here (company created, user creation fails) is recoverable manually
  // since it's a rare, low-volume, admin-visible path (see README).
  // Individual accounts start the guided wizard (NOT_STARTED); agency
  // accounts get no explicit value here at all, so createCompany() falls
  // back to companies.onboardingStatus's own column default ("COMPLETED") -
  // completeOnboarding() below still runs for them regardless, since that's
  // also what stamps onboardingCompletedAt (the actual field App.requireAuth()
  // gates on - see completeOnboarding's own comment).
  // Every brand-new top-level registration (Individual or Agency alike -
  // never a claimed CLIENT company, which is provisioned through
  // createClientOrganization/agencyOnboarding.ts, neither of which pass
  // `trial` here) starts its own 15-day free trial the instant the
  // company row is created - see src/domain/trial.ts for the state this
  // feeds and this feature's own PR description for why trial start can
  // never be a separate, later step (a company with no trial/subscription
  // state at all would fall back to companies.subscriptionStatus's
  // "active, no expiry" column default and be treated as permanently
  // subscribed for free, exactly the grandfathering behavior reserved for
  // genuinely pre-existing companies only).
  const trialStartedAt = new Date();
  const company = await createCompany({
    name: input.companyName,
    slug,
    industryTemplate,
    accountType,
    trial: { startedAt: trialStartedAt, endsAt: trialEndDate(trialStartedAt) },
    ...(accountType === "agency" ? {} : { onboardingStatus: "NOT_STARTED" as const }),
  });
  // Agency companies get the four fixed AGENCY_OWNER/ADMIN/MANAGER/USER
  // roles (src/domain/fixedRoles.ts) instead of the single generic Owner
  // role every other company gets - the registering user becomes
  // AGENCY_OWNER (full access, sees every client). Every other accountType
  // (just "individual" today) is unaffected - unchanged from before this
  // feature existed.
  const ownerRole =
    accountType === "agency" ? (await createAgencyFixedRoles(company.id)).get("AGENCY_OWNER")! : await createOwnerRole(company.id);
  const user = await createUser({
    companyId: company.id,
    roleId: ownerRole.id,
    email: input.email,
    passwordHash,
    fullName: input.fullName,
    phoneNumber,
  });

  // RUTA AI Assistant activates immediately for the registering owner, same
  // as every other user-creation path (see api/admin/users/handler.ts) -
  // mandatory, zero-verification, no separate setup step. Mobile is already
  // required and validated above for every accountType, so this should
  // always succeed; best-effort regardless, same posture as every other
  // post-creation step here.
  try {
    await upsertUserWhatsappLink(company.id, user.id, phoneNumber);
  } catch (err) {
    console.error("[auth/register] Failed to provision RUTA AI Assistant WhatsApp link:", err);
  }

  // Agency accounts (and, transitively, every agency-onboarded client -
  // see agencyOnboarding.ts's completeAgencyOnboarding) still skip the
  // wizard entirely and land straight on their dashboard, exactly as
  // before this feature existed: Agency Account Created -> Agency
  // Dashboard. This is what actually stamps onboardingCompletedAt (the
  // field App.requireAuth() gates navigation on) - createCompany()'s own
  // column default only covers onboardingStatus, never this timestamp.
  //
  // Individual accounts do NOT call completeOnboarding here - they were
  // already inserted above with onboardingStatus "NOT_STARTED" (step null),
  // which is exactly what starts the guided first-time onboarding wizard
  // (src/domain/onboarding.ts / src/application/onboardingWizard.ts) the
  // next time they load a protected page. See this project's own audit for
  // why an empty dashboard is the wrong first experience for a brand-new
  // individual user. Their RUTA AI welcome message is sent later, from
  // onboardingWizard.ts's completeWizard(), once THEY actually finish
  // onboarding - not here, where it hasn't happened yet for them.
  if (accountType === "agency") {
    // Best-effort, same posture as every other post-creation step here - a
    // failure must never block account creation itself.
    try {
      await completeOnboarding(company.id);
      await sendOnboardingWelcomeMessage(company.id, user.id);
    } catch (err) {
      console.error("[auth/register] Failed to mark onboarding complete:", err);
    }
  }

  // Best-effort backfill of companies.createdBy - the owner user didn't
  // exist yet when createCompany() ran above, so this couldn't be set as
  // part of that insert. Never blocks registration on failure, same
  // posture as provisionDefaultForms below - createdBy is provenance
  // metadata, not something anything else in the app depends on being set.
  try {
    await setCompanyCreatedBy(company.id, user.id);
  } catch (err) {
    console.error("[auth/register] Failed to set company.createdBy:", err);
  }

  // Auto-provision the company's default Forms (one published+default
  // internal form, one draft public form) straight from the industry
  // template - see provisionDefaultForms() for why. Best-effort: a failure
  // here must never block account creation itself (the company/user rows
  // above are already committed) - public/pipeline.html's Add Customer
  // flow falls back to its built-in fixed fields whenever no default
  // internal form exists, so a missing form is degraded, not broken.
  try {
    await provisionDefaultForms(company.id, getIndustryTemplate(industryTemplate), user.id);
  } catch (err) {
    console.error("[auth/register] Failed to provision default forms:", err);
  }

  // AGENCY_CREATED - only for the "agency" accountType (see
  // src/application/agencyAuditLog.ts's header comment for the full 11-event
  // design). The registering user is both the actor and the new agency's
  // first/only user at this point, so agencyUserId = user.id unambiguously;
  // clientCompanyId is null, this event has no client subject.
  if (accountType === "agency") {
    await recordAgencyAuditEvent({
      agencyCompanyId: company.id,
      action: "AGENCY_CREATED",
      agencyUserId: user.id,
      detail: `Agency "${company.name}" registered by ${user.email}`,
    });
  }

  return { company, user, role: ownerRole };
}

export interface LoginInput {
  email: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
  // "Remember me" (login.html's checkbox) - defaults to false (NOT
  // remembered) when omitted, same "forget unless told to remember"
  // default as the sessions table column itself. Determines the session's
  // actual server-side lifetime (REFRESH_TOKEN_TTL_SECONDS vs
  // SESSION_REFRESH_TOKEN_TTL_SECONDS below), which the caller
  // (api/auth/handler.ts) then also mirrors in whether the cookie is
  // persistent or session-only - see cookieOptions in
  // src/infrastructure/auth/tokens.ts.
  rememberMe?: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  rememberMe: boolean;
  user: { id: string; email: string; fullName: string; companyId: string; mustChangePassword: boolean };
}

// Fixed, valid bcrypt hash of a value nobody will ever type in - used only
// to give verifyPassword() something to actually hash-and-compare against
// when no account matches the submitted email (see login() below). This is
// NOT a real credential and matches no account.
const NO_SUCH_USER_DUMMY_HASH = "$2a$12$CwTycUXWue0Thq9StjUM0uJ8w5aM/8FEEB0m5cWZUvVs5FivmyaVW";

export async function login(input: LoginInput): Promise<AuthTokens> {
  const user = await getUserByEmail(input.email);
  // Security hardening: always run a bcrypt comparison, even when no
  // account matches the email, against a fixed dummy hash. bcrypt.compare
  // dominates this handler's response time (tens of milliseconds vs. a
  // sub-millisecond lookup miss), so skipping it for a nonexistent email -
  // as the previous "return early on !user" version did - made "no such
  // account" measurably faster than "wrong password," letting an attacker
  // enumerate valid emails purely from response timing without ever
  // seeing a different error message. Both branches now do the same work
  // and return the exact same generic error either way.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? NO_SUCH_USER_DUMMY_HASH);
  if (!user || user.status !== "active" || !valid) {
    throw new AuthError("Invalid email or password.", 401);
  }

  const company = await getCompanyById(user.companyId);
  if (!company || company.status !== "active") {
    throw new AuthError("Invalid email or password.", 401);
  }

  const role = await getRoleById(user.companyId, user.roleId);
  if (!role) {
    throw new AuthError("Account has no role assigned - contact your administrator.", 403);
  }

  const [branchIds, assignedClientIds] = await Promise.all([getUserBranchIds(user.id), getUserAssignedClientIds(user.id)]);
  const accessToken = await signAccessToken({
    sub: user.id,
    companyId: user.companyId,
    roleId: user.roleId,
    permissions: effectivePermissions(role),
    branchIds,
    assignedClientIds,
  });

  const rememberMe = input.rememberMe === true;
  const { token: refreshToken, hash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + (rememberMe ? REFRESH_TOKEN_TTL_SECONDS : SESSION_REFRESH_TOKEN_TTL_SECONDS) * 1000);
  await createSession({
    userId: user.id,
    refreshTokenHash: hash,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
    expiresAt: refreshExpiresAt,
    rememberMe,
  });

  await touchLastLogin(user.id);

  return {
    accessToken,
    refreshToken,
    refreshExpiresAt,
    rememberMe,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

export async function refresh(refreshToken: string): Promise<AuthTokens> {
  const hash = hashRefreshToken(refreshToken);
  const session = await getActiveSessionByHash(hash);
  if (!session) {
    // Security hardening - refresh token reuse detection. Refresh tokens
    // rotate on every single use (see the revokeSession call below), so a
    // legitimate client only ever presents the ONE most recently issued
    // token. If the hash presented here matches a session that DOES exist
    // but is already revoked, that token has already been used once before
    // - either a client-side race (rare, and self-corrects on next login)
    // or, more importantly, a leaked refresh token being replayed by
    // someone who isn't the current legitimate holder of it. Either way,
    // OWASP's guidance for rotation-based refresh tokens is the same: treat
    // reuse of a retired token as a compromise signal and burn the ENTIRE
    // session family for that user, not just this one 401 - this is what
    // actually stops a stolen-but-not-yet-detected refresh token from
    // quietly staying valid indefinitely alongside the legitimate user's.
    const stale = await getSessionByHashIncludingRevoked(hash);
    if (stale && stale.revokedAt) {
      console.warn(`[auth] Refresh token reuse detected for user ${stale.userId} - revoking all sessions.`);
      await revokeAllSessionsForUser(stale.userId);
    }
    throw new AuthError("Session expired or revoked. Please log in again.", 401);
  }

  const user = await getUserById(session.userId);
  if (!user || user.status !== "active") {
    throw new AuthError("Account no longer active.", 401);
  }
  const role = await getRoleById(user.companyId, user.roleId);
  if (!role) {
    throw new AuthError("Account has no role assigned - contact your administrator.", 403);
  }

  // Rotate: revoke the used refresh token and issue a new one. Limits the
  // blast radius of a stolen refresh token to a single use.
  await revokeSession(session.id);

  const [branchIds, assignedClientIds] = await Promise.all([getUserBranchIds(user.id), getUserAssignedClientIds(user.id)]);
  const accessToken = await signAccessToken({
    sub: user.id,
    companyId: user.companyId,
    roleId: user.roleId,
    permissions: effectivePermissions(role),
    branchIds,
    assignedClientIds,
  });
  const { token: newRefreshToken, hash: newHash } = generateRefreshToken();
  // Carry the ORIGINAL login's "remember me" choice forward across every
  // rotation, from the session row being renewed - never re-derived or
  // defaulted here. Without this, a not-remembered (short) session would
  // silently become a 30-day one the moment app.js's silent-refresh-on-401
  // logic fired, which defeats "remember me" unchecked entirely: a tenant
  // who deliberately left it unchecked on a shared computer would end up
  // remembered anyway as soon as their access token expired and refreshed
  // once, often within the hour.
  const rememberMe = session.rememberMe;
  const refreshExpiresAt = new Date(Date.now() + (rememberMe ? REFRESH_TOKEN_TTL_SECONDS : SESSION_REFRESH_TOKEN_TTL_SECONDS) * 1000);
  await createSession({ userId: user.id, refreshTokenHash: newHash, expiresAt: refreshExpiresAt, rememberMe });

  return {
    accessToken,
    refreshToken: newRefreshToken,
    refreshExpiresAt,
    rememberMe,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
    },
  };
}

export async function logout(refreshToken: string): Promise<void> {
  const hash = hashRefreshToken(refreshToken);
  const session = await getActiveSessionByHash(hash);
  if (session) {
    await revokeSession(session.id);
  }
}
