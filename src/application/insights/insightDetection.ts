// RUTA Insight/Alert Engine - TENANT-SCOPED DETECTION. This is the
// "Rules/Detection" pipeline stage:
//   Scheduled Job/Event -> Tenant-scoped Analytics -> RULES/DETECTION ->
//   Insight Record -> Notification Queue -> WhatsApp
//
// scanTenantForInsights(tenantId) is the ONLY entry point, and it takes an
// explicit, required tenantId - every query inside it (direct or via
// crmTools.ts/analyticsTools.ts) is scoped by that one tenant's companyId,
// never a cross-tenant aggregate. See insightScanService.ts for the caller
// that enumerates which tenants to scan (the one place a list of tenant IDs
// is legitimately fetched without yet being scoped to one) and never
// computes anything itself - only this file does.
//
// Two of the six rules (campaign_performance_change, conversion_rate_drop,
// lead_volume_anomaly) reuse analyticsTools.ts's already-built, ungated,
// company-wide functions directly (get_campaign_comparison,
// get_conversion_rate, detect_anomalies) rather than re-querying. The other
// three (uncontacted_high_volume, overdue_followups, pipeline_risk) have no
// existing CRM/analytics tool of this exact shape, so they run their own
// direct, company-wide-only queries here.
//
// Every rule's DECISION (does this number cross the threshold?) and every
// alert's WORDING live in src/domain/insightRules.ts, pure and independently
// tested - this file's job is only to gather the numbers and call those pure
// functions, never to embed a threshold or a message string inline.

