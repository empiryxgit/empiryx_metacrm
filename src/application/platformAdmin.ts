import { AuthError } from "./auth";
import { verifyPassword } from "../infrastructure/auth/password";
import {
  cancelCompanySubscription as cancelCompanySubscriptionRepo,
  createPlatformNotification,
  extendCompanyTrial as extendCompanyTrialRepo,
  forceActivateCompanySubscription as forceActivateCompanySubscriptionRepo,
  getPlatformAdminByEmail,
  getPlatformCompany,
  getPlatformSummary,
  listPlatformAuditLogs,
  listPlatformCompanies,
  listPlatformNotifications,
  listUserNotifications,
  markPlatformNotificationRead,
  recordPlatformAuditLog,
  touchPlatformAdminLogin,
  updatePlatformCompanyStatus,
} from "../infrastructure/db/repositories/platformAdmin";
import { listAllAgencyAuditLogAcrossCustomers } from "../infrastructure/db/repositories/agencyAuditLog";
import { getBillingOrderById, markBillingOrderRefunded } from "../infrastructure/db/repositories/billing";
import { listCycleDiscounts, listPlatformPackages, upsertCycleDiscount, upsertPlatformPackage } from "../infrastructure/db/repositories/platformPackages";
import { signPlatformAdminToken } from "../infrastructure/auth/tokens";
import { resolveEntitlementState } from "../domain/trial";
import { BILLING_CYCLE_KEYS, cycleEndDate, isBillingCycle, type BillingCycle } from "../domain/billing";
import { ACCOUNT_TYPE_KEYS, isAccountType, type AccountType } from "../domain/accountType";
import { getFallbackPricingConfig, invalidatePricingConfigCache } from "./pricing";

export async function loginPlatformAdmin(input: { email: string; password: string }) {
  const admin = await getPlatformAdminByEmail(input.email);
  const valid = await verifyPassword(input.password, admin?.passwordHash ?? "$2a$12$CwTycUXWue0Thq9StjUM0uJ8w5aM/8FEEB0m5cWZUvVs5FivmyaVW");
  if (!admin || admin.status !== "active" || !valid) throw new AuthError("Invalid administrator credentials.", 401);
  await touchPlatformAdminLogin(admin.id);
  const token = await signPlatformAdminToken({ sub: admin.id, scope: "platform_admin", email: admin.email, fullName: admin.fullName });
  return { token, admin: { id: admin.id, email: admin.email, fullName: admin.fullName } };
}

export async function getPlatformDashboard(search?: string) {
  const [summary, companies] = await Promise.all([getPlatformSummary(), listPlatformCompanies(search)]);
  return { summary, companies };
}

export async function getPlatformCompanyDetail(companyId: string) {
  const detail = await getPlatformCompany(companyId);
  if (!detail) throw new AuthError("Customer account not found.", 404);
  return {
    ...detail,
    company: {
      ...detail.company,
      createdAt: detail.company.createdAt.toISOString(),
      trialStartedAt: detail.company.trialStartedAt?.toISOString() ?? null,
      trialEndsAt: detail.company.trialEndsAt?.toISOString() ?? null,
      subscriptionExpiresAt: detail.company.subscriptionExpiresAt?.toISOString() ?? null,
    },
    users: detail.users.map((user) => ({ ...user, createdAt: user.createdAt.toISOString() })),
    payments: detail.payments.map((payment) => ({ ...payment, createdAt: payment.createdAt.toISOString(), refundedAt: payment.refundedAt?.toISOString() ?? null })),
  };
}

export async function setPlatformCompanyStatus(input: { adminId: string; companyId: string; status: "active" | "suspended"; reason?: string }) {
  const result = await updatePlatformCompanyStatus(input);
  if (!result) throw new AuthError("Customer account not found.", 404);
  return result;
}

export async function publishPlatformNotification(input: Parameters<typeof createPlatformNotification>[0]) {
  if (!input.title.trim() || !input.message.trim()) throw new AuthError("Title and message are required.", 400);
  if (!["global", "individual", "agency", "company", "user"].includes(input.targetType)) throw new AuthError("Invalid notification target.", 400);
  return createPlatformNotification({ ...input, title: input.title.trim(), message: input.message.trim() });
}

