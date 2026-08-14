// Step 1 of company onboarding: creates the company (tenant), its built-in
// Owner role, and the first user in one call, then logs them straight in.
// The rest of onboarding (company profile details, first campaign) happens
// after this, already authenticated - see api/onboarding/*.ts.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AuthError, login, registerCompanyAndOwner } from "../../src/application/auth";
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, REFRESH_TOKEN_TTL_SECONDS, cookieOptions } from "../../src/infrastructure/auth/tokens";

interface RegisterBody {
  companyName: string;
  fullName: string;
  email: string;
  password: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const body = req.body as RegisterBody;
  if (!body?.companyName || !body?.fullName || !body?.email || !body?.password) {
    res.status(400).json({ error: "companyName, fullName, email and password are all required." });
    return;
  }

  try {
    await registerCompanyAndOwner(body);

    // Log the new owner in immediately - registration and first login are
    // the same moment from the user's perspective.
    const tokens = await login({
      email: body.email,
      password: body.password,
      userAgent: req.headers["user-agent"],
      ipAddress: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
    });

    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(15 * 60)}`,
      `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(REFRESH_TOKEN_TTL_SECONDS)}`,
    ]);
    res.status(201).json({ user: tokens.user });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[auth/register] Failed:", err);
    res.status(500).json({ error: "Registration failed." });
  }
}
