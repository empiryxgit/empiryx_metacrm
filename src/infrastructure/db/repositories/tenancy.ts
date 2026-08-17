import { and, eq, ne } from "drizzle-orm";
import { getDb } from "../client";
import { companies, roles, sessions, users } from "../schema";
import { firstOrThrow } from "../util";
import { ALL_PERMISSIONS } from "../../../domain/permissions";

// ---- Companies --------------------------------------------------------

export async function createCompany(input: { name: string; slug: string; industryTemplate: string }) {
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

export async function updateCompanyProfile(
  companyId: string,
  input: { industry?: string; companySize?: string; timezone?: string },
) {
  const db = await getDb();
  await db.update(companies).set({ ...input, updatedAt: new Date() }).where(eq(companies.id, companyId));
}

export async function completeOnboarding(companyId: string) {
  const db = await getDb();
  await db
    .update(companies)
    .set({ onboardingCompletedAt: new Date(), updatedAt: new Date() })
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

export async function updateUser(
  companyId: string,
  userId: string,
  input: { roleId?: string; status?: string; fullName?: string },
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

export async function revokeSession(sessionId: string) {
  const db = await getDb();
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function revokeAllSessionsForUser(userId: string) {
  const db = await getDb();
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.userId, userId));
}
