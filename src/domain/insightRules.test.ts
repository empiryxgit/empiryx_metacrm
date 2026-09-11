// Pure unit tests for insightRules.ts - every threshold/decision function
// and message builder, no DB, no DATABASE_URL required. See that file's own
// header for why these are deliberately pure and independently testable.

import { describe, expect, it } from "vitest";
import {
  ANOMALY_Z_THRESHOLD,
  buildAnomalyMessage,
  buildCampaignChangeMessage,
  buildConversionRateDropMessage,
  buildOverdueFollowupsMessage,
  buildPipelineRiskMessage,
  buildUncontactedHighVolumeMessage,
  CAMPAIGN_PERFORMANCE_CHANGE_PCT_THRESHOLD,
  CONVERSION_RATE_DROP_POINTS_THRESHOLD,
  MIN_VOLUME_FLOOR,
  OVERDUE_FOLLOWUPS_THRESHOLD,
  PIPELINE_RISK_THRESHOLD,
  severityForKind,
  shouldFireConversionRateDrop,
  shouldFireOverdueFollowups,
  shouldFireUncontactedHighVolume,
  significantPipelineRisks,
  significantVolumeChanges,
  UNCONTACTED_HIGH_VOLUME_THRESHOLD,
} from "./insightRules";

describe("shouldFireUncontactedHighVolume", () => {
  it("fires at or above the threshold, not below it", () => {
    expect(shouldFireUncontactedHighVolume(UNCONTACTED_HIGH_VOLUME_THRESHOLD - 1)).toBe(false);
    expect(shouldFireUncontactedHighVolume(UNCONTACTED_HIGH_VOLUME_THRESHOLD)).toBe(true);
    expect(shouldFireUncontactedHighVolume(UNCONTACTED_HIGH_VOLUME_THRESHOLD + 10)).toBe(true);
  });
});

describe("shouldFireOverdueFollowups", () => {
  it("fires at or above the threshold, not below it", () => {
    expect(shouldFireOverdueFollowups(OVERDUE_FOLLOWUPS_THRESHOLD - 1)).toBe(false);
    expect(shouldFireOverdueFollowups(OVERDUE_FOLLOWUPS_THRESHOLD)).toBe(true);
  });
});

describe("significantVolumeChanges", () => {
  const row = (overrides: Partial<{ name: string; currentCount: number; previousCount: number; changePct: number | null }> = {}) => ({
    name: "Campaign X",
    currentCount: 10,
    previousCount: 20,
    changePct: -50,
    ...overrides,
  });

  it("keeps a row whose change clears both the percentage threshold and the volume floor", () => {
    const rows = [row({ currentCount: 10, previousCount: 20, changePct: -50 })];
    expect(significantVolumeChanges(rows)).toEqual(rows);
  });

  it("drops a row below the percentage threshold", () => {
    const rows = [row({ changePct: -(CAMPAIGN_PERFORMANCE_CHANGE_PCT_THRESHOLD - 1) })];
    expect(significantVolumeChanges(rows)).toEqual([]);
  });

  it("drops a row that clears the percentage threshold but not the volume floor (small-numbers noise)", () => {
    const rows = [row({ currentCount: 2, previousCount: 1, changePct: 100 })];
    expect(significantVolumeChanges(rows)).toEqual([]);
  });

  it("keeps a row at exactly the volume floor via the larger of the two counts", () => {
    const rows = [row({ currentCount: MIN_VOLUME_FLOOR, previousCount: 1, changePct: 100 })];
    expect(significantVolumeChanges(rows)).toEqual(rows);
  });

  it("drops a row with a null changePct (previous period had zero volume - undefined percentage)", () => {
    const rows = [row({ changePct: null })];
    expect(significantVolumeChanges(rows)).toEqual([]);
  });
});

