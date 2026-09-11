// RUTA Insight/Alert Engine - the "Insight Record" pipeline stage: persists
// a DetectedInsight (insightDetection.ts) as a durable row, using the
// (tenantId, dedupeKey) unique index (schema.ts's rutaInsights /
// migration 0038) as the idempotency mechanism for DETECTION itself - the
// same rule re-firing for the same tenant/entity/period (the scan runs
// every 30 minutes while a condition remains true) inserts nothing new.
// Only a GENUINELY NEW insight (one that didn't already exist) should ever
// get notifications enqueued for it - see notificationQueue.ts's caller in
// insightScanService.ts, which only acts on this function's non-null
// results.

import { and, desc, eq, gte } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { rutaInsights } from "../../infrastructure/db/schema";
import type { DetectedInsight } from "./insightDetection";

export interface StoredInsight {
  id: string;
  tenantId: string;
  kind: string;
  severity: string;
  title: string;
  message: string;
  metrics: Record<string, unknown>;
  detectedAt: Date;
}

/** Inserts one detected insight for a tenant. Returns the stored row when
 * this was a GENUINELY NEW insight (no prior row shared this tenant's
 * dedupeKey); returns null when it was a duplicate re-detection - the
 * INSERT is a true no-op in that case (onConflictDoNothing), not an
 * update, so an insight's `message`/`metrics` are exactly what they were
 * the FIRST time this condition was detected, never silently rewritten by
 * a later scan. */
export async function recordInsight(tenantId: string, detected: DetectedInsight): Promise<StoredInsight | null> {
  const db = await getDb();
  const inserted = await db
    .insert(rutaInsights)
    .values({
      tenantId,
      kind: detected.kind,
      severity: detected.severity,
      dedupeKey: detected.dedupeKey,
      title: detected.title,
      message: detected.message,
      metrics: detected.metrics,
      windowStart: detected.windowStart,
      windowEnd: detected.windowEnd,
    })
    .onConflictDoNothing({ target: [rutaInsights.tenantId, rutaInsights.dedupeKey] })
    // Deliberately bare .returning() (no column-selection object) - see
    // this project's own note on a drizzle-orm/TypeScript inference limit
    // hit by these Phase E tables specifically: a `.returning({ ... })`
    // column-selection object collapses the overload to a 0-argument-only
    // signature here, while the full-row form resolves fine. Every caller
    // in this file picks only the fields it needs from the full row below.
    .returning();
  const row = inserted[0];
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenantId,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    message: row.message,
    metrics: (row.metrics as Record<string, unknown>) ?? {},
    detectedAt: row.detectedAt,
  };
}

/** Tenant-scoped lookup by id, used by rutaTools.ts's explainLastInsight
 * tool ("Why?") to retrieve an insight's already-computed metrics - the
 * LLM composition step (rutaReplyComposer.ts) phrases an explanation of
 * this data, it never recomputes anything. Deliberately re-checks
 * tenantId (never trusts an id alone) - same tenant-isolation posture as
 * every other by-id lookup in this codebase. */
export async function getInsightById(tenantId: string, insightId: string): Promise<StoredInsight | null> {
  const db = await getDb();
  const [row] = await db
    .select({
      id: rutaInsights.id,
      tenantId: rutaInsights.tenantId,
      kind: rutaInsights.kind,
      severity: rutaInsights.severity,
      title: rutaInsights.title,
      message: rutaInsights.message,
      metrics: rutaInsights.metrics,
      detectedAt: rutaInsights.detectedAt,
    })
    .from(rutaInsights)
    .where(and(eq(rutaInsights.tenantId, tenantId), eq(rutaInsights.id, insightId)))
    .limit(1);
  if (!row) return null;
  return { ...row, metrics: (row.metrics as Record<string, unknown>) ?? {} };
}

/** Recent insights for a tenant, newest first - used by tests/diagnostics
 * and by insightScanService.ts's own summary logging. Not exposed to any
 * WhatsApp tool (RUTA answers "Why?" about the LAST DELIVERED insight
 * only, via userWhatsappLinks.lastInsightId - see rutaTools.ts). */
export async function listRecentInsights(tenantId: string, sinceHours = 24): Promise<StoredInsight[]> {
  const db = await getDb();
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);
  const rows = await db
    .select({
      id: rutaInsights.id,
      tenantId: rutaInsights.tenantId,
      kind: rutaInsights.kind,
      severity: rutaInsights.severity,
      title: rutaInsights.title,
      message: rutaInsights.message,
      metrics: rutaInsights.metrics,
      detectedAt: rutaInsights.detectedAt,
    })
    .from(rutaInsights)
    .where(and(eq(rutaInsights.tenantId, tenantId), gte(rutaInsights.detectedAt, since)))
    .orderBy(desc(rutaInsights.detectedAt));
  return rows.map((row) => ({ ...row, metrics: (row.metrics as Record<string, unknown>) ?? {} }));
}
