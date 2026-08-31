// Upstash Redis - HTTP-based, so like the Neon HTTP driver, it needs no
// persistent connection and is safe to call from any number of concurrent
// Vercel function invocations.
//
// This is a FAST-PATH optimisation only: it keeps duplicate/replayed Meta
// Lead IDs from reaching Postgres and the Graph API under bursty traffic.
// It is never the source of truth for idempotency - the unique index on
// leads.meta_lead_id is (see src/infrastructure/db/schema.ts). If Redis is
// unreachable we fail OPEN (treat as "not claimed yet") rather than block
// processing, because the Postgres constraint still prevents an actual
// duplicate CRM record.
//
// Phase 13 - the claim's TTL is deliberately short (minutes, not the 24h
// this used to default to). A claim only needs to outlive ONE processing
// attempt (seconds, bounded by the worker function's own maxDuration) plus
// a safety margin for a slow DB/Graph API round trip - never a full retry
// cycle. The reason this matters: a worker can be killed mid-flight by a
// hard timeout or crash (an OOM, a platform-level kill) with no chance to
// run a `finally`/catch and release its own claim - see processLead.ts and
// processMetaLeadEvent.ts's own Phase 13 comments for the try/catch that
// covers every OTHER failure mode. When that happens, the claim is stuck
// until it expires, and every retry that lands before then is incorrectly
// short-circuited to "duplicate" without the lead ever actually being
// created - a silent discard for as long as the TTL lasts. A 24h TTL made
// that window a full day; this shorter one bounds it to well under QStash's
// own retry schedule, so a legitimate retry gets a real chance to
// re-process the lead instead of just waiting out the crashed attempt's
// stale claim.

import { Redis } from "@upstash/redis";

function getRedis(): Redis {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error("UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set. See .env.example.");
  }
  return new Redis({ url, token });
}

const KEY_PREFIX = "leadid:";

export async function tryClaimLeadId(metaLeadId: string, ttlSeconds = 60 * 15): Promise<boolean> {
  try {
    const redis = getRedis();
    const result = await redis.set(KEY_PREFIX + metaLeadId, "1", { nx: true, ex: ttlSeconds });
    return result === "OK";
  } catch (err) {
    console.warn(`[idempotency] Redis unavailable, failing open for ${metaLeadId}:`, err);
    return true;
  }
}

export async function releaseLeadIdClaim(metaLeadId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(KEY_PREFIX + metaLeadId);
  } catch (err) {
    console.warn(`[idempotency] Redis unavailable while releasing claim for ${metaLeadId}:`, err);
  }
}

// ---------------------------------------------------------------------
// OAuth state single-use claim (see src/infrastructure/auth/oauthState.ts).
// The state JWT's own signature + short expiry already make it unforgeable
// and time-bounded; this narrows the replay window further to "exactly
// once," the same "fast-path, fail OPEN, never the sole source of truth"
// posture as tryClaimLeadId above - the state's signature/expiry check is
// what actually gates the callback, this is defense in depth on top of it.
// ---------------------------------------------------------------------

const OAUTH_STATE_KEY_PREFIX = "oauthstate:";

export async function tryClaimOAuthStateNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
  try {
    const redis = getRedis();
    const result = await redis.set(OAUTH_STATE_KEY_PREFIX + nonce, "1", { nx: true, ex: ttlSeconds });
    return result === "OK";
  } catch (err) {
    console.warn(`[oauth-state] Redis unavailable, failing open for nonce ${nonce}:`, err);
    return true;
  }
}

// ---------------------------------------------------------------------
// Phase 6: live Meta sync progress (Settings -> Integrations -> Meta's
// "Connecting Meta / Loading Pages / ..." checklist). The POST /sync
// handler writes the current step here as it works through the pipeline;
// the frontend polls GET /sync-status to render it live. Short TTL - this
// is UI-only, transient, never the source of truth for whether a sync
// actually completed (that's meta_connections.lastSyncAt/lastError,
// written durably by the sync itself regardless of whether this succeeds).
// Same "fail open" posture as the rest of this file: if Redis is down, the
// sync endpoint still runs to completion and returns its own full result -
// the frontend just falls back to showing a plain spinner instead of a
// live checklist, per its own polling error handling.
// ---------------------------------------------------------------------

export type MetaSyncStepStatus = "pending" | "running" | "done" | "error" | "skipped";

export interface MetaSyncStep {
  key: string;
  label: string;
  status: MetaSyncStepStatus;
  detail?: string; // short human-readable outcome, e.g. "3 pages" or an error message
}

export interface MetaSyncProgress {
  steps: MetaSyncStep[];
  updatedAt: string; // ISO timestamp, set by the caller (Date.now() is unavailable in some call sites)
}

const SYNC_PROGRESS_KEY_PREFIX = "metasync:";
const SYNC_PROGRESS_TTL_SECONDS = 5 * 60; // well past any realistic sync duration

export async function setMetaSyncProgress(tenantId: string, progress: MetaSyncProgress): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(SYNC_PROGRESS_KEY_PREFIX + tenantId, JSON.stringify(progress), { ex: SYNC_PROGRESS_TTL_SECONDS });
  } catch (err) {
    console.warn(`[meta-sync] Redis unavailable while writing progress for tenant ${tenantId}:`, err);
  }
}

