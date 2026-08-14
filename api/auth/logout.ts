import type { VercelRequest, VercelResponse } from "@vercel/node";
import { logout } from "../../src/application/auth";
import { REFRESH_COOKIE_NAME, ACCESS_COOKIE_NAME, clearCookieOptions } from "../../src/infrastructure/auth/tokens";
import { parseCookies } from "../../src/infrastructure/auth/context";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const cookies = parseCookies(req);
  const refreshToken = cookies[REFRESH_COOKIE_NAME];
  if (refreshToken) {
    await logout(refreshToken);
  }

  res.setHeader("Set-Cookie", [
    `${ACCESS_COOKIE_NAME}=; ${clearCookieOptions()}`,
    `${REFRESH_COOKIE_NAME}=; ${clearCookieOptions()}`,
  ]);
  res.status(200).json({ loggedOut: true });
}
