// Combines /api/health, /api/monitoring/metrics, and /api/permissions into
// ONE Vercel Function - see api/auth/[[...action]].ts for the same reasoning.
// Unlike the other consolidations, these three lived in different top-level
// directories, so a same-directory catch-all route can't cover all of them;
// instead vercel.json rewrites each original URL to this file with a
// `?resource=` query param, so the public URLs are byte-for-byte unchanged
// (existing uptime monitors, the dashboard, and the role editor all keep
// working with no changes).

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { getDb } from "../src/infrastructure/db/client";
import { requireAuth, requirePermission } from "../src/infrastructure/auth/context";
import { getIntegrationCounts, getLastReconciliationRun } from "../src/infrastructure/db/repositories";
import { PERMISSIONS, PERMISSION_CATALOG } from "../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = typeof req.query.resource === "string" ? req.query.resource : "";
  switch (resource) {
    case "health":
      return handleHealth(req, res);
    case "metrics":
      return handleMetrics(req, res);
    case "permissions":
      return handlePermissions(req, res);
    default:
      res.status(404).json({ error: "Not found" });
  }
}

// Liveness/readiness endpoint. Checks the three external dependencies this
// system cannot function without - Postgres, Redis, and QStash - and
// returns 200 only if all are reachable. Point your uptime monitor at
// /api/health.
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

async function handleHealth(req: VercelRequest, res: VercelResponse) {
  const [database, redis, queue] = await Promise.all([checkDatabase(), checkRedis(), checkQStash()]);
  const healthy = database && redis && queue;

  res.status(healthy ? 200 : 503).json({
    status: healthy ? "healthy" : "degraded",
    checks: { database, redis, queue },
    timestamp: new Date().toISOString(),
  });
}

// Powers the dashboard (see public/dashboard.html) - company-scoped, so one
// tenant never sees another's counts. Computed directly from Postgres - the
// source of truth - rather than from Redis or QStash, so the numbers are
// correct even if the cache layer or queue had issues during the window.
async function handleMetrics(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.DASHBOARD_VIEW);
  if (!auth) return;

  const hours = Number(req.query.hours ?? 24);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  try {
    const [counts, lastRun] = await Promise.all([
      getIntegrationCounts(auth.companyId, since),
      getLastReconciliationRun(auth.companyId),
    ]);

    res.status(200).json({
      windowHours: hours,
      ...counts,
      lastReconciliationAt: lastRun?.completedAt ?? null,
      lastReconciliationRecovered: lastRun?.missingLeadsRecovered ?? 0,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[metrics] Failed to compute counts:", err);
    res.status(500).json({ error: "Failed to compute metrics" });
  }
}

// Powers the role editor UI (public/admin/roles.html) - the fixed catalog
// of permission codes an admin can assign to a custom role.
async function handlePermissions(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  res.status(200).json({ permissions: PERMISSION_CATALOG });
}
