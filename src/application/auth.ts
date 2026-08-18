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
  revokeSession,
} from "../infrastructure/db/repositories/tenancy";
import { getUserBranchIds } from "../infrastructure/db/repositories/branches";
import { hashPassword, verifyPassword } from "../infrastructure/auth/password";
import {
  generateRefreshToken,
  hashRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  signAccessToken,
} from "../infrastructure/auth/tokens";
import { INDUSTRY_KEYS, getIndustryTemplate, type IndustryKey } from "../domain/industryTemplates";
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
  // Which CRM template to provision the company with. Defaults to
  // "real_estate" for any missing/unrecognized value rather than rejecting
  // registration outright - this is a product default, not a hard
  // requirement the user must get exactly right.
  industry?: string;
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

  // Not wrapped in a single SQL transaction because the Neon HTTP driver
  // does not support multi-statement transactions over `neon-http` - each
  // step is individually idempotent-safe to retry, and a partial failure
  // here (company created, user creation fails) is recoverable manually
  // since it's a rare, low-volume, admin-visible path (see README).
  const company = await createCompany({ name: input.companyName, slug, industryTemplate });
  const ownerRole = await createOwnerRole(company.id);
  const user = await createUser({
    companyId: company.id,
    roleId: ownerRole.id,
    email: input.email,
    passwordHash,
    fullName: input.fullName,
  });

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
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  refreshExpiresAt: Date;
  user: { id: string; email: string; fullName: string; companyId: string; mustChangePassword: boolean };
}

export async function login(input: LoginInput): Promise<AuthTokens> {
  const user = await getUserByEmail(input.email);
  if (!user || user.status !== "active") {
    throw new AuthError("Invalid email or password.", 401);
  }
  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
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

  const { token: refreshToken, hash } = generateRefreshToken();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await createSession({
    userId: user.id,
    refreshTokenHash: hash,
    userAgent: input.userAgent,
    ipAddress: input.ipAddress,
    expiresAt: refreshExpiresAt,
  });

  await touchLastLogin(user.id);

  return {
    accessToken,
    refreshToken,
    refreshExpiresAt,
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
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);
  await createSession({ userId: user.id, refreshTokenHash: newHash, expiresAt: refreshExpiresAt });

  return {
    accessToken,
    refreshToken: newRefreshToken,
    refreshExpiresAt,
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
