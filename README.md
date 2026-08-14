# Meta Lead Ads → CRM Integration

Serverless ingestion pipeline for Facebook/Instagram Lead Ads, built to run entirely on free-tier
services: **Vercel** (API + dashboard), **Neon** (Postgres, source of truth), **Upstash Redis**
(idempotency cache) and **Upstash QStash** (durable queue + retries/backoff + DLQ + scheduling).
No AWS, no Azure, nothing that requires a credit card to try.

See the full architecture document for the "why" behind every decision here. This README is the
"how to run it" reference.

## Prerequisites

- Node.js 20+
- Docker (for local Postgres + Redis only — production has no containers)
- Free accounts: [Vercel](https://vercel.com), [Neon](https://neon.tech), [Upstash](https://upstash.com)
- A Meta developer app with Lead Ads webhook access

## Local development

```bash
npm install
cp .env.example .env   # fill in META_* and Upstash values; DB_DRIVER=node-postgres for local

# 1) start local Postgres + the Upstash-compatible Redis HTTP shim
docker compose up -d

# 2) apply the schema
npm run db:generate    # only needed after changing src/infrastructure/db/schema.ts
npm run db:migrate

# 3) start a local QStash emulator (separate terminal)
npx @upstash/qstash-cli dev
# copy the printed QSTASH_TOKEN / signing keys into .env

# 4) start the app (separate terminal)
npm run dev             # vercel dev, defaults to http://localhost:3000
```

Meta and QStash both need to reach your machine over HTTPS. Use a tunnel (`ngrok http 3000` or
`cloudflared tunnel --url http://localhost:3000`) and set `PUBLIC_BASE_URL` to the tunnel URL
before testing real webhook deliveries end-to-end.

Register the recurring reconciliation schedule once:

```bash
npm run setup:schedules
```

## Deploying to production (all free tier)

1. **Neon** — create a project, copy the pooled connection string into `DATABASE_URL` on Vercel
   (leave `DB_DRIVER` unset there so the app uses the Neon HTTP driver). Run
   `npm run db:migrate` locally against Neon's direct (non-pooled) connection string once.
2. **Upstash Redis** — create a Redis database, copy the REST URL/token into
   `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`.
3. **Upstash QStash** — copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`,
   `QSTASH_NEXT_SIGNING_KEY`.
4. **Vercel** — `vercel link`, set all variables from `.env.example` as Environment Variables
   (Production + Preview), then `vercel --prod`. Set `PUBLIC_BASE_URL` to the assigned
   `*.vercel.app` domain (or your custom domain) **before** the first deploy that runs
   `setup:schedules`, since QStash needs a real, reachable URL to schedule against.
5. Run `npm run setup:schedules` once (locally, pointed at prod env vars, or as a one-off Vercel
   deployment step) to register the QStash reconciliation schedule.
6. In Meta App Dashboard → Webhooks, subscribe the `leadgen` field to
   `https://<your-domain>/api/webhooks/meta` using `META_VERIFY_TOKEN` for the handshake.

## Key endpoints

| Path | Purpose |
|---|---|
| `POST /api/webhooks/meta` | Meta webhook receiver (also handles the `GET` verification handshake) |
| `POST /api/internal/process-lead` | QStash-invoked worker — fetches + persists one lead |
| `POST /api/internal/reconciliation` | QStash-scheduled sweep; also reachable via Vercel's daily fallback cron |
| `POST /api/internal/dead-letter` | QStash failure callback — records permanently failed leads |
| `GET /api/monitoring/metrics` | Received/processed/pending/failed/duplicate/dead-lettered/retry counts |
| `GET /api/leads` | Recent leads, `?status=` filter, `?limit=` |
| `GET /api/health` | Postgres + Redis + QStash reachability |

`public/dashboard.html` is a static page (served automatically by Vercel from `/public`) that
reads `/api/monitoring/metrics` and `/api/leads` — open `/dashboard.html` on your deployment.

## n8n

n8n is intentionally outside the critical path. It should poll `GET /api/leads?status=processed`
or subscribe to your own downstream event source — it never receives the Meta webhook directly
and can never block or lose a lead by being slow or down.

## Tests

```bash
npm test
```
