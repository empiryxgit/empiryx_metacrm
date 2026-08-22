// Signs and verifies the `state` parameter for the Meta OAuth flow (see
// src/application/metaOAuth.ts). This is what makes it safe to say "never
// trust a raw tenant_id supplied by the frontend": the tenant/user this
// connection belongs to is decided ONCE, server-side, at /connect time (from
// the caller's already-verified session - see requirePermission in
// api/webhooks/meta/handler.ts), then sealed into this signed, short-lived,
// single-use token. The /callback handler recovers the tenant/user ONLY from
// this verified token - never from a query param, never from a cookie that
// may or may not have survived Meta's redirect chain.
//
// Reuses AUTH_JWT_SECRET (already a required, existing env var - see
// src/infrastructure/auth/tokens.ts) rather than introducing a second signing
// secret. A `purpose` claim keeps a state token from ever being confused
// with (or accepted as) a real access token even though they share a key -
// verifyOAuthState rejects anything without it.

import { SignJWT, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";
import { tryClaimOAuthStateNonce } from "../cache/redis";

const OAUTH_STATE_TTL_SECONDS = 10 * 60; // 10 minutes - ample for a user to complete the Meta dialog
const PURPOSE = "meta_oauth_connect";

export interface OAuthStateClaims {
  tenantId: string;
  userId: string;
}

function getSecret(): Uint8Array {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_JWT_SECRET is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(48).toString('base64'))\"",
    );
  }
  return new TextEncoder().encode(secret);
}

/** Step 1 + 2: generate secure state, bound to the tenant/user resolved from
 * the CALLER'S OWN verified session (never from anything the request body/
 * query could supply). */
export async function createOAuthState(claims: OAuthStateClaims): Promise<string> {
  const nonce = randomBytes(24).toString("base64url");
  return new SignJWT({ ...claims, purpose: PURPOSE, nonce })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${OAUTH_STATE_TTL_SECONDS}s`)
    .sign(getSecret());
}

/** Step 5: validate state. Checks signature + expiry + purpose (so an access
 * token, or a state token from some other flow, can never be replayed here),
 * then consumes the embedded nonce via Redis so the same state value cannot
 * be used a second time within its TTL window even if it leaked (e.g. via a
 * proxy log) - see tryClaimOAuthStateNonce for why this fails open rather
 * than closed. Returns null on any failure; callers must treat that as "the
 * whole connection attempt is invalid," not retry with the same state. */
export async function verifyOAuthState(token: string): Promise<OAuthStateClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    if (payload.purpose !== PURPOSE) return null;
    const tenantId = payload.tenantId;
    const userId = payload.userId;
    const nonce = payload.nonce;
    if (typeof tenantId !== "string" || typeof userId !== "string" || typeof nonce !== "string") return null;

    const claimed = await tryClaimOAuthStateNonce(nonce, OAUTH_STATE_TTL_SECONDS);
    if (!claimed) return null; // already used once - reject the replay

    return { tenantId, userId };
  } catch {
    return null;
  }
}
