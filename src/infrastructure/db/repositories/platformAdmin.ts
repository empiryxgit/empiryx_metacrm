import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { getDb } from "../client";
import { agencyClients, billingOrders, campaigns, companies, leads, platformAdmins, platformAuditLogs, platformNotificationReads, platformNotifications, sessions, users } from "../schema";

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
    db.select({ id: billingOrders.id, companyId: billingOrders.companyId, kind: billingOrders.kind, amountInPaise: billingOrders.amountInPaise, currency: billingOrders.currency, status: billingOrders.status, createdAt: billingOrders.createdAt }).from(billingOrders).where(eq(billingOrders.status, "paid")).orderBy(desc(billingOrders.createdAt)).limit(10),
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
    db.select({ id: billingOrders.id, kind: billingOrders.kind, quantity: billingOrders.quantity, amountInPaise: billingOrders.amountInPaise, currency: billingOrders.currency, status: billingOrders.status, cycle: billingOrders.cycle, createdAt: billingOrders.createdAt, razorpayOrderId: billingOrders.razorpayOrderId, razorpayPaymentId: billingOrders.razorpayPaymentId, refundedAt: billingOrders.refundedAt, refundAmountInPaise: billingOrders.refundAmountInPaise, refundReason: billingOrders.refundReason }).from(billingOrders).where(eq(billingOrders.companyId, companyId)).orderBy(desc(billingOrders.createdAt)).limit(50),
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

// ---------------------------------------------------------------------------
// Platform Admin "Subscriptions" - full billing management. Every function
// below follows updatePlatformCompanyStatus's own convention above (fetch
// the current value first so the audit row can record a real before/after,
// apply the write, log to platformAuditLogs in the same call) rather than
// splitting that across the application layer - same "one place this kind
// of admin action's full effect is defined" posture the rest of this file
// already established.
// ---------------------------------------------------------------------------

/** "Extend trial" - pushes trialEndsAt out to `newTrialEndsAt`. Deliberately
 * takes the target timestamp itself (computed by the caller, see
 * extendCompanyTrial in src/application/platformAdmin.ts) rather than a
 * number of days, so this repository function stays a pure "set this column
 * to this value" write with no date arithmetic of its own to get wrong.
 * Does NOT touch subscriptionStatus - a trial extension only ever makes
 * sense while status is already "trialing" (the application layer guards
 * this; see resolveEntitlementState in src/domain/trial.ts for why writing
 * trialEndsAt while status is anything else would be silently inert). */
export async function extendCompanyTrial(input: { adminId: string; companyId: string; newTrialEndsAt: Date; reason?: string }) {
  const db = await getDb();
  const [company] = await db.select({ id: companies.id, trialEndsAt: companies.trialEndsAt, subscriptionStatus: companies.subscriptionStatus }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!company) return null;

  await db.update(companies).set({ trialEndsAt: input.newTrialEndsAt, updatedAt: new Date() }).where(eq(companies.id, input.companyId));
  await db.insert(platformAuditLogs).values({
    adminId: input.adminId,
    action: "TRIAL_EXTENDED",
    entityType: "company",
    entityId: input.companyId,
    previousValue: { trialEndsAt: company.trialEndsAt },
    newValue: { trialEndsAt: input.newTrialEndsAt },
    reason: input.reason ?? null,
  });
  return { id: company.id, trialEndsAt: input.newTrialEndsAt };
}

/** "Force-activate subscription" - the admin-triggered equivalent of a
 * successful base-plan payment (see markBillingOrderPaidAndApply's own
 * "kind = base_subscription" branch in repositories/billing.ts, which sets
 * these exact same three columns) - for comping an account, correcting a
 * payment that was never recorded, or converting a trial without a real
 * Razorpay charge. Deliberately mirrors that column set exactly so a
 * force-activated company is indistinguishable, from every other read path
 * in this app, from one that genuinely paid. */
export async function forceActivateCompanySubscription(input: { adminId: string; companyId: string; cycle: string; expiresAt: Date; reason?: string }) {
  const db = await getDb();
  const [company] = await db.select({ id: companies.id, subscriptionStatus: companies.subscriptionStatus, subscriptionCycle: companies.subscriptionCycle, subscriptionExpiresAt: companies.subscriptionExpiresAt }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!company) return null;

  await db.update(companies).set({ subscriptionStatus: "active", subscriptionCycle: input.cycle, subscriptionExpiresAt: input.expiresAt, updatedAt: new Date() }).where(eq(companies.id, input.companyId));
  await db.insert(platformAuditLogs).values({
    adminId: input.adminId,
    action: "SUBSCRIPTION_FORCE_ACTIVATED",
    entityType: "company",
    entityId: input.companyId,
    previousValue: { subscriptionStatus: company.subscriptionStatus, subscriptionCycle: company.subscriptionCycle, subscriptionExpiresAt: company.subscriptionExpiresAt },
    newValue: { subscriptionStatus: "active", subscriptionCycle: input.cycle, subscriptionExpiresAt: input.expiresAt },
    reason: input.reason ?? null,
  });
  return { id: company.id, subscriptionStatus: "active", subscriptionCycle: input.cycle, subscriptionExpiresAt: input.expiresAt };
}

