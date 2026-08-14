// Powers the dashboard (see public/dashboard.html) - company-scoped, so one
// tenant never sees another's counts. Computed directly from Postgres - the
// source of truth - rather than from Redis or QStash, so the numbers are
// correct even if the cache layer or queue had issues during the window.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { getIntegrationCounts, getLastReconciliationRun } from "../../src/infrastructure/db/repositories";
import { PERMISSIONS } from "../../src/domain/permissions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