export async function getMetaSyncProgress(tenantId: string): Promise<MetaSyncProgress | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get<MetaSyncProgress | string>(SYNC_PROGRESS_KEY_PREFIX + tenantId);
    if (!raw) return null;
    // The Upstash SDK auto-parses JSON string values it recognizes, so `raw`
    // may already be the object - handle both to be safe across versions.
    return typeof raw === "string" ? (JSON.parse(raw) as MetaSyncProgress) : raw;
  } catch (err) {
    console.warn(`[meta-sync] Redis unavailable while reading progress for tenant ${tenantId}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------
// Campaign performance trend (Reach/Impressions/Clicks/CTR - see
// getCampaignInsights in src/infrastructure/meta/graphClient.ts). Cached
// briefly so expanding a campaign row on the Campaigns screen, collapsing
// it, and expanding it again (or another user on the same tenant doing the
// same) doesn't cost a fresh Graph API call every time. Insights numbers
// don't move meaningfully faster than this TTL in practice, so a short
// cache trades a little staleness for materially fewer Graph API calls.
// Same fail-open posture as the rest of this file: a Redis miss/outage
// just means the request falls through to a live Meta fetch instead of
// failing outright.
// ---------------------------------------------------------------------

const CAMPAIGN_INSIGHTS_KEY_PREFIX = "campaigninsights:";
const CAMPAIGN_INSIGHTS_TTL_SECONDS = 30 * 60; // 30 minutes

// `rangeKey` identifies WHICH window is cached - either a preset day count
// ("30") or a custom "since:until" pair - so a preset and a custom range
// that happen to cover the same days never collide, and picking a
// different range never serves another range's stale data.
function campaignInsightsKey(tenantId: string, metaCampaignId: string, rangeKey: string): string {
  return `${CAMPAIGN_INSIGHTS_KEY_PREFIX}${tenantId}:${metaCampaignId}:${rangeKey}`;
}

export async function getCachedCampaignInsights<T = unknown>(tenantId: string, metaCampaignId: string, rangeKey: string): Promise<T | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get<T | string>(campaignInsightsKey(tenantId, metaCampaignId, rangeKey));
    if (!raw) return null;
    return typeof raw === "string" ? (JSON.parse(raw) as T) : raw;
  } catch (err) {
    console.warn(`[campaign-insights] Redis unavailable while reading cache for ${metaCampaignId}:`, err);
    return null;
  }
}

export async function setCachedCampaignInsights(tenantId: string, metaCampaignId: string, rangeKey: string, data: unknown): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(campaignInsightsKey(tenantId, metaCampaignId, rangeKey), JSON.stringify(data), { ex: CAMPAIGN_INSIGHTS_TTL_SECONDS });
  } catch (err) {
    console.warn(`[campaign-insights] Redis unavailable while writing cache for ${metaCampaignId}:`, err);
  }
}

// ---------------------------------------------------------------------
// Smart follow-up nudge dedup (see api/internal/handler.ts's
// "followup-nudges" action). Vercel's own daily Cron on Hobby has no
// exactly-once guarantee (a redeploy, a manual re-trigger via the
// dashboard, or a retried invocation could all fire the same day's sweep
// twice) - this is a claim, same NX/EX shape as tryClaimLeadId above, that
// keeps one agent from getting the same day's WhatsApp/SMS nudge more than
// once. Same fail-open posture as the rest of this file: if Redis is
// down, the nudge just might send twice in the same day rather than the
// whole run being blocked over a cache outage - an occasional duplicate
// text is a far smaller problem than silently never nudging anyone.
// ---------------------------------------------------------------------

const NUDGE_KEY_PREFIX = "followupnudge:";

export async function tryClaimFollowUpNudge(ownerId: string, dateKey: string, ttlSeconds = 60 * 60 * 26): Promise<boolean> {
  try {
    const redis = getRedis();
    const result = await redis.set(`${NUDGE_KEY_PREFIX}${dateKey}:${ownerId}`, "1", { nx: true, ex: ttlSeconds });
    return result === "OK";
  } catch (err) {
    console.warn(`[followup-nudge] Redis unavailable, failing open for owner ${ownerId}:`, err);
    return true;
  }
}

// ---------------------------------------------------------------------
// Security hardening - fixed-window rate limiting for the auth endpoints
// (api/auth/handler.ts's login/register/refresh/change-password). A simple
// INCR-then-EXPIRE counter per key, same "fail OPEN on Redis errors" posture
// as every other helper in this file: an Upstash outage degrades this
// deployment back to "no rate limiting" rather than locking every tenant
// out of login entirely, which would be a far worse outage than the brute-
// force window it's meant to close. bcrypt's own ~12-round cost already
// bounds a single guess to well over 100ms even without this, so a Redis
// outage is a temporary widening of the window, never an open door.
//
// `key` should already be fully scoped by the caller (e.g. an IP address,
// or "ip:email") - this helper itself only namespaces it so auth rate-limit
// counters can never collide with any other key this file manages.
// ---------------------------------------------------------------------

const RATE_LIMIT_KEY_PREFIX = "ratelimit:";

/** Returns true when the caller is still within `limit` calls per
 * `windowSeconds` for this key, incrementing the counter as a side effect;
 * false once the window's limit has been exceeded (the caller should
 * respond 429). */
export async function checkRateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  try {
    const redis = getRedis();
    const fullKey = RATE_LIMIT_KEY_PREFIX + key;
    const count = await redis.incr(fullKey);
    if (count === 1) {
      // Only the request that actually created the counter sets its
      // expiry, so a burst of concurrent requests can't each reset the
      // window and keep it alive forever.
      await redis.expire(fullKey, windowSeconds);
    }
    return count <= limit;
  } catch (err) {
    console.warn(`[rate-limit] Redis unavailable, failing open for ${key}:`, err);
    return true;
  }
}
