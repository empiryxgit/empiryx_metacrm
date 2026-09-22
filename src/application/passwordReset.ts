// "Forgot password" - login.html's link -> /forgot-password.html
// (requestPasswordReset, below) -> an emailed link -> /reset-password.html
// (resetPassword, below). A separate file from auth.ts (which owns
// register/login/refresh/logout) the same way agencyOnboarding.ts is kept
// separate from agency.ts - a distinct token-based flow with its own
// lifecycle, not one more branch of the core login/session machinery.

import { getUserByEmail, getUserById, revokeAllSessionsForUser, setUserPassword } from "../infrastructure/db/repositories/tenancy";
import {
  consumePasswordResetTokenByHash,
  createPasswordResetToken,
  invalidateOutstandingPasswordResetTokens,
} from "../infrastructure/db/repositories/passwordResetTokens";
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
} from "../infrastructure/auth/tokens";
import { hashPassword } from "../infrastructure/auth/password";
import { sendPasswordResetEmail } from "../infrastructure/email/resend";
import { getEnv } from "../infrastructure/env";
import { AuthError } from "./auth";

function getPublicBaseUrl(): string {
  // Same PUBLIC_BASE_URL-based pattern metaOAuth.ts's getRedirectUri and
  // metaWebhookService.ts already use for building an absolute, this-
  // deployment-specific URL server-side.
  const base = getEnv("PUBLIC_BASE_URL");
  if (!base) throw new Error("PUBLIC_BASE_URL is not set. See .env.example.");
  return base.replace(/\/+$/, "");
}

/**
 * Enumeration-safe by design: resolves successfully whether or not `email`
 * belongs to an account, and the caller (api/auth/handler.ts) always shows
 * the exact same generic "if that email exists..." message either way -
 * same principle as login()'s own NO_SUCH_USER_DUMMY_HASH comment in
 * auth.ts, applied here instead of a fixed-cost dummy hash comparison
 * (there's no password to compare against). Only the account-exists branch
 * does any real work (token generation, a DB write, a Resend API call);
 * both the rate limiting in api/auth/handler.ts and this being a low-value
 * timing side-channel (nothing secret is learned faster than a handful of
 * rate-limited attempts would already reveal) are why that asymmetry is
 * left as-is rather than padded to a fixed duration.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await getUserByEmail(email.trim().toLowerCase());
  if (!user || user.status !== "active") return;

  // Burn any still-outstanding link from an earlier request first - see
  // invalidateOutstandingPasswordResetTokens' own comment for why (only
  // the newest requested link should ever work).
  await invalidateOutstandingPasswordResetTokens(user.id);

  const { token, hash } = generatePasswordResetToken();
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000);
  await createPasswordResetToken({ userId: user.id, tokenHash: hash, expiresAt });

  const resetUrl = `${getPublicBaseUrl()}/reset-password.html?token=${encodeURIComponent(token)}`;
  await sendPasswordResetEmail({ to: user.email, resetUrl });
}

/**
 * Validates the token via the same atomic single-use claim
 * organizationInvitations.acceptInvitationByHash uses, then sets the new
 * password and - like handleChangePassword in api/auth/handler.ts -
 * revokes every other outstanding session for the account. A password
 * reset is exactly the kind of event ("something/someone else now knows a
 * valid credential for this account") that should force every other
 * signed-in browser to re-authenticate, same reasoning as a normal
 * password change.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  if (!token) throw new AuthError("This password reset link is invalid or has expired.", 400);

  const hash = hashPasswordResetToken(token);
  const claimed = await consumePasswordResetTokenByHash(hash);
  if (!claimed) {
    throw new AuthError("This password reset link is invalid or has expired.", 400);
  }

  const user = await getUserById(claimed.userId);
  if (!user || user.status !== "active") {
    throw new AuthError("This password reset link is invalid or has expired.", 400);
  }

  const newHash = await hashPassword(newPassword);
  await setUserPassword(user.id, newHash, false);
  await revokeAllSessionsForUser(user.id);
}
