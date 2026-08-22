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