import { and, eq, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { leadFollowUps, leads } from "../../infrastructure/db/schema";
import { companyStages, type CrmAuthContext } from "../metaSync/crmTools";
import { detect_anomalies, get_campaign_comparison, get_conversion_rate } from "../metaSync/analyticsTools";
import { lastNDaysRange, weekRange } from "../metaSync/rutaDateRange";
import {
  ANOMALY_Z_THRESHOLD,
  CONVERSION_RATE_DROP_POINTS_THRESHOLD,
  OVERDUE_FOLLOWUPS_THRESHOLD,
  PIPELINE_STALE_DAYS,
  UNCONTACTED_HIGH_VOLUME_THRESHOLD,
  UNCONTACTED_STALE_HOURS,
  buildAnomalyMessage,
  buildCampaignChangeMessage,
  buildConversionRateDropMessage,
  buildOverdueFollowupsMessage,
  buildPipelineRiskMessage,
  buildUncontactedHighVolumeMessage,
  severityForKind,
  shouldFireConversionRateDrop,
  shouldFireOverdueFollowups,
  shouldFireUncontactedHighVolume,
  significantPipelineRisks,
  significantVolumeChanges,
  type InsightKind,
  type InsightSeverity,
} from "../../domain/insightRules";

/**
 * Placeholder userId for calls into crmTools.ts/analyticsTools.ts's UNGATED
 * (company-wide, no broad-query-grant check) functions - CrmAuthContext
 * requires a userId, but none of the ungated functions this file calls
 * (get_campaign_comparison, get_conversion_rate, detect_anomalies) ever
 * READ it; their queries filter by auth.tenantId only. NEVER pass this into
 * a GATED tool (get_pipeline_summary/get_user_leads/get_team_performance) -
 * those branch on a real hasBroadGrant(tenantId, userId) DB lookup, which
 * would silently resolve "no role found" -> false -> an incorrect personal-
 * scope fallback for a userId that doesn't exist.
 */
const SYSTEM_INSIGHT_USER_ID = "system-insight-scan";

function systemAuth(tenantId: string): CrmAuthContext {
  return { tenantId, userId: SYSTEM_INSIGHT_USER_ID };
}

export interface DetectedInsight {
  kind: InsightKind;
  severity: InsightSeverity;
  dedupeKey: string;
  title: string;
  message: string;
  metrics: Record<string, unknown>;
  windowStart?: Date;
  windowEnd?: Date;
}

/** Runs every rule for exactly ONE tenant, explicit and required - see this
 * file's own header. Each rule is wrapped so one rule's failure (a bad
 * query, a transient DB error) never prevents the others from still
 * running - same "one failure never blocks the rest" posture as
 * get_campaign_performance's per-ad resilience elsewhere in this codebase. */
export async function scanTenantForInsights(tenantId: string, timezone: string): Promise<DetectedInsight[]> {
  const results = await Promise.allSettled([
    detectUncontactedHighVolume(tenantId),
    detectOverdueFollowups(tenantId),
    detectCampaignPerformanceChanges(tenantId, timezone),
    detectConversionRateDrop(tenantId, timezone),
    detectPipelineRisk(tenantId, timezone),
    detectLeadVolumeAnomaly(tenantId, timezone),
  ]);

  const insights: DetectedInsight[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") insights.push(...result.value);
    else console.error(`[insight-detection] A rule failed for tenant ${tenantId}:`, result.reason);
  }
  return insights;
}

// ---------------------------------------------------------------------------
// uncontacted_high_volume - leads in the tenant's own INITIAL stage, zero
// follow-ups logged, older than UNCONTACTED_STALE_HOURS. Dedupe: once per
// calendar day (company timezone) while the condition holds.
// ---------------------------------------------------------------------------

async function detectUncontactedHighVolume(tenantId: string): Promise<DetectedInsight[]> {
  const stages = await companyStages(tenantId);
  const initialStageKey = stages.find((s) => s.isInitial)?.key ?? "new";
  const cutoff = new Date(Date.now() - UNCONTACTED_STALE_HOURS * 60 * 60 * 1000);

  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .leftJoin(leadFollowUps, eq(leadFollowUps.leadId, leads.id))
    .where(and(eq(leads.companyId, tenantId), eq(leads.pipelineStage, initialStageKey), lt(leads.metaCreatedAt, cutoff), isNull(leadFollowUps.id)));
  const count = row?.n ?? 0;
  if (!shouldFireUncontactedHighVolume(count)) return [];

  const dayKey = new Date().toISOString().slice(0, 10);
  return [
    {
      kind: "uncontacted_high_volume",
      severity: severityForKind("uncontacted_high_volume"),
      dedupeKey: `uncontacted_high_volume:${dayKey}`,
      title: "Uncontacted high-volume leads",
      message: buildUncontactedHighVolumeMessage(count),
      metrics: { count, staleHours: UNCONTACTED_STALE_HOURS, initialStage: initialStageKey },
    },
  ];
}

// ---------------------------------------------------------------------------
// overdue_followups - company-wide count of leads due/overdue right now
// (same "pending" definition as crmTools.ts's get_followup_summary, just
// unconditionally company-wide here). Dedupe: once per calendar day.
// ---------------------------------------------------------------------------

async function detectOverdueFollowups(tenantId: string): Promise<DetectedInsight[]> {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(leads)
    .where(and(eq(leads.companyId, tenantId), isNotNull(leads.nextFollowUpAt), lte(leads.nextFollowUpAt, new Date())));
  const count = row?.n ?? 0;
  if (!shouldFireOverdueFollowups(count)) return [];

  const dayKey = new Date().toISOString().slice(0, 10);
  return [
    {
      kind: "overdue_followups",
      severity: severityForKind("overdue_followups"),
      dedupeKey: `overdue_followups:${dayKey}`,
      title: "Overdue follow-ups",
      message: buildOverdueFollowupsMessage(count),
      metrics: { count, threshold: OVERDUE_FOLLOWUPS_THRESHOLD },
    },
  ];
}

// ---------------------------------------------------------------------------
// campaign_performance_change - this week vs. the previous equivalent week,
// reusing analyticsTools.ts's get_campaign_comparison directly. One insight
// per significantly-shifted campaign. Dedupe: per campaign, per week.
// ---------------------------------------------------------------------------

async function detectCampaignPerformanceChanges(tenantId: string, timezone: string): Promise<DetectedInsight[]> {
  const range = weekRange(timezone, 0);
  const comparison = await get_campaign_comparison(systemAuth(tenantId), { range });
  const significant = significantVolumeChanges(comparison.rows);

  return significant.map((change) => ({
    kind: "campaign_performance_change" as const,
    severity: severityForKind("campaign_performance_change"),
    dedupeKey: `campaign_performance_change:${change.name}:${comparison.range.startIso}`,
    title: "Sudden campaign performance change",
    message: buildCampaignChangeMessage("Campaign", change),
    metrics: { ...change, range: comparison.range, previousRange: comparison.previousRange },
    windowStart: range.start,
    windowEnd: range.end,
  }));
}

// ---------------------------------------------------------------------------
// conversion_rate_drop - this week vs. the previous equivalent week,
// reusing analyticsTools.ts's get_conversion_rate directly (called twice,
// same as get_trend does internally). Dedupe: per week.
// ---------------------------------------------------------------------------

async function detectConversionRateDrop(tenantId: string, timezone: string): Promise<DetectedInsight[]> {
  const range = weekRange(timezone, 0);
  const previousRange = weekRange(timezone, 1);
  const [current, previous] = await Promise.all([
    get_conversion_rate(systemAuth(tenantId), { range }),
    get_conversion_rate(systemAuth(tenantId), { range: previousRange }),
  ]);

  if (!shouldFireConversionRateDrop(current.conversionRatePct, previous.conversionRatePct, current.totalCount)) return [];

  return [
    {
      kind: "conversion_rate_drop",
      severity: severityForKind("conversion_rate_drop"),
      dedupeKey: `conversion_rate_drop:${current.range.startIso}`,
      title: "Conversion-rate drop",
      message: buildConversionRateDropMessage(current.conversionRatePct, previous.conversionRatePct),
      metrics: { current, previous, pointsThreshold: CONVERSION_RATE_DROP_POINTS_THRESHOLD },
      windowStart: range.start,
      windowEnd: range.end,
    },
  ];
}

// ---------------------------------------------------------------------------
// pipeline_risk - leads in a NON-closed stage whose most recent activity
// (last follow-up, or metaCreatedAt if none) is older than
// PIPELINE_STALE_DAYS. Grouped by stage in SQL; closed-stage filtering and
// the significance threshold both happen in JS against the tenant's own
// stage catalog - same "group in SQL, decide in JS against companyStages()"
// convention crmTools.ts's get_pipeline_summary/get_campaign_performance
// already use. Dedupe: per stage, per week.
// ---------------------------------------------------------------------------

async function detectPipelineRisk(tenantId: string, timezone: string): Promise<DetectedInsight[]> {
  const stages = await companyStages(tenantId);
  const staleCutoff = new Date(Date.now() - PIPELINE_STALE_DAYS * 24 * 60 * 60 * 1000);

  const db = await getDb();
  // A derived-table subquery (not a CTE) - the simpler, more broadly
  // compatible drizzle pattern for "join against a per-group aggregate".
  const lastActivity = db
    .select({ leadId: leadFollowUps.leadId, lastAt: sql<Date>`max(${leadFollowUps.createdAt})`.as("last_at") })
    .from(leadFollowUps)
    .groupBy(leadFollowUps.leadId)
    .as("last_activity");
  const rows = await db
    .select({ stage: leads.pipelineStage, n: sql<number>`count(*)::int` })
    .from(leads)
    .leftJoin(lastActivity, eq(lastActivity.leadId, leads.id))
    .where(and(eq(leads.companyId, tenantId), sql`coalesce(${lastActivity.lastAt}, ${leads.metaCreatedAt}) < ${staleCutoff}`))
    .groupBy(leads.pipelineStage);

  const stageByKey = new Map(stages.map((s) => [s.key, s]));
  const stalledRows = rows
    .filter((r) => !(stageByKey.get(r.stage)?.isClosed ?? false)) // never flag a closed/won/lost stage as "at risk"
    .map((r) => ({ stageKey: r.stage, stageLabel: stageByKey.get(r.stage)?.label ?? r.stage, stalledCount: Number(r.n) }));

  const significant = significantPipelineRisks(stalledRows);
  const weekKey = weekRange(timezone, 0).start.toISOString(); // dedupe bucket only - re-fires once per company week while still stalled

  return significant.map((stage) => ({
    kind: "pipeline_risk" as const,
    severity: severityForKind("pipeline_risk"),
    dedupeKey: `pipeline_risk:${stage.stageKey}:${weekKey}`,
    title: "Pipeline risk",
    message: buildPipelineRiskMessage(stage),
    metrics: { ...stage, staleDays: PIPELINE_STALE_DAYS },
  }));
}

// ---------------------------------------------------------------------------
// lead_volume_anomaly - reuses analyticsTools.ts's detect_anomalies over a
// trailing 14-day window. One insight per anomalous day. Dedupe: per day.
// ---------------------------------------------------------------------------

async function detectLeadVolumeAnomaly(tenantId: string, timezone: string): Promise<DetectedInsight[]> {
  const range = lastNDaysRange(timezone, 14);
  const result = await detect_anomalies(systemAuth(tenantId), { range, timezone });

  return result.anomalies
    .filter((a: (typeof result.anomalies)[number]) => Math.abs(a.zScore) >= ANOMALY_Z_THRESHOLD)
    .map((a: (typeof result.anomalies)[number]) => ({
      kind: "lead_volume_anomaly" as const,
      severity: severityForKind("lead_volume_anomaly"),
      dedupeKey: `lead_volume_anomaly:${a.startIso}`,
      title: "Unusual lead-volume change",
      message: buildAnomalyMessage(a.label, a.kind, a.count),
      metrics: { ...a, windowRange: result.range },
      windowStart: new Date(a.startIso),
      windowEnd: new Date(a.endIso),
    }));
}
