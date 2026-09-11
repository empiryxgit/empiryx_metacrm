// RUTA Insight/Alert Engine - RULE DEFINITIONS. Every threshold/decision in
// this file is PURE (no DB, no network, no LLM) and independently testable
// - the same "deterministic backend, LLM only explains" law from the
// analytics engine (src/application/metaSync/analyticsTools.ts) applies one
// level up here too: a rule either fires or it doesn't, based purely on
// numbers already computed by src/application/metaSync/crmTools.ts /
// analyticsTools.ts, or by insightDetection.ts's own direct queries for the
// two shapes those don't cover (uncontacted-lead counts, stalled-pipeline
// counts). The LLM is never involved in detecting an insight or writing its
// alert text - see each insight's `message` field, always built here or in
// insightDetection.ts, never by an AI provider. The LLM's only job anywhere
// in this pipeline is answering a follow-up "Why?" (rutaTools.ts's
// explainLastInsight), by PHRASING the `metrics` payload a rule already
// computed - never calculating anything itself.

export const INSIGHT_KINDS = [
  "uncontacted_high_volume",
  "overdue_followups",
  "campaign_performance_change",
  "conversion_rate_drop",
  "pipeline_risk",
  "lead_volume_anomaly",
] as const;

export type InsightKind = (typeof INSIGHT_KINDS)[number];

export type InsightSeverity = "info" | "warning" | "critical";

// ---------------------------------------------------------------------------
// Thresholds - named constants so tuning later means editing one number,
// not hunting through detection logic. Deliberately conservative defaults
// (fewer, more meaningful alerts beats noisy over-alerting - a muted/ignored
// bot is worse than a quiet one).
// ---------------------------------------------------------------------------

/** A lead in the tenant's own INITIAL pipeline stage, with zero follow-ups
 * logged, older than this many hours counts toward "uncontacted". */
export const UNCONTACTED_STALE_HOURS = 4;
/** Company-wide uncontacted count at/above this fires the insight. */
export const UNCONTACTED_HIGH_VOLUME_THRESHOLD = 5;

/** Company-wide overdue/due-now follow-up count at/above this fires the
 * insight (same "pending" definition as crmTools.ts's get_followup_summary,
 * just company-wide/unconditional here rather than scope-branched). */
export const OVERDUE_FOLLOWUPS_THRESHOLD = 5;

/** A campaign/source's week-over-week volume change must be at least this
 * many percentage points AND both periods must clear MIN_VOLUME_FLOOR
 * below, or the change is dismissed as noise from small numbers (a
 * campaign going 1 lead -> 2 leads is technically "+100%" but meaningless). */
export const CAMPAIGN_PERFORMANCE_CHANGE_PCT_THRESHOLD = 25;
export const MIN_VOLUME_FLOOR = 5;

/** Conversion rate must drop by at least this many PERCENTAGE POINTS
 * (not percent-of-percent) vs. the previous equivalent period. */
export const CONVERSION_RATE_DROP_POINTS_THRESHOLD = 10;

/** A non-closed-stage lead with no follow-up (and no stage-entry signal
 * newer than that) for this many days counts as "stalled". */
export const PIPELINE_STALE_DAYS = 5;
/** A stage's stalled-lead count at/above this fires the insight. */
export const PIPELINE_RISK_THRESHOLD = 5;

/** Same z-score convention as analyticsTools.ts's computeAnomalies - a
 * day-bucket at/beyond this many standard deviations from the trailing
 * window's mean is anomalous. */
export const ANOMALY_Z_THRESHOLD = 2.0;

// ---------------------------------------------------------------------------
// Pure decision helpers - each takes already-computed numbers and returns
// whether/how an insight should fire. No DB access, no rounding surprises
// hidden inside a query - every number here can be unit-tested directly.
// ---------------------------------------------------------------------------

export function shouldFireUncontactedHighVolume(uncontactedCount: number): boolean {
  return uncontactedCount >= UNCONTACTED_HIGH_VOLUME_THRESHOLD;
}

