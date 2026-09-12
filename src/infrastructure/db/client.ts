// Two drivers, one schema, chosen at runtime by NODE_ENV.
//
// In production (Vercel), we use Neon's HTTP driver: each query is a single
// stateless HTTPS request with no long-lived TCP connection. That matters
// because Vercel functions are ephemeral and can scale to thousands of
// concurrent invocations - a classic pg.Pool would either exhaust Neon's
// connection limit or require a separate pooler. The HTTP driver sidesteps
// the problem entirely, which is what makes this safe at 1,000+ concurrent
// webhook deliveries on a serverless platform.
//
// Locally (docker-compose), DATABASE_URL points at plain Postgres, which
// does not speak Neon's HTTP wire protocol - so local dev uses the standard
// `pg` driver via drizzle-orm/node-postgres instead. Both paths share the
// exact same Drizzle schema, so queries written against `db` behave
// identically in dev and production.
//
// DB latency (observability, RUTA telemetry) - both drivers funnel EVERY
// query through exactly one call-through point regardless of which Drizzle
// query builder method is used: the neon-http driver calls its `sql` client
// function directly (drizzle-orm/neon-http's NeonHttpPreparedQuery.execute
// does `client(query.sql, params, opts)`); the node-postgres driver calls
// `pool.query(...)` for every non-transactional query (drizzle-orm/
// node-postgres's driver hands the raw `pool` straight to NodePgSession
// when no transaction is in progress). Wrapping that ONE function per
// driver, here, gives every query anywhere in this app a latency+status
// metric with zero call-site changes in crmTools.ts/analyticsTools.ts/the
// repositories - and, just as important, means query text and bind params
// (which can contain a lead's name, phone number, or other free-text CRM
// content) never have to pass through this wrapper to get timing: it only
// ever reads `Date.now()`/`performance.now()` and the outcome
// (resolved/rejected), never the arguments themselves. drizzle's own
// query-builder methods (`db.select()...` etc.) are never touched - only
// the driver-level function each of them eventually calls into.
import { performance } from "node:perf_hooks";
import { recordDbLatency } from "../observability/telemetry";
import { getEnv } from "../env";
import * as schema from "./schema";

/** Wraps a driver's call-through function so every invocation emits a
 * db.latency metric (see this file's own header) without touching what's
 * passed in or returned - `fn`'s arguments (query text, bind params) are
 * forwarded untouched and never inspected here. */
function withDbTiming<A extends unknown[], R>(fn: (...args: A) => Promise<R>, driver: "neon-http" | "node-postgres"): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const startedAt = performance.now();
    try {
      const result = await fn(...args);
      recordDbLatency(performance.now() - startedAt, "ok", driver);
      return result;
    } catch (err) {
      recordDbLatency(performance.now() - startedAt, "error", driver);
      throw err;
    }
  };
}

function getConnectionString(): string {
  const url = getEnv("DATABASE_URL");
  if (!url) {
    throw new Error("DATABASE_URL is not set. See .env.example.");
  }
  return url;
}

async function createDb() {
  const isLocal = process.env.DB_DRIVER === "node-postgres" || process.env.NODE_ENV === "development";

  if (isLocal) {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: getConnectionString(), max: 5 });
    // pg's Pool.query is a heavily overloaded signature (callback vs.
    // promise forms) that TypeScript can't cleanly preserve through a
    // generic wrapper - drizzle-orm/node-postgres only ever calls the
    // promise form (`client.query(query, params)`, no callback), so this
    // loosely-typed rebind is safe in practice; the cast back to
    // `typeof pool.query` keeps every OTHER caller of `pool.query`
    // elsewhere in this codebase seeing its normal, fully-typed signature.
    const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
    pool.query = withDbTiming(originalQuery, "node-postgres") as typeof pool.query;
    return drizzle(pool, { schema });
  }

  const { neon, neonConfig } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  neonConfig.fetchConnectionCache = true;
  const rawSql = neon(getConnectionString());
  const sql = withDbTiming(rawSql, "neon-http") as typeof rawSql;
  return drizzle(sql, { schema });
}

// Cache across warm invocations of the same Vercel function instance.
let dbPromise: ReturnType<typeof createDb> | undefined;

export function getDb() {
  if (!dbPromise) {
    dbPromise = createDb();
  }
  return dbPromise;
}

export type Database = Awaited<ReturnType<typeof createDb>>;
