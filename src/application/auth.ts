import {
  createCompany,
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
} from "../infrastructure/db/repositories/tenancy";
import { getUserBranchIds } from "../infrastructure/db/repositories/branches";
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
import { ALL_PERMISSIONS } from "../domain/permissions";
import { provisionDefaultForms } from "../infrastructure/db/repositories/forms";

/** The built-in Owner role is documented as "always holds every
 * permission, cannot be edited" - but its `permissions` column is a
 * point-in-time snapshot taken when the role was created, so it silently
 * falls behind whenever a new PERMISSIONS.* constant is added later. Rather
 * than requiring a data migration every time that happens, system roles
 * are always granted the current full permission set at the point they're
 * turned into a token/response. */
function effectivePermissions(role: { isSystem: boolean; permissions: unknown }): string[] {
  return role.isSystem ? ALL_PERMISSIONS : (role.permissions as string[]);
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

async function uniqueSlug(base: string): Promise<string> {
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
  // Which CRM template to provision the company with (real_estate | solar).
  // Registration no longer collects this from the user - public/register.html
  // never sends it, so every new signup gets the default below. Kept
  // optional (rather than removed) only for backward compatibility with any
  // existing direct API caller that still sends it; a value here is still
  // honored if present. Defaults to "real_estate" for any missing/
  // unrecognized value rather than rejecting registration outright - see
  // resolveIndustryKey().
  industry?: string;
  // Whether this tenant is a single individual or an agency/team - see
  // src/domain/accountType.ts. Collected by public/register.html's second
  // step (Basic Information -> Account Type -> Create Account). Optional
  // here for the same "never hard-fail registration over a classification
  // choice" reason industry is - resolveAccountType() defaults an absent/
  // unrecognized value to "individual" rather than rejecting the request.
  accountType?: string;
}

function resolveIndustryKey(industry: string | undefined): IndustryKey {
  return INDUSTRY_KEYS.includes(industry as IndustryKey) ? (industry as IndustryKey) : "real_estate";
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

  const slug = await uniqueSlug(input.companyName);
  const passwordHash = await hashPassword(input.password);
  const industryTemplate = resolveIndustryKey(input.industry);
  const accountType = resolveAccountType(input.accountType);

  // Not wrapped in a single SQL transaction because the Neon HTTP driver
  // does not support multi-statement transactions over `neon-http` - each
  // step is individually idempotent-safe to retry, and a partial failure
  // here (company created, user creation fails) is recoverable manually
  // since it's a rare, low-volume, admin-visible path (see README).
  const company = await createCompany({ name: input.companyName, slug, industryTemplate, accountType });
  const ownerRole = await createOwnerRole(company.id);
  const user = await createUser({
    companyId: company.id,
    roleId: ownerRole.id,
    email: input.email,
    passwordHash,
    fullName: input.fullName,
  });

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

  const role = await getRoleById(user.companyId, user.roleId);
  if (!role) {
    throw new AuthError("Account has no role assigned - contact your administrator.", 403);
  }

  const branchIds = await getUserBranchIds(user.id);
  const accessToken = await signAccessToken({
    sub: user.id,
    companyId: user.companyId,
    roleId: user.roleId,
    permissions: effectivePermissions(role),
    branchIds,
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

  const branchIds = await getUserBranchIds(user.id);
  const accessToken = await signAccessToken({
    sub: user.id,
    companyId: user.companyId,
    roleId: user.roleId,
    permissions: effectivePermissions(role),
    branchIds,
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
