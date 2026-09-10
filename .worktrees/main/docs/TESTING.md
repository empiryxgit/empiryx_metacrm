# Testing

This project's automated tests (`src/**/*.test.ts`, run by Vitest) are
integration tests: application logic, repositories, and Drizzle queries all
run for real against a real Postgres database. Only the true external
network boundary is mocked (Meta's Graph API, Redis, QStash) - never the
database.

## Required environment variables

Every DB-backed test file is wrapped in `describe.skipIf(!process.env.DATABASE_URL)`,
so the suite skips cleanly (not fails) if these aren't set:

- `DATABASE_URL` - a real Postgres connection string. Never point this at a
  production or shared database; use a disposable local/dev database.
- `DB_DRIVER=node-postgres` - selects the `pg`-based Drizzle driver (as
  opposed to Neon's HTTP driver, which local Postgres doesn't speak).
- `ENCRYPTION_KEY` - required by the app's encryption-at-rest helpers
  (Meta access tokens, legacy webhook secrets, etc. are stored encrypted).
  Any 32-byte value works for testing; see `.env.example` for the expected
  format.

`vitest.setup.ts` additionally fills in fallback values (only if unset) for
a handful of Meta/JWT config vars that various config guards require to be
present even though the actual network calls they gate are mocked in tests:
`META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`,
`PUBLIC_BASE_URL`, `AUTH_JWT_SECRET`. You don't need to set these yourself
for local test runs.

## Running the suite locally

```bash
# 1. Start a local Postgres (adjust to however you normally run one, e.g.
#    the project's docker-compose.yml, or a system service).
docker compose up -d postgres   # or: sudo service postgresql start

# 2. Apply migrations to the test database.
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/setu_test" \
  DB_DRIVER=node-postgres \
  npx tsx scripts/migrate.ts

# 3. Run the tests.
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/setu_test" \
  DB_DRIVER=node-postgres \
  ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")" \
  npx vitest run

# 4. Stop Postgres if you started it just for this.
docker compose down             # or: sudo service postgresql stop
```

Without `DATABASE_URL` set, `npx vitest run` still runs (and passes) - every
DB-backed suite reports as skipped rather than failing, so CI or a quick
local check without Postgres available won't produce false failures.

## Mocking strategy

- **Redis** (`src/infrastructure/cache/redis.ts`) and **QStash**
  (`src/infrastructure/queue/qstash.ts`) are mocked globally, once, in
  `vitest.setup.ts` (wired in via `vitest.config.ts`'s `setupFiles`). Redis
  is backed by an in-memory fake (`src/testSupport/fakeRedis.ts`) with real
  claim/release/TTL semantics; QStash publishes are captured into an
  in-memory array (`src/testSupport/qstashCapture.ts`) instead of making a
  network call.
- **Meta's Graph API** (`src/infrastructure/meta/graphClient.ts`) is mocked
  per test file, not globally, since the right response varies by scenario.
  Each file's `vi.mock(...)` factory spreads the real module first, then
  overrides only the network-calling exports - so `MetaApiError` and
  `classifyMetaAuthError` stay real, which matters for the auth-error-kind
  tests.
- Everything else - `processMetaLeadEvent`, `runMetaSync`,
  `captureLeadgenEvents`, every repository function, every Drizzle query -
  runs unmocked, against the real test database.

## Test support helpers (`src/testSupport/`)

- `dbFixtures.ts` - `makeTenant(label)` creates a real company + role + user
  row, standing in for one tenant. Every id is suffixed with a counter +
  timestamp so parallel test files never collide.
- `fakeRedis.ts` / `qstashCapture.ts` - the in-memory fakes described above.
- `httpFixtures.ts` - minimal `VercelRequest`/`VercelResponse` stand-ins for
  the handful of tests that call a real API handler
  (`api/webhooks/meta/handler.ts`'s default export) end-to-end.

## Where each Phase 20 scenario lives

| Area | File |
| --- | --- |
| OAuth | `src/application/metaOAuth.flow.test.ts` |
| Sync | `src/application/metaSync/sync.flow.test.ts` |
| Webhook | `src/application/metaSync/webhook.flow.test.ts` |
| Lead creation | `src/application/leadCreation.flow.test.ts` |
| Security (tenant isolation) | `src/security/tenantIsolation.test.ts` |
| Failure recovery | `src/application/failureRecovery.flow.test.ts` |

Each file's header comment cross-references this document and summarizes
what's mocked versus real for that file specifically.
