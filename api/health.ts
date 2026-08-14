// Liveness/readiness endpoint. Checks the three external dependencies this
// system cannot function without - Postgres, Redis, and QStash - and
// returns 200 only if all are reachable. Point your uptime monitor here.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDb } from "../src/infrastructure/db/client";
import { sql } from "drizzle-orm";

async function checkDatabase(): Promise<boolean> {
  try {
    const db = await getDb();
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

async function checkRedis(): Promise<boolean> {
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return false;
    const response = await fetch(`${url}/ping`, { headers: { Authorization: `Bearer ${token}` } });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkQStash(): Promise<boolean> {
  try {
    const token = process.env.QSTASH_TOKEN;
    if (!token) return false;
    const response = await fetch("https://qstash.upstash.io/v2/schedules", {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const [database, redis, queue] = await Promise.all([checkDatabase(), checkRedis(), checkQStash()]);
  const healthy = database && redis && queue;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    checks: { database, redis, queue },
    timestamp: new Date().toISOString(),
  });
}
