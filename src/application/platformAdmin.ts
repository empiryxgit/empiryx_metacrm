import { AuthError } from "./auth";
import { verifyPassword } from "../infrastructure/auth/password";
import { getPlatformAdminByEmail, getPlatformCompany, getPlatformSummary, listPlatformCompanies, touchPlatformAdminLogin, updatePlatformCompanyStatus } from "../infrastructure/db/repositories/platformAdmin";
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