describe("shouldFireConversionRateDrop", () => {
  it("fires when the drop clears the points threshold and current volume clears the floor", () => {
    expect(shouldFireConversionRateDrop(30, 30 + CONVERSION_RATE_DROP_POINTS_THRESHOLD, MIN_VOLUME_FLOOR)).toBe(true);
  });

  it("does not fire when the drop is below the points threshold", () => {
    expect(shouldFireConversionRateDrop(30, 30 + CONVERSION_RATE_DROP_POINTS_THRESHOLD - 1, MIN_VOLUME_FLOOR)).toBe(false);
  });

  it("does not fire when current volume is below the floor, even with a huge drop", () => {
    expect(shouldFireConversionRateDrop(0, 100, MIN_VOLUME_FLOOR - 1)).toBe(false);
  });

  it("does not fire when the rate improved (negative drop)", () => {
    expect(shouldFireConversionRateDrop(50, 30, MIN_VOLUME_FLOOR)).toBe(false);
  });
});

describe("significantPipelineRisks", () => {
  it("keeps stages at or above the threshold, drops those below it", () => {
    const rows = [
      { stageKey: "qualified", stageLabel: "Qualified", stalledCount: PIPELINE_RISK_THRESHOLD },
      { stageKey: "contacted", stageLabel: "Contacted", stalledCount: PIPELINE_RISK_THRESHOLD - 1 },
    ];
    expect(significantPipelineRisks(rows)).toEqual([rows[0]]);
  });
});

describe("severityForKind", () => {
  it("marks conversion_rate_drop and lead_volume_anomaly as critical, everything else as warning", () => {
    expect(severityForKind("conversion_rate_drop")).toBe("critical");
    expect(severityForKind("lead_volume_anomaly")).toBe("critical");
    expect(severityForKind("uncontacted_high_volume")).toBe("warning");
    expect(severityForKind("overdue_followups")).toBe("warning");
    expect(severityForKind("campaign_performance_change")).toBe("warning");
    expect(severityForKind("pipeline_risk")).toBe("warning");
  });
});

describe("deterministic alert-text builders", () => {
  it("every builder prefixes the '⚠️ RUTA Alert' header exactly as the spec's own example", () => {
    expect(buildUncontactedHighVolumeMessage(5)).toMatch(/^⚠️ RUTA Alert\n/);
    expect(buildOverdueFollowupsMessage(5)).toMatch(/^⚠️ RUTA Alert\n/);
    expect(buildCampaignChangeMessage("Campaign", { name: "X", currentCount: 5, previousCount: 8, changePct: -38 })).toMatch(/^⚠️ RUTA Alert\n/);
    expect(buildConversionRateDropMessage(20, 35)).toMatch(/^⚠️ RUTA Alert\n/);
    expect(buildPipelineRiskMessage({ stageKey: "qualified", stageLabel: "Qualified", stalledCount: 6 })).toMatch(/^⚠️ RUTA Alert\n/);
    expect(buildAnomalyMessage("Mon 1 Sep", "drop", 2)).toMatch(/^⚠️ RUTA Alert\n/);
  });

  it("buildCampaignChangeMessage matches the spec's own worked example almost verbatim", () => {
    const text = buildCampaignChangeMessage("Campaign", { name: "X", currentCount: 5, previousCount: 8, changePct: -38 });
    expect(text).toContain('Campaign "X" generated 38% fewer leads than its previous period (5 vs 8).');
  });

  it("buildConversionRateDropMessage reports the points dropped, not a percent-of-percent", () => {
    const text = buildConversionRateDropMessage(20, 35);
    expect(text).toContain("dropped 15 points");
    expect(text).toContain("from 35% to 20%");
  });

  it("singular/plural phrasing", () => {
    expect(buildUncontactedHighVolumeMessage(1)).toContain("1 lead has had no contact");
    expect(buildUncontactedHighVolumeMessage(2)).toContain("2 leads have had no contact");
    expect(buildOverdueFollowupsMessage(1)).toContain("1 follow-up is overdue");
    expect(buildOverdueFollowupsMessage(2)).toContain("2 follow-ups are overdue");
  });
});

describe("ANOMALY_Z_THRESHOLD", () => {
  it("is a positive number consistent with analyticsTools.ts's own anomaly convention", () => {
    expect(ANOMALY_Z_THRESHOLD).toBeGreaterThan(0);
  });
});
