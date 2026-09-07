import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { getDb } from "../client";
import { agencyClients, billingOrders, campaigns, companies, leads, platformAdmins, platformAuditLogs, sessions, users } from "../schema";

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

export async function getPlatformCompany(companyId: string) {
  const db = await getDb();
  const [company] = await db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
  if (!company) return null;

  const [companyUsers, companyOrders, agencyLink] = await Promise.all([
    db.select({ id: users.id, email: users.email, fullName: users.fullName, status: users.status, createdAt: users.createdAt }).from(users).where(eq(users.companyId, companyId)).orderBy(desc(users.createdAt)),
    db.select({ id: billingOrders.id, kind: billingOrders.kind, amountInPaise: billingOrders.amountInPaise, currency: billingOrders.currency, status: billingOrders.status, cycle: billingOrders.cycle, createdAt: billingOrders.createdAt, razorpayPaymentId: billingOrders.razorpayPaymentId }).from(billingOrders).where(eq(billingOrders.companyId, companyId)).orderBy(desc(billingOrders.createdAt)).limit(20),
    db.select({ agencyCompanyId: agencyClients.agencyCompanyId, relationshipStatus: agencyClients.status }).from(agencyClients).where(eq(agencyClients.clientCompanyId, companyId)).limit(1),
  ]);

  return { company, users: companyUsers, payments: companyOrders, agency: agencyLink[0] ?? null };
}

export async function updatePlatformCompanyStatus(input: { adminId: string; companyId: string; status: "active" | "suspended"; reason?: string }) {
  const db = await getDb();
  const [company] = await db.select({ id: companies.id, status: companies.status }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!company) return null;
  if (company.status === input.status) return company;

  await db.update(companies).set({ status: input.status, updatedAt: new Date() }).where(eq(companies.id, input.companyId));
  if (input.status === "suspended") {
    const companyUsers = await db.select({ id: users.id }).from(users).where(eq(users.companyId, input.companyId));
    if (companyUsers.length) {
      await db.update(sessions).set({ revokedAt: new Date() }).where(inArray(sessions.userId, companyUsers.map((user) => user.id)));
    }
  }
  await db.insert(platformAuditLogs).values({
    adminId: input.adminId,
    action: input.status === "suspended" ? "ACCOUNT_SUSPENDED" : "ACCOUNT_ACTIVATED",
    entityType: "company",
    entityId: input.companyId,
    previousValue: { status: company.status },
    newValue: { status: input.status },
    reason: input.reason ?? null,
  });
  return { ...company, status: input.status };
}