export async function getPlatformNotificationList() {
  const rows = await listPlatformNotifications();
  return rows.map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString(), createdAt: row.createdAt.toISOString() }));
}

export async function getUserNotificationList(input: { userId: string; companyId: string; accountType: string }) {
  const rows = await listUserNotifications(input);
  return rows.map((row) => ({ ...row, publishedAt: row.publishedAt.toISOString(), readAt: row.readAt?.toISOString() ?? null }));
}

export async function readUserNotification(notificationId: string, userId: string) {
  await markPlatformNotificationRead(notificationId, userId);
}

export async function getPlatformAuditLogList() {
  const rows = await listPlatformAuditLogs();
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

// ---------------------------------------------------------------------------
// Platform Admin "Packages" - editable pricing config. See src/application/
// pricing.ts's own header comment for the full fallback contract every
// function here relies on: a missing DB row is never an error, it just
// means "still on the domain default" - isCustomized below is exactly that
// distinction, surfaced for public/admin/packages.html to show as a badge.
// ---------------------------------------------------------------------------

export async function getPlatformPackagesOverview() {
  const [packageRows, cycleRows] = await Promise.all([listPlatformPackages(), listCycleDiscounts()]);
  const fallback = getFallbackPricingConfig();

  const packageByType = new Map(packageRows.map((row) => [row.accountType, row]));
  const packages = ACCOUNT_TYPE_KEYS.map((accountType) => {
    const row = packageByType.get(accountType);
    const fallbackForType = accountType === "agency" ? fallback.agency : fallback.individual;
    return row
      ? {
          accountType,
          baseMonthlyPaise: row.baseMonthlyPaise,
          baseCampaignLimit: row.baseCampaignLimit,
          baseClientLimit: row.baseClientLimit,
          overageUnitMonthlyPaise: row.overageUnitMonthlyPaise,
          isCustomized: true,
          updatedAt: row.updatedAt?.toISOString() ?? null,
        }
      : { accountType, ...fallbackForType, isCustomized: false, updatedAt: null };
  });

  const cycleByKey = new Map(cycleRows.map((row) => [row.cycle, row]));
  const cycleDiscounts = BILLING_CYCLE_KEYS.map((cycle) => {
    const row = cycleByKey.get(cycle);
    return row
      ? { cycle, discountPercent: row.discountPercent, isCustomized: true, updatedAt: row.updatedAt?.toISOString() ?? null }
      : { cycle, discountPercent: Math.round(fallback.cycleDiscount[cycle] * 100), isCustomized: false, updatedAt: null };
  });

  return { packages, cycleDiscounts };
}

function assertNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new AuthError(`${label} must be a whole number of 0 or more.`, 400);
  }
  return value;
}

export async function updatePlatformPackage(input: {
  adminId: string;
  accountType: string;
  baseMonthlyPaise: number;
  baseCampaignLimit: number;
  baseClientLimit?: number | null;
  overageUnitMonthlyPaise: number;
}) {
  if (!isAccountType(input.accountType)) throw new AuthError("accountType must be individual or agency.", 400);
  const accountType: AccountType = input.accountType;

  const baseMonthlyPaise = assertNonNegativeInteger(input.baseMonthlyPaise, "Base plan price");
  const baseCampaignLimit = assertNonNegativeInteger(input.baseCampaignLimit, "Base campaign limit");
  const overageUnitMonthlyPaise = assertNonNegativeInteger(input.overageUnitMonthlyPaise, "Overage unit price");
  // Only "agency" has a client concept at all - see baseClientLimit's own
  // doc comment in schema.ts. Silently pinning it to null for "individual"
  // (rather than rejecting a stray value) matches this codebase's existing
  // "never trust a value that doesn't apply to this account type" posture
  // (see resolveAccountType/resolveSubscriptionStatusColumn's own comments).
  const baseClientLimit = accountType === "agency" ? assertNonNegativeInteger(input.baseClientLimit ?? 0, "Base client limit") : null;

  const row = await upsertPlatformPackage({
    accountType,
    baseMonthlyPaise,
    baseCampaignLimit,
    baseClientLimit,
    overageUnitMonthlyPaise,
    updatedBy: input.adminId,
  });
  invalidatePricingConfigCache();
  await recordPlatformAuditLog({
    adminId: input.adminId,
    action: "PACKAGE_UPDATED",
    entityType: "platform_package",
    entityId: row.id,
    newValue: { accountType, baseMonthlyPaise, baseCampaignLimit, baseClientLimit, overageUnitMonthlyPaise },
  });
  return { ...row, updatedAt: row.updatedAt?.toISOString() ?? null };
}

