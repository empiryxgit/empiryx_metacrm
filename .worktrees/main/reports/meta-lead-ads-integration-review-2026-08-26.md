# Meta Lead Ads Integration — Review & Refactoring Report

**Date:** 2026-08-26
**Scope:** Full inspection of the Meta/Facebook Lead Ads integration (auth, asset discovery, campaign sync, lead-form sync, webhook ingestion, attribution, reconciliation) against the expected production architecture, with targeted fixes. No unrelated modules were touched; no existing behavior was removed.

---

## 1. Current Flow Found

The codebase runs **two parallel Meta lead-capture pipelines** that both remain live in production today:

**A. Tenant-level pipeline (current, primary)**
`metaOAuth.ts` (tenant connects Meta once via OAuth, scopes in `OAUTH_SCOPES`) → `metaConnectionService.ts` (`getConnectionForSync`, token stored encrypted in `meta_connections`) → `runMetaSync.ts` orchestrates, in order:
`metaPageService.ts` (Pages + Instagram) → `metaAdAccountService.ts` (Ad Accounts) → `metaCampaignService.ts` (Campaigns → Ad Sets → Ads, scoped to the *selected* ad account) → `metaFormService.ts` (Lead Forms, scoped to the *selected* Page, + field-mapping seeding).
Real-time leads arrive via `api/webhooks/meta/handler.ts`'s tenant-level webhook route → signature verified (`verifySignature.ts`) → `qstash.ts` publishes → `api/internal/handler.ts` worker → `processMetaLeadEvent.ts` fetches lead detail (`getLeadDetails`), resolves fields (`resolveLeadFields.ts`), attributes to a CRM campaign (`getMetaCampaignByMetaCampaignId`), and writes via `insertMetaSyncLead` (`metaLeadEvents.ts`), guarded by the Redis fast-path claim + the `leads.meta_lead_id` unique index.

**B. Legacy per-campaign pipeline (still active, older)**
Each CRM `campaign` can carry its own `webhook_configs` row with its own Meta app secret/access token and its own slug-routed webhook URL. Events land in `raw_meta_events`, get resolved through the same `resolveLeadFields`, and are written through a separate insert path keyed by that campaign directly (not through `insertMetaSyncLead`).

