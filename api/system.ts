// Combines /api/health, /api/monitoring/metrics, and /api/permissions into
// ONE Vercel Function - see api/auth/[[...action]].ts for the same reasoning.
// Unlike the other consolidations, these three lived in different top-level
// directories, so a same-directory catch-all route can't cover all of them;
// instead vercel.json rewrites each original URL to this file with a
// `?resource=` query param, so the public URLs are byte-for-byte unchanged
// (existing uptime monitors, the dashboard, and the role editor all keep
// working with no changes).

import { getEnv } from "../src/infrastructure/env";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { sql } from "drizzle-orm";
import { getDb } from "../src/infrastructure/db/client";
import { requireAuth, requirePermission, requirePlatformAdmin } from "../src/infrastructure/auth/context";
import { PLATFORM_ADMIN_COOKIE_NAME, cookieOptions, clearCookieOptions } from "../src/infrastructure/auth/tokens";
import {
  cancelSubscription,
  extendCompanyTrial,
  forceActivateSubscription,
  getCustomerActivityList,
  getPlatformAuditLogList,
  getPlatformCompanyDetail,
  getPlatformDashboard,
  getPlatformNotificationList,
  getPlatformPackagesOverview,
  getUserNotificationList,
  loginPlatformAdmin,
  publishPlatformNotification,
  readUserNotification,
  refundPaymentOrder,
  setPlatformCompanyStatus,
  updateCycleDiscount,
  updatePlatformPackage,
} from "../src/application/platformAdmin";
import { AuthError } from "../src/application/auth";
import { getCompanyById } from "../src/infrastructure/db/repositories/tenancy";
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
    case "platform-admin":
      return handlePlatformAdmin(req, res);
    case "notifications":
      return handleNotifications(req, res);
    default:
      res.status(404).json({ error: "Not found" });
  }
}