export async function updateCycleDiscount(input: { adminId: string; cycle: string; discountPercent: number }) {
  if (!isBillingCycle(input.cycle)) throw new AuthError("cycle must be one of monthly, quarterly, halfyearly, yearly.", 400);
  const cycle: BillingCycle = input.cycle;
  if (typeof input.discountPercent !== "number" || !Number.isInteger(input.discountPercent) || input.discountPercent < 0 || input.discountPercent > 100) {
    throw new AuthError("discountPercent must be a whole number between 0 and 100.", 400);
  }

  const row = await upsertCycleDiscount({ cycle, discountPercent: input.discountPercent, updatedBy: input.adminId });
  invalidatePricingConfigCache();
  await recordPlatformAuditLog({
    adminId: input.adminId,
    action: "CYCLE_DISCOUNT_UPDATED",
    entityType: "platform_billing_cycle_discount",
    entityId: row.id,
    newValue: { cycle, discountPercent: input.discountPercent },
  });
  return { ...row, updatedAt: row.updatedAt?.toISOString() ?? null };
}

// ---------------------------------------------------------------------------
// Platform Admin "Subscriptions" - full billing management. Every action
// below re-fetches the RAW company row (getPlatformCompany, not the
// serialized getPlatformCompanyDetail) so it can validate against real
// Date objects/live entitlement state before writing - see each function's
// own comment for exactly what it guards and why. public/admin/
// subscriptions.html's own customer list/detail views are otherwise
// entirely served by getPlatformDashboard/getPlatformCompanyDetail above
// (unchanged) - nothing here duplicates those reads.
// ---------------------------------------------------------------------------

export async function extendCompanyTrial(input: { adminId: string; companyId: string; days: number; reason?: string }) {
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > 365) {
    throw new AuthError("days must be a whole number between 1 and 365.", 400);
  }
  const detail = await getPlatformCompany(input.companyId);
  if (!detail) throw new AuthError("Customer account not found.", 404);
  if (detail.company.subscriptionStatus !== "trialing") {
    throw new AuthError("This account is not currently on a trial.", 400);
  }

  const base = detail.company.trialEndsAt ? new Date(detail.company.trialEndsAt) : new Date();
  const newTrialEndsAt = new Date(base.getTime() + input.days * 24 * 60 * 60 * 1000);
  const result = await extendCompanyTrialRepo({ adminId: input.adminId, companyId: input.companyId, newTrialEndsAt, reason: input.reason?.trim() });
  if (!result) throw new AuthError("Customer account not found.", 404);
  return { companyId: result.id, trialEndsAt: result.trialEndsAt.toISOString() };
}

export async function forceActivateSubscription(input: { adminId: string; companyId: string; cycle: string; reason?: string }) {
  if (!isBillingCycle(input.cycle)) throw new AuthError("cycle must be one of monthly, quarterly, halfyearly, yearly.", 400);
  const cycle: BillingCycle = input.cycle;
  const detail = await getPlatformCompany(input.companyId);
  if (!detail) throw new AuthError("Customer account not found.", 404);

  const expiresAt = cycleEndDate(cycle);
  const result = await forceActivateCompanySubscriptionRepo({ adminId: input.adminId, companyId: input.companyId, cycle, expiresAt, reason: input.reason?.trim() });
  if (!result) throw new AuthError("Customer account not found.", 404);
  return { companyId: result.id, subscriptionStatus: result.subscriptionStatus, subscriptionCycle: result.subscriptionCycle, subscriptionExpiresAt: result.subscriptionExpiresAt.toISOString() };
}