export function shouldFireOverdueFollowups(overdueCount: number): boolean {
  return overdueCount >= OVERDUE_FOLLOWUPS_THRESHOLD;
}

export interface VolumeChangeSignal {
  name: string;
  currentCount: number;
  previousCount: number;
  changePct: number | null;
}

/** Filters a set of campaign/source comparison rows (analyticsTools.ts's
 * ComparisonRow[]) down to the ones whose change is both large enough AND
 * backed by real volume - see MIN_VOLUME_FLOOR's own comment. */
export function significantVolumeChanges(rows: VolumeChangeSignal[]): VolumeChangeSignal[] {
  return rows.filter(
    (r) =>
      r.changePct !== null &&
      Math.abs(r.changePct) >= CAMPAIGN_PERFORMANCE_CHANGE_PCT_THRESHOLD &&
      Math.max(r.currentCount, r.previousCount) >= MIN_VOLUME_FLOOR,
  );
}

export function shouldFireConversionRateDrop(currentRatePct: number, previousRatePct: number, currentTotalCount: number): boolean {
  if (currentTotalCount < MIN_VOLUME_FLOOR) return false; // too little volume to trust the rate at all
  return previousRatePct - currentRatePct >= CONVERSION_RATE_DROP_POINTS_THRESHOLD;
}

export interface StalledStageSignal {
  stageKey: string;
  stageLabel: string;
  stalledCount: number;
}

export function significantPipelineRisks(rows: StalledStageSignal[]): StalledStageSignal[] {
  return rows.filter((r) => r.stalledCount >= PIPELINE_RISK_THRESHOLD);
}

// ---------------------------------------------------------------------------
// Deterministic alert-text builders - the ONLY place the WhatsApp alert's
// wording comes from. Matches the spec's own example format exactly
// ("⚠️ RUTA Alert\n<one-line summary>").
// ---------------------------------------------------------------------------

export function severityForKind(kind: InsightKind): InsightSeverity {
  switch (kind) {
    case "conversion_rate_drop":
    case "lead_volume_anomaly":
      return "critical";
    case "pipeline_risk":
      return "warning";
    default:
      return "warning";
  }
}

function alertLine(summary: string): string {
  return `⚠️ RUTA Alert\n${summary}`;
}

export function buildUncontactedHighVolumeMessage(count: number): string {
  return alertLine(`${count} lead${count === 1 ? " has" : "s have"} had no contact logged within ${UNCONTACTED_STALE_HOURS} hours of coming in.`);
}

export function buildOverdueFollowupsMessage(count: number): string {
  return alertLine(`${count} follow-up${count === 1 ? " is" : "s are"} overdue or due right now, company-wide.`);
}

export function buildCampaignChangeMessage(entityLabel: string, change: VolumeChangeSignal): string {
  const direction = (change.changePct ?? 0) < 0 ? "fewer" : "more";
  const pct = Math.abs(change.changePct ?? 0);
  return alertLine(`${entityLabel} "${change.name}" generated ${pct}% ${direction} leads than its previous period (${change.currentCount} vs ${change.previousCount}).`);
}

export function buildConversionRateDropMessage(currentRatePct: number, previousRatePct: number): string {
  const pointsDropped = Math.round((previousRatePct - currentRatePct) * 10) / 10;
  return alertLine(`Conversion rate dropped ${pointsDropped} points, from ${previousRatePct}% to ${currentRatePct}%, vs the previous period.`);
}

export function buildPipelineRiskMessage(stage: StalledStageSignal): string {
  return alertLine(`${stage.stalledCount} lead${stage.stalledCount === 1 ? " is" : "s are"} stuck in "${stage.stageLabel}" with no activity for ${PIPELINE_STALE_DAYS}+ days.`);
}

export function buildAnomalyMessage(dayLabel: string, kind: "spike" | "drop", count: number): string {
  return alertLine(`Unusual lead volume on ${dayLabel}: a ${kind} to ${count} lead${count === 1 ? "" : "s"} that day.`);
}
