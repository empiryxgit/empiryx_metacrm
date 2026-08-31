// Security hardening test - refresh token rotation + reuse detection (see
// refresh()'s own comment in src/application/auth.ts). Formalizes the
// manual security review's finding: replaying an already-rotated-out
// refresh token must not just 401 that one request, it must burn the
// ENTIRE session family for that user, closing the window a leaked/stolen
// refresh token would otherwise have to keep riding alongside the
// legitimate session indefinitely. Real Postgres, no mocking - same
// "requires DATABASE_URL, skips otherwise" convention as
// src/security/tenantIsolation.test.ts.

import { describe, expect, it } from "vitest";
import { AuthError, refresh } from "../application/auth";
import { createSession, getSessionByHashIncludingRevoked } from "../infrastructure/db/repositories/tenancy";
import { generateRefreshToken, hashRefreshToken } from "../infrastructure/auth/tokens";
import { makeTenant } from "../testSupport/dbFixtures";

describe.skipIf(!process.env.DATABASE_URL)("Security: refresh token rotation & reuse detection", () => {
  it("rotates the refresh token on every use and rejects the retired one afterward", async () => {
    const tenant = await makeTenant("refresh-rotate");
    const { token, hash } = generateRefreshToken();
    await createSession({ userId: tenant.userId, refreshTokenHash: hash, expiresAt: new Date(Date.now() + 60_000), rememberMe: false });

    const rotated = await refresh(token);
    expect(rotated.refreshToken).not.toBe(token);

    // The original token was single-use - presenting it again must fail,
    // never silently succeed a second time.
    await expect(refresh(token)).rejects.toThrow(AuthError);
  });

  it("replaying a retired refresh token revokes every session for that user, including the one just issued by rotation", async () => {
    const tenant = await makeTenant("refresh-reuse");
    const { token: firstToken, hash: firstHash } = generateRefreshToken();
    await createSession({ userId: tenant.userId, refreshTokenHash: firstHash, expiresAt: new Date(Date.now() + 60_000), rememberMe: false });

    // Legitimate rotation: firstToken -> secondToken. firstToken's session
    // is now revoked; secondToken's is active.
    const rotated = await refresh(firstToken);
    const secondHash = hashRefreshToken(rotated.refreshToken);
    const secondSessionBeforeReplay = await getSessionByHashIncludingRevoked(secondHash);
    expect(secondSessionBeforeReplay?.revokedAt).toBeNull();

    // An attacker (or a racing second tab) replays the RETIRED firstToken.
    await expect(refresh(firstToken)).rejects.toThrow(AuthError);

    // The reuse of a retired token must be treated as a compromise signal:
    // the session that replay's own rotation legitimately produced
    // (secondToken's) must ALSO now be revoked, not left standing.
    const secondSessionAfterReplay = await getSessionByHashIncludingRevoked(secondHash);
    expect(secondSessionAfterReplay?.revokedAt).not.toBeNull();

    // And the now-fully-burned family means secondToken can no longer be
    // used either, even though it was never itself replayed.
    await expect(refresh(rotated.refreshToken)).rejects.toThrow(AuthError);
  });

  it("rejects a refresh token that was never issued, without revoking anyone's sessions", async () => {
    const tenant = await makeTenant("refresh-unknown");
    const { token: realToken, hash: realHash } = generateRefreshToken();
    await createSession({ userId: tenant.userId, refreshTokenHash: realHash, expiresAt: new Date(Date.now() + 60_000), rememberMe: false });

    const { token: neverIssuedToken } = generateRefreshToken();
    await expect(refresh(neverIssuedToken)).rejects.toThrow(AuthError);

    // The real, still-valid session must be entirely unaffected by a
    // stranger's token that never matched anything.
    const stillActive = await getSessionByHashIncludingRevoked(realHash);
    expect(stillActive?.revokedAt).toBeNull();
  });
});