export async function cancelSubscription(input: { adminId: string; companyId: string; reason?: string }) {
  const detail = await getPlatformCompany(input.companyId);
  if (!detail) throw new AuthError("Customer account not found.", 404);

  const entitlement = resolveEntitlementState(detail.company);
  if (entitlement.kind !== "subscribed") {
    throw new AuthError("This account does not currently have an active paid subscription to cancel.", 400);
  }

  const result = await cancelCompanySubscriptionRepo({ adminId: input.adminId, companyId: input.companyId, reason: input.reason?.trim() });
  if (!result) throw new AuthError("Customer account not found.", 404);
  return { companyId: result.id, subscriptionExpiresAt: result.subscriptionExpiresAt.toISOString() };
}

/** "View/refund individual Razorpay payment orders per customer" - records
 * that an admin has marked one payment refunded. Does NOT call Razorpay's
 * own Refunds API (see markBillingOrderRefunded's own doc comment in
 * repositories/billing.ts) - an admin issues the actual refund from the
 * Razorpay Dashboard directly and then records it here, so this order's
 * history reflects reality. `companyId` is required and checked against
 * the order's own companyId (never trusted from the URL alone) purely as a
 * defense-in-depth sanity check - the id itself is already the sole lookup
 * key, this only guards against a caller passing a mismatched pair by
 * mistake. */
export async function refundPaymentOrder(input: { adminId: string; companyId: string; orderId: string; refundAmountInPaise?: number; reason?: string }) {
  const order = await getBillingOrderById(input.orderId);
  if (!order || order.companyId !== input.companyId) throw new AuthError("Payment order not found for this customer.", 404);
  if (order.status !== "paid") throw new AuthError("Only a paid order can be marked refunded.", 400);
  if (order.refundedAt) throw new AuthError("This order has already been marked refunded.", 409);

  const refundAmountInPaise = input.refundAmountInPaise ?? order.amountInPaise;
  if (!Number.isInteger(refundAmountInPaise) || refundAmountInPaise <= 0 || refundAmountInPaise > order.amountInPaise) {
    throw new AuthError(`refundAmountInPaise must be a whole number between 1 and the order's own amount (${order.amountInPaise}).`, 400);
  }

  const result = await markBillingOrderRefunded({ id: input.orderId, refundAmountInPaise, refundReason: input.reason?.trim() || null, refundedBy: input.adminId });
  if (!result) throw new AuthError("This order could not be marked refunded (it may have just been refunded by another admin).", 409);

  await recordPlatformAuditLog({
    adminId: input.adminId,
    action: "PAYMENT_REFUNDED",
    entityType: "billing_order",
    entityId: input.orderId,
    previousValue: { status: order.status },
    newValue: { refundAmountInPaise, refundReason: input.reason?.trim() || null },
    reason: input.reason?.trim(),
  });
  return { orderId: result.id, refundedAt: result.refundedAt?.toISOString() ?? null, refundAmountInPaise: result.refundAmountInPaise };
}

// ---------------------------------------------------------------------------
// Platform Admin "Customer Activity" - a new top-level page listing
// agency/client activity across ALL customers (see
// listAllAgencyAuditLogAcrossCustomers's own doc comment in repositories/
// agencyAuditLog.ts for exactly what this does and does not cover, and why -
// distinct from platform_audit_logs above, which is PLATFORM ADMIN actions
// only, never a customer's own activity).
// ---------------------------------------------------------------------------

export async function getCustomerActivityList(opts: { companyId?: string; limit?: number; offset?: number }) {
  const { entries, hasMore } = await listAllAgencyAuditLogAcrossCustomers(opts);
  return {
    entries: entries.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
    hasMore,
  };
}
