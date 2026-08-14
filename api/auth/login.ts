import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AuthError, login } from "../../src/application/auth";
import { ACCESS_COOKIE_NAME, REFRESH_COOKIE_NAME, REFRESH_TOKEN_TTL_SECONDS, cookieOptions } from "../../src/infrastructure/auth/tokens";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "email and password are required." });
    return;
  }

  try {
    const tokens = await login({
      email,
      password,
      userAgent: req.headers["user-agent"],
      ipAddress: (req.headers["x-forwarded-for"] as string) ?? req.socket.remoteAddress,
    });

    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(15 * 60)}`,
      `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(REFRESH_TOKEN_TTL_SECONDS)}`,
    ]);
    res.status(200).json({ user: tokens.user });
  } catch (err) {
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[auth/login] Failed:", err);
    res.status(500).json({ error: "Login failed." });
  }
}
