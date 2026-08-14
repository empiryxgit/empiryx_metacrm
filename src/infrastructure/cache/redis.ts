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

export async function tryClaimLeadId(metaLeadId: string, ttlSeconds = 60 * 60 * 24): Promise<boolean> {
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
