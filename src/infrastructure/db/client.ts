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

import * as schema from "./schema";

function getConnectionString(): string {
  const url = process.env.DATABASE_URL;
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
    return drizzle(pool, { schema });
  }

  const { neon, neonConfig } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  neonConfig.fetchConnectionCache = true;
  const sql = neon(getConnectionString());
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