/** "Cancel subscription" - deliberately only ever touches
 * subscriptionExpiresAt (pulling it to right now), never subscriptionStatus
 * itself. This mirrors exactly how an ordinary, un-renewed paid cycle is
 * already left to lapse today (see companies.subscriptionStatus's own doc
 * comment in schema.ts: "no cron sweep, just compare to now()" -
 * resolveEntitlementState treats status "active" + a past expiresAt as
 * subscription_expired on its own, lazily, at read time). A force-cancelled
 * company is therefore indistinguishable from one whose real paid cycle
 * simply ran out - existing data (campaigns, leads, clients) is left
 * completely untouched by this call, exactly like a natural expiry. */
export async function cancelCompanySubscription(input: { adminId: string; companyId: string; reason?: string }) {
  const db = await getDb();
  const [company] = await db.select({ id: companies.id, subscriptionStatus: companies.subscriptionStatus, subscriptionExpiresAt: companies.subscriptionExpiresAt }).from(companies).where(eq(companies.id, input.companyId)).limit(1);
  if (!company) return null;

  const now = new Date();
  await db.update(companies).set({ subscriptionExpiresAt: now, updatedAt: now }).where(eq(companies.id, input.companyId));
  await db.insert(platformAuditLogs).values({
    adminId: input.adminId,
    action: "SUBSCRIPTION_CANCELLED",
    entityType: "company",
    entityId: input.companyId,
    previousValue: { subscriptionExpiresAt: company.subscriptionExpiresAt },
    newValue: { subscriptionExpiresAt: now },
    reason: input.reason ?? null,
  });
  return { id: company.id, subscriptionExpiresAt: now };
}

/** Generic platform_audit_logs writer - used by refundPaymentOrder
 * (src/application/platformAdmin.ts), which writes through
 * markBillingOrderRefunded in repositories/billing.ts (a different
 * repository file, keyed by billing_orders.id rather than companies.id)
 * and so cannot reuse the fetch-then-log pattern the company-scoped
 * functions above each inline for themselves. Every other admin action in
 * this file logs inline instead of calling this, purely because each of
 * them already has the "previous value" in hand from its own fetch right
 * above the insert - this exists only for the one call site that doesn't. */
export async function recordPlatformAuditLog(input: {
  adminId: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
}) {
  const db = await getDb();
  await db.insert(platformAuditLogs).values({
    adminId: input.adminId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    previousValue: input.previousValue ?? null,
    newValue: input.newValue ?? null,
    reason: input.reason ?? null,
  });
}

export async function createPlatformNotification(input: {
  adminId: string;
  targetType: string;
  targetCompanyId?: string;
  targetUserId?: string;
  title: string;
  message: string;
  ctaLabel?: string;
  ctaUrl?: string;
}) {
  const db = await getDb();
  const [row] = await db.insert(platformNotifications).values({ ...input, createdBy: input.adminId, targetCompanyId: input.targetCompanyId ?? null, targetUserId: input.targetUserId ?? null }).returning();
  return row;
}

export async function listPlatformNotifications() {
  const db = await getDb();
  return db.select().from(platformNotifications).orderBy(desc(platformNotifications.publishedAt)).limit(100);
}

export async function listUserNotifications(input: { userId: string; companyId: string; accountType: string }) {
  const db = await getDb();
  return db
    .select({
      id: platformNotifications.id,
      title: platformNotifications.title,
      message: platformNotifications.message,
      ctaLabel: platformNotifications.ctaLabel,
      ctaUrl: platformNotifications.ctaUrl,
      publishedAt: platformNotifications.publishedAt,
      readAt: platformNotificationReads.readAt,
    })
    .from(platformNotifications)
    .leftJoin(platformNotificationReads, and(eq(platformNotificationReads.notificationId, platformNotifications.id), eq(platformNotificationReads.userId, input.userId)))
    .where(or(
      eq(platformNotifications.targetType, "global"),
      and(eq(platformNotifications.targetType, "company"), eq(platformNotifications.targetCompanyId, input.companyId)),
      and(eq(platformNotifications.targetType, input.accountType), eq(platformNotifications.targetCompanyId, input.companyId)),
      and(eq(platformNotifications.targetType, "user"), eq(platformNotifications.targetUserId, input.userId)),
    ))
    .orderBy(desc(platformNotifications.publishedAt))
    .limit(50);
}

export async function markPlatformNotificationRead(notificationId: string, userId: string) {
  const db = await getDb();
  await db.insert(platformNotificationReads).values({ notificationId, userId }).onConflictDoNothing();
}

export async function listPlatformAuditLogs() {
  const db = await getDb();
  return db.select({
    id: platformAuditLogs.id,
    action: platformAuditLogs.action,
    entityType: platformAuditLogs.entityType,
    entityId: platformAuditLogs.entityId,
    previousValue: platformAuditLogs.previousValue,
    newValue: platformAuditLogs.newValue,
    reason: platformAuditLogs.reason,
    createdAt: platformAuditLogs.createdAt,
    adminEmail: platformAdmins.email,
  }).from(platformAuditLogs).innerJoin(platformAdmins, eq(platformAdmins.id, platformAuditLogs.adminId)).orderBy(desc(platformAuditLogs.createdAt)).limit(200);
}