**Shared infrastructure across both:** `graphClient.ts` (single Graph API client, `fetchWithRetry`, `classifyMetaAuthError`/`MetaApiError`), the `leads.meta_lead_id` unique index (the actual duplicate-prevention backstop for both pipelines), and `reconcile.ts` (one recurring job, triggered by QStash's 15-minute schedule and a daily 3am Vercel cron fallback, `LOOKBACK_HOURS` configurable).

Both pipelines' data lands in the same `leads` table, preserving `meta_lead_id`, `meta_page_id` (`pageId`), `meta_form_id`/name, `meta_campaign_id`/name, `meta_adset_id`/name, `meta_ad_id`/name, source/platform, `metaCreatedAt`, and `formResponses` (raw payload). No schema changes were needed — the fields the prompt asked to preserve already exist and are already populated by both pipelines.

---

## 2. Problems Identified

1. **Lead-Forms list wasn't scoped to the selected Page.** `listMetaFormsWithMappingCounts` returned *every* form ever synced for the tenant, not just the currently-selected Page's forms — the same class of bug already fixed this session for the Campaigns list (unscoped-by-currently-selected-resource). After a disconnect/reconnect to a different Page, stale forms from the previous Page kept appearing in Settings and in `GET /api/integrations/meta/status`.
2. **No historical lead backfill.** Meta only pushes *new* leads to the webhook going forward. A Page connected to RUTA for the first time could already have leads sitting in Meta from before the connection existed — these were silently unreachable with no backfill path, a real and permanent lead-loss gap on every fresh onboarding.
3. **Reconciliation only covered part of the tenant-level pipeline.** `reconcile.ts`'s recurring sweep already retried *unenqueued* QStash events for both pipelines and recovered *missing webhook deliveries* for the **legacy** pipeline — but had no equivalent self-healing for the **tenant-level** pipeline's own missing leads (a webhook Meta simply never sent, e.g. delivery outage), leaving that gap uncovered.
4. **No proactive long-lived token refresh.** `exchangeForLongLivedToken` existed only as a one-time, best-effort step at initial OAuth connect. A long-lived user token (~60 days) that isn't refreshed before expiry silently degrades every sync/webhook call for that tenant into `needs_reauth`, with no attempt to renew it ahead of time.
5. **(Identified, not changed) Ad Set/Ad catalog walk runs unconditionally inside every "Sync now."** `syncCampaignsForSelectedAdAccount` currently always walks every campaign's ad sets and ads on each sync — a real rate-limit/timeout risk as an account's catalog grows, and the underlying reason the user separately requested an on-demand, multiselect "fetch ads" feature. Left unchanged this pass: attribution does **not** depend on these catalog rows at all (a lead is attributed straight from the Meta IDs on the webhook/lead payload, independent of whether the catalog tables are populated), and `sync.flow.test.ts` has existing assertions that depend on `runMetaSync` populating ad-set/ad counts inline — changing this would violate the "do not break existing functionality" constraint. Recommended as a dedicated follow-up (see §6).
6. **(Reviewed, no gap found) Business Manager traversal.** The architecture doc's expected flow mentions Business → assets discovery; the current code instead calls `/me/adaccounts` and `/me/accounts` directly, which already returns every ad account/Page the authorized user has access to without an extra Business Manager hop. No functional gap — traversing Business Manager explicitly would only be needed for scenarios (e.g. multiple Business Managers with different access grants) not currently in scope, so nothing was added here.
7. **(Reviewed, no gap found) OAuth scopes.** Requested scopes are already the correct/complete set for this feature surface (`leads_retrieval`, `pages_manage_ads`, `ads_read`, `business_management`, plus the Page/Instagram read scopes); `REQUIRED_OAUTH_SCOPES` correctly excludes only the genuinely-optional `public_profile`/`email`/`instagram_basic`. No change needed.

---

## 3. Changes Made

### Fix 1 — Scope the Lead-Forms list to the selected Page
- `src/infrastructure/db/repositories/metaFormMappings.ts`: extracted the shared mapping-count logic into `attachMappingCounts()`, added `listMetaFormsWithMappingCountsForPage(tenantId, pageId)`. The original unscoped `listMetaFormsWithMappingCounts` is kept (tests / generic use only, documented as such).
- `api/webhooks/meta/handler.ts`: `handleMetaFormsCollection` and `handleOAuthStatus` now resolve the selected Page first (`getSelectedMetaPage`) and call the scoped function — returning `[]` when no Page is selected, exactly mirroring the Campaigns fix delivered earlier this session.

### Fix 2 — One-time historical lead backfill on first form sync
- `src/infrastructure/db/repositories/metaSync.ts`: added `getMetaFormByFormId(tenantId, formId)` — a plain existence check.
- `src/application/metaSync/metaFormService.ts` (rewritten in place, same public shape): before upserting synced forms, checks which form IDs are brand-new to this tenant (`getMetaFormByFormId`). For each brand-new form only, `syncHistoricalLeadsForForm` pages through `getRecentLeadsForForm` (existing generator, previously legacy-only) over a configurable lookback window (`META_HISTORICAL_LEAD_SYNC_LOOKBACK_DAYS`, default 90 days) and writes each lead through the exact same `resolveLeadFields` → `getMetaCampaignByMetaCampaignId` → `insertMetaSyncLead` path the real-time webhook uses — so a backfilled lead is indistinguishable in shape from one that arrived live. A single lead failing to resolve/insert is caught and skipped, never aborting the rest of the form's backfill; a whole form's backfill failing never fails the forms-sync step itself (forms/mappings are already durably saved by that point), and only `MetaApiError`-classified failures flag the connection.
- `src/application/metaSync/runMetaSync.ts`: the "Loading Forms" step's detail string now reports `", N historical leads captured"` when applicable.

### Fix 3 — Extend recurring reconciliation to the tenant-level pipeline's own missing leads
- `src/infrastructure/db/repositories.ts`: added `getRecentMetaLeadIdsForCompany(companyId, sinceIso)` — the tenant-scoped equivalent of the existing `getRecentMetaLeadIds`.
- `src/infrastructure/db/repositories/metaIntegration.ts`: added `listTenantsForMetaLeadReconciliation()` — joins each active connection to its selected Page and that Page's synced forms, returning one target per tenant (`{ tenantId, metaPageId, pageAccessToken, formIds[] }`).
- `src/application/reconcile.ts`: added a new sweep, structurally identical to the existing legacy-pipeline recovery loop — for each tenant target, pages through `getRecentLeadsForForm` per form, compares against `getRecentMetaLeadIdsForCompany`, and recovers anything missing via the same `resolveLeadFields` → `getMetaCampaignByMetaCampaignId` → `insertMetaSyncLead` path (identical to Fix 2's backfill and to the live webhook handler). Missing-Page fallback uses the real Meta Page ID from the join (`lead.pageId ?? target.metaPageId`) rather than an empty string. `ReconciliationSummary` gained additive fields (`tenantPipelineFormsScanned`, `tenantPipelineLeadsSeen`, `tenantPipelineMissingLeadsFound`, `tenantPipelineMissingLeadsRecovered`) — confirmed the only consumer (`api/internal/handler.ts`) just serializes the whole object, so this is a safe additive change.

### Fix 4 — Proactive long-lived token refresh
- `src/infrastructure/db/repositories/metaIntegration.ts`: added `listActiveMetaConnectionsExpiringBefore(cutoff)` and `updateMetaConnectionToken(connectionId, accessToken, tokenExpiresAt)`.
- `src/application/metaSync/metaTokenRefreshService.ts` (new file): `refreshExpiringMetaTokens()` finds active connections whose token expires within `META_TOKEN_REFRESH_WINDOW_DAYS` (default 10 days), re-runs the existing `exchangeForLongLivedToken` against each, and persists the renewed token/expiry. A failure to refresh one tenant's token is logged and, if it's an auth-classified failure, funneled through the existing `flagConnectionIfAuthError` — it never stops the sweep for other tenants.
- `src/application/reconcile.ts`: calls `refreshExpiringMetaTokens()` once per reconciliation run (piggybacking on the existing 15-minute/daily schedule rather than adding a new Vercel Function, which the 12-Function Hobby cap does not allow) and reports `tokensChecked`/`tokensRefreshed`/`tokensRefreshFailed` in the summary.

**Nothing else was changed.** No schema migrations were needed (all fields the prompt required were already present). No existing function signatures, API routes, or webhook contracts changed. Both `META_HISTORICAL_LEAD_SYNC_LOOKBACK_DAYS` and `META_TOKEN_REFRESH_WINDOW_DAYS` are optional env vars with working defaults — no `.env` change is required for this to work as shipped.

---

## 4. Final Integration Flow

```
Tenant connects Meta (OAuth) ─▶ meta_connections (encrypted token)
        │
        ▼
runMetaSync (manual "Sync now", safe to re-run — all upserts)
  ├─ Pages + Instagram  ──▶ meta_pages / meta_instagram_accounts
  ├─ Ad Accounts         ──▶ meta_ad_accounts
  ├─ Campaigns (scoped to selected Ad Account)
  │     └─ Ad Sets + Ads ──▶ meta_campaigns / meta_ad_sets / meta_ads
  └─ Lead Forms (scoped to selected Page)
        ├─ Forms + field mappings ──▶ meta_forms / meta_form_field_mappings
        └─ [NEW] first-time-only historical backfill (last 90d)
                 ──▶ resolveLeadFields ──▶ attribute to CRM campaign ──▶ insertMetaSyncLead ──▶ leads

Real-time leadgen event (Meta webhook)
  ──▶ signature verified ──▶ QStash publish ──▶ worker
        ──▶ getLeadDetails ──▶ resolveLeadFields ──▶ attribute to CRM campaign
        ──▶ Redis claim (fast-path) + leads.meta_lead_id unique index (authoritative)
        ──▶ insertMetaSyncLead ──▶ leads   (lead is saved even if attribution/enrichment fails)

Recurring reconciliation (QStash 15-min primary + daily 3am cron fallback)
  ├─ legacy per-campaign pipeline: recover missing leads + retry unenqueued events (existing)
  ├─ [NEW] tenant-level pipeline: recover missing leads the same way, per selected Page's forms
  └─ [NEW] proactively refresh any long-lived token expiring within 10 days
```

---

## 5. Files Changed

| File | Reason |
|---|---|
| `src/infrastructure/db/repositories/metaFormMappings.ts` | Add Page-scoped forms list (Fix 1); unscoped version kept for tests/generic use. |
| `api/webhooks/meta/handler.ts` | Use the Page-scoped forms list in both the Forms endpoint and the status endpoint (Fix 1). |
| `src/infrastructure/db/repositories/metaSync.ts` | Add `getMetaFormByFormId` existence check, used to gate one-time historical backfill (Fix 2). |
| `src/application/metaSync/metaFormService.ts` | Add one-time historical lead backfill for brand-new forms (Fix 2). |
| `src/application/metaSync/runMetaSync.ts` | Surface historical-backfill count in the "Loading Forms" step detail (Fix 2). |
| `src/infrastructure/db/repositories.ts` | Add tenant-scoped recent-Meta-lead-ID lookup, used by reconciliation (Fix 3). |
| `src/infrastructure/db/repositories/metaIntegration.ts` | Add reconciliation-target query (Fix 3) and token-expiry query/update (Fix 4). |
| `src/application/metaSync/metaTokenRefreshService.ts` | **New file** — proactive long-lived token refresh (Fix 4). |
| `src/application/reconcile.ts` | Add tenant-level-pipeline missing-lead recovery sweep (Fix 3) and wire in proactive token refresh (Fix 4). |

**Verification performed:** `npx tsc --noEmit` — clean, no errors, across the full changed set. `npm test` — 6 passed / 48 skipped (unchanged from baseline; the 48 skips are pre-existing and due to no `DATABASE_URL` in this sandbox, not caused by these changes — all affected test files still collect and import cleanly, confirming no broken imports/types from the `metaFormService.ts` rewrite).

---

## 6. Remaining Requirements (outside this codebase)

Nothing here requires a schema migration or app redeploy step beyond the normal deploy — these are Meta Developer Console / account-side items:

1. **Webhook subscription fields.** Confirm the tenant-level webhook's Page subscription in Meta's App Dashboard includes the `leadgen` field (Webhooks → Page → Subscribed Fields) — this review did not have access to the live App Dashboard to verify current subscriptions.
2. **App review / permissions.** `leads_retrieval`, `pages_manage_ads`, `ads_read`, and `business_management` are advanced permissions requiring Meta App Review for any Page/ad account not owned by an app admin/tester — confirm the app's current review status covers all connected tenants' Pages.
3. **Long-lived token lifetime assumption.** Fix 4 assumes Meta's standard ~60-day long-lived user token lifetime holds; if the app is later moved to System User tokens (Business Manager) for higher reliability, `metaTokenRefreshService.ts` would need updating to that flow instead — flagging as a future consideration, not a current gap.
4. **Historical backfill lookback (`META_HISTORICAL_LEAD_SYNC_LOOKBACK_DAYS`, default 90).** Meta's `/{form-id}/leads` endpoint does not reliably return data indefinitely far back in practice; if a tenant needs backfill beyond 90 days, this is a per-deployment env var override, not a code change.
5. **Recommended follow-up (not implemented this pass, see Problem 5):** move the Ad Set/Ad catalog walk out of the automatic "Sync now" flow and into the on-demand, multiselect "fetch ads" feature the user separately requested — this both resolves the rate-limit/timeout risk and delivers that feature. Scoped in an earlier session (ads list lives inside each Campaign's page; fetch is on-demand only) but not yet built.
