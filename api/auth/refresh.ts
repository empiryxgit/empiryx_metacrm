import type { VercelRequest, VercelResponse } from "@vercel/node";
import { AuthError, refresh } from "../../src/application/auth";
import {
  ACCESS_COOKIE_NAME,
  REFRESH_COOKIE_NAME,
  REFRESH_TOKEN_TTL_SECONDS,
  cookieOptions,
  clearCookieOptions,
} from "../../src/infrastructure/auth/tokens";
import { parseCookies } from "../../src/infrastructure/auth/context";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cookies = parseCookies(req);
  const refreshToken = cookies[REFRESH_COOKIE_NAME];
  if (!refreshToken) {
    res.status(401).json({ error: "No refresh token." });
    return;
  }

  try {
    const tokens = await refresh(refreshToken);
    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=${tokens.accessToken}; ${cookieOptions(15 * 60)}`,
      `${REFRESH_COOKIE_NAME}=${tokens.refreshToken}; ${cookieOptions(REFRESH_TOKEN_TTL_SECONDS)}`,
    ]);
    res.status(200).json({ user: tokens.user });
  } catch (err) {
    // A rejected refresh always clears cookies - forces a clean re-login
    // rather than leaving a half-valid session hanging around client-side.
    res.setHeader("Set-Cookie", [
      `${ACCESS_COOKIE_NAME}=; ${clearCookieOptions()}`,
      `${REFRESH_COOKIE_NAME}=; ${clearCookieOptions()}`,
    ]);
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[auth/refresh] Failed:", err);
    res.status(500).json({ error: "Refresh failed." });
  }
}
