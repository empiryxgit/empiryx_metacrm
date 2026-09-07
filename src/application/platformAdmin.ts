import { AuthError } from "./auth";
import { verifyPassword } from "../infrastructure/auth/password";
import { getPlatformAdminByEmail, getPlatformSummary, listPlatformCompanies, touchPlatformAdminLogin } from "../infrastructure/db/repositories/platformAdmin";
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
