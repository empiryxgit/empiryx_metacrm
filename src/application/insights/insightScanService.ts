// RUTA Insight/Alert Engine - the top-level orchestrator, "Scheduled Job ->
// Tenant-scoped Analytics -> Rules/Detection -> Insight Record ->
// Notification Queue" all wired together. Invoked by api/internal/handler.ts's
// handleInsightsScan (action="insights-scan"), itself triggered by ONE
// global QStash schedule (ensureInsightScanSchedule in
// src/infrastructure/queue/qstash.ts) - NOT a schedule per tenant. This
// mirrors src/application/reconcile.ts's own established pattern exactly
// (see that file's header comment): a single sweep internally loops over
// every eligible tenant, rather than provisioning a QStash schedule per
// tenant, which keeps this within QStash's free-tier schedule limits
// however many companies sign up.
//
// "Every scheduled job must execute with explicit tenant_id and never
// operate on global data" - the ONE necessary cross-tenant query (listing
// which tenants are even eligible) lives ONLY here, in this outer loop;
// every function this loop calls into (scanTenantForInsights,
// recordInsight, enqueueNotificationsForInsight) takes an explicit tenantId
// and scopes every query it runs by it - see each of those files' own
// header comments.
//
// Per-tenant error isolation, same posture as reconcile.ts's own loops: one
// tenant's detection or queueing blowing up must never abort the sweep for
// every other tenant.

import { listInsightScanTenants } from "../../infrastructure/db/repositories/whatsapp";
import { scanTenantForInsights } from "./insightDetection";
import { recordInsight } from "./insightStore";
import { enqueueNotificationsForInsight } from "./notificationQueue";

export interface InsightScanSummary {
  tenantsScanned: number;
  insightsDetected: number; // every rule that fired this sweep, including re-detections of an already-known condition
  insightsNew: number; // only the ones recordInsight actually inserted (genuinely new, not a duplicate re-detection)
  notificationsQueued: number;
  notificationsSkippedMuted: number;
  notificationsSkippedFrequencyCap: number;
  errors: number;
}

export async function runInsightScan(): Promise<InsightScanSummary> {
  const tenants = await listInsightScanTenants();

  const summary: InsightScanSummary = {
    tenantsScanned: 0,
    insightsDetected: 0,
    insightsNew: 0,
    notificationsQueued: 0,
    notificationsSkippedMuted: 0,
    notificationsSkippedFrequencyCap: 0,
    errors: 0,
  };

  for (const tenant of tenants) {
    summary.tenantsScanned++;
    try {
      const detected = await scanTenantForInsights(tenant.tenantId, tenant.timezone);
      summary.insightsDetected += detected.length;

      for (const candidate of detected) {
        // recordInsight is the idempotency boundary for DETECTION itself -
        // a null result means this exact condition was already recorded
        // (the scan runs every 30 minutes; most iterations re-detect an
        // already-known, still-true condition) and notifications must NOT
        // be re-enqueued for it.
        const stored = await recordInsight(tenant.tenantId, candidate);
        if (!stored) continue;

        summary.insightsNew++;
        const enqueueResult = await enqueueNotificationsForInsight(tenant.tenantId, stored, tenant.timezone);
        summary.notificationsQueued += enqueueResult.queuedPending;
        summary.notificationsSkippedMuted += enqueueResult.skippedMuted;
        summary.notificationsSkippedFrequencyCap += enqueueResult.skippedFrequencyCap;
      }
    } catch (err) {
      summary.errors++;
      console.error(`[insights-scan] Failed for tenant ${tenant.tenantId}:`, err);
    }
  }

  return summary;
}
