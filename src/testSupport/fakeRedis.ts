// Phase 20 test support - a tiny in-memory stand-in for the real Redis
// nx/ex claim semantics tryClaimLeadId/tryClaimOAuthStateNonce rely on
// (see src/infrastructure/cache/redis.ts). Faithful enough that
// duplicate/retry tests exercise the real claim-then-release logic those
// call sites depend on, without needing a live Upstash instance - see
// vitest.setup.ts for where this is wired in as the mock's backing store.

interface ClaimEntry {
  expiresAt: number;
}

const claims = new Map<string, ClaimEntry>();

export function resetFakeRedis(): void {
  claims.clear();
}

/** Mirrors `redis.set(key, "1", { nx: true, ex: ttlSeconds })` - returns
 * true (claimed) only if the key wasn't already held by a live claim. */
export function fakeTryClaim(key: string, ttlSeconds: number): boolean {
  const now = Date.now();
  const existing = claims.get(key);
  if (existing && existing.expiresAt > now) return false;
  claims.set(key, { expiresAt: now + ttlSeconds * 1000 });
  return true;
}

export function fakeRelease(key: string): void {
  claims.delete(key);
}

// ---------------------------------------------------------------------
// Generic get/set-with-TTL - backs the plain value caches
// (analyticsTools.ts's getCachedAnalytics/setCachedAnalytics), distinct
// from the claims Map above since these store a JSON value, not a claim
// marker.
// ---------------------------------------------------------------------

interface ValueEntry {
  value: string;
  expiresAt: number;
}

const values = new Map<string, ValueEntry>();

export function resetFakeRedisValues(): void {
  values.clear();
}

export function fakeSet(key: string, value: string, ttlSeconds: number): void {
  values.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function fakeGet(key: string): string | null {
  const existing = values.get(key);
  if (!existing) return null;
  if (existing.expiresAt <= Date.now()) {
    values.delete(key);
    return null;
  }
  return existing.value;
}
