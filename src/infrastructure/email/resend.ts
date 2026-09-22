// Sends real outbound transactional email via Resend's HTTP API - plain
// fetch, no SDK dependency, matching this codebase's existing convention
// of calling a third-party provider's REST API directly rather than
// pulling in its SDK (see src/infrastructure/razorpay/client.ts, the Meta
// Graph API client). This is the FIRST real email this app ever sends -
// see passwordResetTokens' own doc comment in schema.ts for why "Forgot
// password" specifically can't reuse the rest of the app's "generate a
// link, an admin relays it manually" pattern.
//
// Required env vars (see .env.example) - set these in Vercel yourself;
// this file never invents or guesses a value for either:
//   RESEND_API_KEY   - Resend dashboard -> API Keys
//   RESEND_FROM_EMAIL - a "From" address on a domain verified in Resend
//                        (Resend rejects a send from an unverified domain)
// Both are read via getEnv(), so a UAT preview deployment can override
// either with a UAT_-prefixed name (UAT_RESEND_API_KEY / UAT_
// RESEND_FROM_EMAIL) exactly like every other credential in this codebase
// - see src/infrastructure/env.ts's own comment.

import { getEnv } from "../env";

export class EmailSendError extends Error {}

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

async function sendEmail(input: SendEmailInput): Promise<void> {
  const apiKey = getEnv("RESEND_API_KEY");
  const from = getEnv("RESEND_FROM_EMAIL");
  if (!apiKey || !from) {
    // Fails loudly rather than silently swallowing the send - a password
    // reset the user never receives is a support ticket waiting to
    // happen, and a misconfigured deployment should surface that
    // immediately (server logs - see the caller in
    // src/application/passwordReset.ts) rather than only be discovered
    // from a user complaint. See .env.example for what to set.
    throw new EmailSendError("RESEND_API_KEY / RESEND_FROM_EMAIL is not set. See .env.example.");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: input.to, subject: input.subject, html: input.html }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new EmailSendError(`Resend API returned ${res.status}: ${body.slice(0, 500)}`);
  }
}

export async function sendPasswordResetEmail(input: { to: string; resetUrl: string }): Promise<void> {
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 16px">Reset your RUTA password</h2>
      <p style="margin:0 0 16px;line-height:1.5">
        We received a request to reset the password for your RUTA account
        (${input.to}). This link is valid for 1 hour and can only be used once.
      </p>
      <p style="margin:0 0 24px">
        <a href="${input.resetUrl}" style="background:#F47B32;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600;display:inline-block">
          Set a new password
        </a>
      </p>
      <p style="margin:0 0 16px;line-height:1.5;font-size:13px;color:#6B7280">
        If you didn't request this, you can safely ignore this email — your password will not be changed.
      </p>
      <p style="margin:0;font-size:12px;color:#9CA3AF">RUTA Lead Management System</p>
    </div>
  `.trim();

  await sendEmail({ to: input.to, subject: "Reset your RUTA password", html });
}
