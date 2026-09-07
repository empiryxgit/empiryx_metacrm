import { and, desc, eq, ilike, sql } from "drizzle-orm";
import { getDb } from "../client";
import { agencyClients, billingOrders, campaigns, companies, leads, platformAdmins, users } from "../schema";

export async function getPlatformAdminByEmail(email: string) {
  const db = await getDb();
  const [row] = await db.select().from(platformAdmins).where(eq(platformAdmins.email, email.toLowerCase().trim())).limit(1);
  return row ?? null;
}

export async function touchPlatformAdminLogin(adminId: string) {
  const db = await getDb();
  await db.update(platformAdmins).set({ lastLoginAt: new Date(), updatedAt: new Date() }).where(eq(platformAdmins.id, adminId));
}

export async function listPlatformCompanies(search?: string) {
  const db = await getDb();
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      slug: companies.slug,
      accountType: companies.accountType,
      status: companies.status,
      subscriptionStatus: companies.subscriptionStatus,
      trialStartedAt: companies.trialStartedAt,
      trialEndsAt: companies.trialEndsAt,
      subscriptionExpiresAt: companies.subscriptionExpiresAt,
      createdAt: companies.createdAt,
      userCount: sql<number>`count(distinct ${users.id})`,
      campaignCount: sql<number>`count(distinct ${campaigns.id})`,
      leadCount: sql<number>`count(distinct ${leads.id})`,
    })
    .from(companies)
    .leftJoin(users, eq(users.companyId, companies.id))
    .leftJoin(campaigns, eq(campaigns.companyId, companies.id))
    .leftJoin(leads, eq(leads.companyId, companies.id))
    .where(search ? ilike(companies.name, `%${search}%`) : undefined)
    .groupBy(companies.id)
    .orderBy(desc(companies.createdAt));

  const clients = await db
    .select({ agencyCompanyId: agencyClients.agencyCompanyId, count: sql<number>`count(*)` })
    .from(agencyClients)
    .groupBy(agencyClients.agencyCompanyId);
  const clientCounts = new Map(clients.map((row) => [row.agencyCompanyId, Number(row.count)]));

  return rows.map((row) => ({
    ...row,
    userCount: Number(row.userCount),
    campaignCount: Number(row.campaignCount),
    leadCount: Number(row.leadCount),
    clientCount: clientCounts.get(row.id) ?? 0,
  }));
}

export async function getPlatformSummary() {
  const db = await getDb();
  const [usersCount, companiesCount, agenciesCount, clientsCount, activeSubscriptions, activeTrials, expiredTrials, expiredSubscriptions, recentOrders] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(users),
    db.select({ count: sql<number>`count(*)` }).from(companies),
    db.select({ count: sql<number>`count(*)` }).from(companies).where(eq(companies.accountType, "agency")),
    db.select({ count: sql<number>`count(*)` }).from(agencyClients),
    db.select({ count: sql<number>`count(*)` }).from(companies).where(eq(companies.subscriptionStatus, "active")),
    db.select({ count: sql<number>`count(*)` }).from(companies).where(eq(companies.subscriptionStatus, "trialing")),
    db.select({ count: sql<number>`count(*)` }).from(companies).where(and(eq(companies.subscriptionStatus, "trialing"), sql`${companies.trialEndsAt} <= now()`)),
    db.select({ count: sql<number>`count(*)` }).from(companies).where(and(eq(companies.subscriptionStatus, "expired"), sql`${companies.subscriptionExpiresAt} <= now()`)),
    db.select({ count: sql<number>`count(*)` }).from(billingOrders).where(eq(billingOrders.status, "paid")).orderBy(desc(billingOrders.createdAt)).limit(10),
  ]);
  const value = (result: Array<{ count: number }>) => Number(result[0]?.count ?? 0);
  return {
    users: value(usersCount),
    companies: value(companiesCount),
    agencies: value(agenciesCount),
    clients: value(clientsCount),
    activeSubscriptions: value(activeSubscriptions),
    activeTrials: value(activeTrials),
    expiredTrials: value(expiredTrials),
    expiredSubscriptions: value(expiredSubscriptions),
    recentPayments: recentOrders,
  };
}
