// Phase 20 - global test setup, loaded once per test file (vitest.config.ts's
// `setupFiles`). Mocks the two external, non-Postgres services every Meta
// flow touches - Upstash Redis (idempotency claims, OAuth-state nonce,
// live sync progress) and Upstash QStash (the durable queue) - so the
// integration test suite never needs live Upstash credentials and never
// makes a real network call to either. Everything else (Postgres, the
// actual application/repository code) runs for real - these are
// integration tests, not a fully mocked unit-test suite.
//
// vi.mock is hoisted and matched by RESOLVED module id, so mocking the
// path relative to this file correctly intercepts every import of the
// same module from anywhere else in the codebase (a different relative
// specifier still resolves to the same file).

import { vi } from "vitest";
import { publishedMessages } from "./src/testSupport/qstashCapture";
import { fakeTryClaim, fakeRelease, fakeGet, fakeSet } from "./src/testSupport/fakeRedis";

// Non-secret config every Meta code path guards on before doing anything
// (getAppId/getAppSecret/getRedirectUri/getWebhookVerifyToken/AUTH_JWT_SECRET
// for oauthState's JWT signing). Every actual network call these gate is
// itself mocked (graphClient, per test file) - these values are never sent
// anywhere real, they only need to be PRESENT and consistent so the app's
// own "not configured" guards don't fire during a test run. Only set when
// absent, so a real .env (if one happens to be loaded) still wins.
process.env.META_APP_ID ??= "test-app-id";
process.env.META_APP_SECRET ??= "test-app-secret";
process.env.META_WEBHOOK_VERIFY_TOKEN ??= "test-webhook-verify-token";
process.env.PUBLIC_BASE_URL ??= "https://test.example.com";
process.env.AUTH_JWT_SECRET ??= "test-auth-jwt-secret-at-least-32-bytes-long";

vi.mock("./src/infrastructure/queue/qstash", () => ({
  publishLeadReceived: vi.fn(async (input: { rawEventId: string; metaLeadId: string; objectType: string; companyId: string; campaignId: string }) => {
    publishedMessages.push({ kind: "legacy", ...input });
    return `mock-msg-${publishedMessages.length}`;
  }),
  publishTenantLeadReceived: vi.fn(async (input: { leadEventId: string; metaLeadId: string; tenantId: string }) => {
    publishedMessages.push({ kind: "tenant", ...input });
    return `mock-msg-${publishedMessages.length}`;
  }),
  publishWhatsappMessageReceived: vi.fn(async (input: { messageEventId: string; waMessageId: string; tenantId: string }) => {
    publishedMessages.push({ kind: "whatsapp", ...input });
    return `mock-msg-${publishedMessages.length}`;
  }),
  ensureReconciliationSchedule: vi.fn(async () => "mock-schedule-id"),
}));

vi.mock("./src/infrastructure/cache/redis", () => ({
  tryClaimLeadId: vi.fn(async (metaLeadId: string, ttlSeconds = 60 * 15) => fakeTryClaim(`leadid:${metaLeadId}`, ttlSeconds)),
  releaseLeadIdClaim: vi.fn(async (metaLeadId: string) => fakeRelease(`leadid:${metaLeadId}`)),
  tryClaimOAuthStateNonce: vi.fn(async (nonce: string, ttlSeconds: number) => fakeTryClaim(`oauthstate:${nonce}`, ttlSeconds)),
  setMetaSyncProgress: vi.fn(async () => {}),
  getMetaSyncProgress: vi.fn(async () => null),
  // Rate limiting (src/infrastructure/cache/redis.ts's checkRateLimit) -
  // always reports "within limit" under test, same "never block the flow
  // under test" convention as the other fakes above. A test that wants to
  // exercise actual rate-limit-exceeded behavior should vi.mock this module
  // locally with a stricter stub instead of relying on this default.
  checkRateLimit: vi.fn(async () => true),
  // RUTA AI Assistant message idempotency (rutaAiAssistant.ts's
  // handleOneMessage) - backed by the SAME fake claim store as
  // tryClaimLeadId above, under its own key namespace, so a duplicate/retry
  // test actually exercises real claim-then-reject semantics rather than
  // always reporting "not claimed yet".
  tryClaimRutaMessageId: vi.fn(async (tenantId: string, waMessageId: string) => fakeTryClaim(`rutamsg:${tenantId}:${waMessageId}`, 24 * 60 * 60)),
  // RUTA analytics cache (analyticsTools.ts's getCachedAnalytics/
  // setCachedAnalytics) - backed by the same in-memory value store as
  // every other fake here, so a test that specifically wants to prove a
  // cache hit/miss can still do so (set then get returns the same value;
  // a fresh key returns null) without needing live Upstash credentials.
  getCachedAnalytics: vi.fn(async (cacheKey: string) => {
    const raw = fakeGet(`analytics:${cacheKey}`);
    return raw ? JSON.parse(raw) : null;
  }),
  setCachedAnalytics: vi.fn(async (cacheKey: string, data: unknown) => {
    fakeSet(`analytics:${cacheKey}`, JSON.stringify(data), 5 * 60);
  }),
}));