async function handlePlatformAdmin(req: VercelRequest, res: VercelResponse) {
  const action = typeof req.query.action === "string" ? req.query.action : "";
  if (action === "login") {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const body = req.body as { email?: string; password?: string };
    if (!body?.email || !body.password) {
      res.status(400).json({ error: "Email and password are required." });
      return;
    }
    try {
      const result = await loginPlatformAdmin({ email: body.email, password: body.password });
      res.setHeader("Set-Cookie", `${PLATFORM_ADMIN_COOKIE_NAME}=${result.token};${cookieOptions(30 * 60)}`);
      res.status(200).json({ admin: result.admin });
    } catch (err) {
      if (err instanceof Error && "status" in err) {
        res.status(Number((err as AuthError).status)).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Failed to sign in." });
    }
    return;
  }
  if (action === "logout") {
    res.setHeader("Set-Cookie", `${PLATFORM_ADMIN_COOKIE_NAME}=;${clearCookieOptions()}`);
    res.status(200).json({ ok: true });
    return;
  }
  if (action === "dashboard") {
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      const search = typeof req.query.search === "string" ? req.query.search.trim() : undefined;
      res.status(200).json(await getPlatformDashboard(search));
    } catch {
      res.status(500).json({ error: "Failed to load platform dashboard." });
    }
    return;
  }
  if (action === "company") {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) {
      res.status(400).json({ error: "companyId is required." });
      return;
    }
    try {
      if (req.method === "GET") {
        res.status(200).json(await getPlatformCompanyDetail(companyId));
        return;
      }
      if (req.method === "PATCH") {
        const body = req.body as { status?: string; reason?: string };
        if (body?.status !== "active" && body?.status !== "suspended") {
          res.status(400).json({ error: "status must be active or suspended." });
          return;
        }
        res.status(200).json(await setPlatformCompanyStatus({ adminId: admin.adminId, companyId, status: body.status, reason: body.reason?.trim() }));
        return;
      }
      res.status(405).json({ error: "Method not allowed" });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error("[platform-admin/company] Failed:", err);
      res.status(500).json({ error: "Failed to manage customer account." });
    }
    return;
  }
  if (action === "notifications") {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      if (req.method === "GET") {
        res.status(200).json({ notifications: await getPlatformNotificationList() });
        return;
      }
      if (req.method === "POST") {
        const body = req.body as { targetType?: string; targetCompanyId?: string; targetUserId?: string; title?: string; message?: string; ctaLabel?: string; ctaUrl?: string };
        res.status(201).json(await publishPlatformNotification({ adminId: admin.adminId, targetType: body.targetType ?? "", targetCompanyId: body.targetCompanyId, targetUserId: body.targetUserId, title: body.title ?? "", message: body.message ?? "", ctaLabel: body.ctaLabel, ctaUrl: body.ctaUrl }));
        return;
      }
      res.status(405).json({ error: "Method not allowed" });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      res.status(500).json({ error: "Failed to manage notifications." });
    }
    return;
  }
  if (action === "audit") {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    res.status(200).json({ logs: await getPlatformAuditLogList() });
    return;
  }
  // Platform Admin "Packages" - editable pricing config. GET returns both
  // packages and cycle discounts together (public/admin/packages.html
  // renders them on one page); PATCH always targets exactly one row -
  // body.kind picks which of the two tables ("package" | "cycle_discount"),
  // same "one PATCH, a discriminant field picks the target" shape as
  // handleCompanyPatch's own req.body.status branch above.
  if (action === "packages") {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    try {
      if (req.method === "GET") {
        res.status(200).json(await getPlatformPackagesOverview());
        return;
      }
      if (req.method === "PATCH") {
        const body = req.body as { kind?: string; accountType?: string; baseMonthlyPaise?: number; baseCampaignLimit?: number; baseClientLimit?: number | null; overageUnitMonthlyPaise?: number; cycle?: string; discountPercent?: number };
        if (body?.kind === "cycle_discount") {
          res.status(200).json(await updateCycleDiscount({ adminId: admin.adminId, cycle: body.cycle ?? "", discountPercent: Number(body.discountPercent) }));
          return;
        }
        res.status(200).json(
          await updatePlatformPackage({
            adminId: admin.adminId,
            accountType: body.accountType ?? "",
            baseMonthlyPaise: Number(body.baseMonthlyPaise),
            baseCampaignLimit: Number(body.baseCampaignLimit),
            baseClientLimit: body.baseClientLimit == null ? null : Number(body.baseClientLimit),
            overageUnitMonthlyPaise: Number(body.overageUnitMonthlyPaise),
          }),
        );
        return;
      }
      res.status(405).json({ error: "Method not allowed" });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error("[platform-admin/packages] Failed:", err);
      res.status(500).json({ error: "Failed to manage pricing config." });
    }
    return;
  }
  // Platform Admin "Subscriptions" - full billing management for ONE
  // customer. GET is deliberately NOT duplicated here - it is the exact
  // same read as the "company" action above (getPlatformCompanyDetail),
  // which public/admin/subscriptions.html calls directly; this branch is
  // POST-only, dispatched on body.action so every write this feature added
  // (extend trial / force-activate / cancel / refund one payment order)
  // shares one rewrite rather than needing four.
  if (action === "subscription") {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) {
      res.status(400).json({ error: "companyId is required." });
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    const body = req.body as { action?: string; days?: number; cycle?: string; orderId?: string; refundAmountInPaise?: number; reason?: string };
    try {
      if (body?.action === "extend_trial") {
        res.status(200).json(await extendCompanyTrial({ adminId: admin.adminId, companyId, days: Number(body.days), reason: body.reason }));
        return;
      }
      if (body?.action === "force_activate") {
        res.status(200).json(await forceActivateSubscription({ adminId: admin.adminId, companyId, cycle: body.cycle ?? "", reason: body.reason }));
        return;
      }
      if (body?.action === "cancel") {
        res.status(200).json(await cancelSubscription({ adminId: admin.adminId, companyId, reason: body.reason }));
        return;
      }
      if (body?.action === "refund_order") {
        if (!body.orderId) {
          res.status(400).json({ error: "orderId is required." });
          return;
        }
        res.status(200).json(await refundPaymentOrder({ adminId: admin.adminId, companyId, orderId: body.orderId, refundAmountInPaise: body.refundAmountInPaise, reason: body.reason }));
        return;
      }
      res.status(400).json({ error: "Unknown subscription action." });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      console.error("[platform-admin/subscription] Failed:", err);
      res.status(500).json({ error: "Failed to manage subscription." });
    }
    return;
  }
  // Platform Admin "Customer Activity" - agency/client activity across ALL
  // customers (see getCustomerActivityList's own doc comment in
  // src/application/platformAdmin.ts for scope/limits). GET-only, filtered
  // by an optional companyId and simple limit/offset paging.
  if (action === "customer-activity") {
    const admin = await requirePlatformAdmin(req, res);
    if (!admin) return;
    if (req.method !== "GET") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }
    try {
      const companyId = typeof req.query.companyId === "string" && req.query.companyId ? req.query.companyId : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const offset = req.query.offset ? Number(req.query.offset) : undefined;
      res.status(200).json(await getCustomerActivityList({ companyId, limit, offset }));
    } catch (err) {
      console.error("[platform-admin/customer-activity] Failed:", err);
      res.status(500).json({ error: "Failed to load customer activity." });
    }
    return;
  }
  res.status(404).json({ error: "Not found" });
}

async function handleNotifications(req: VercelRequest, res: VercelResponse) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(404).json({ error: "Company not found." });
    return;
  }
  const action = typeof req.query.action === "string" ? req.query.action : "list";
  try {
    if (action === "list" && req.method === "GET") {
      res.status(200).json({ notifications: await getUserNotificationList({ userId: auth.userId, companyId: auth.companyId, accountType: company.accountType }) });
      return;
    }
    if (action === "read" && req.method === "POST") {
      const notificationId = typeof req.query.notificationId === "string" ? req.query.notificationId : "";
      if (!notificationId) {
        res.status(400).json({ error: "notificationId is required." });
        return;
      }
      await readUserNotification(notificationId, auth.userId);
      res.status(200).json({ ok: true });
      return;
    }
    res.status(405).json({ error: "Method not allowed" });
  } catch {
    res.status(500).json({ error: "Failed to load notifications." });
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
    const url = getEnv("UPSTASH_REDIS_REST_URL");
    const token = getEnv("UPSTASH_REDIS_REST_TOKEN");
    if (!url || !token) return false;
    const response = await fetch(`${url}/ping`, { headers: { Authorization: `Bearer ${token}` } });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkQStash(): Promise<boolean> {
  try {
    const token = getEnv("QSTASH_TOKEN");
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
