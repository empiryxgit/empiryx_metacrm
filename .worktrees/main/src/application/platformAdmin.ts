import { AuthError } from "./auth";
import { verifyPassword } from "../infrastructure/auth/password";
import { createPlatformNotification, getPlatformAdminByEmail, getPlatformCompany, getPlatformSummary, listPlatformAuditLogs, listPlatformCompanies, listPlatformNotifications, listUserNotifications, markPlatformNotificationRead, touchPlatformAdminLogin, updatePlatformCompanyStatus } from "../infrastructure/db/repositories/platformAdmin";
import { signPlatformAdminToken } from "../infrastructure/auth/tokens";

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
    payments: detail.payments.map((payment) => ({ ...payment, createdAt: payment.createdAt.toISOString() })),
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
