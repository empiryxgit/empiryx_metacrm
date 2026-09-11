// Pure unit tests for rutaTools.ts's matchPattern - the fast, regex-only
// classification tier (no DB, no AI provider, no DATABASE_URL required).
// Covers both the pre-existing phrasings (kept byte-for-byte backward
// compatible) and the new natural-language query categories.

import { describe, expect, it } from "vitest";
import { matchPattern } from "./rutaTools";

describe("matchPattern - backward-compatible phrasings", () => {
  it("help", () => {
    expect(matchPattern("help")).toEqual({ name: "help", arguments: {} });
  });

  it("update on <name>", () => {
    expect(matchPattern("update on Rohan Shah")).toEqual({ name: "updateOnX", arguments: { query: "Rohan Shah" } });
  });

  it("my leads today (personal list) takes priority over the generic count rule", () => {
    expect(matchPattern("my leads today")).toEqual({ name: "myLeadsToday", arguments: {} });
  });

  it("pending follow-ups", () => {
    expect(matchPattern("pending follow-ups")).toEqual({ name: "pendingFollowUps", arguments: {} });
    expect(matchPattern("pending")).toEqual({ name: "pendingFollowUps", arguments: {} });
  });

  it("how many follow ups today", () => {
    expect(matchPattern("how many follow ups today")).toEqual({ name: "followUpsToday", arguments: {} });
    expect(matchPattern("follow ups today")).toEqual({ name: "followUpsToday", arguments: {} });
  });

  it("unrecognized text returns null", () => {
    expect(matchPattern("what is the weather today")).toBeNull();
    expect(matchPattern("")).toBeNull();
  });
});

describe("matchPattern - new natural-language query categories", () => {
  it("plain and dated lead-count questions route to leadCount", () => {
    expect(matchPattern("how many leads today")).toEqual({ name: "leadCount", arguments: { query: "how many leads today" } });
    expect(matchPattern("leads")).toEqual({ name: "leadCount", arguments: { query: "leads" } });
    expect(matchPattern("how many leads yesterday")).toEqual({ name: "leadCount", arguments: { query: "how many leads yesterday" } });
    expect(matchPattern("leads between 1 aug and 10 aug")).toEqual({ name: "leadCount", arguments: { query: "leads between 1 aug and 10 aug" } });
  });

  it("campaign breakdown - matches even without the word 'lead'", () => {
    expect(matchPattern("Which campaign gave the most?")).toEqual({ name: "campaignLeadCounts", arguments: { query: "Which campaign gave the most?" } });
  });

  it("campaign performance / conversion rate routes to campaignPerformance, checked before the bare campaign-breakdown rule", () => {
    expect(matchPattern("campaign performance")).toEqual({ name: "campaignPerformance", arguments: { query: "campaign performance" } });
    expect(matchPattern("what's our conversion rate")).toEqual({ name: "campaignPerformance", arguments: { query: "what's our conversion rate" } });
    expect(matchPattern("conversion rate by campaign")).toEqual({ name: "campaignPerformance", arguments: { query: "conversion rate by campaign" } });
  });

  it("source breakdown", () => {
    expect(matchPattern("leads by source")).toEqual({ name: "sourceLeadCounts", arguments: { query: "leads by source" } });
    expect(matchPattern("which source is best")).toEqual({ name: "sourceLeadCounts", arguments: { query: "which source is best" } });
  });

  it("user/team breakdown", () => {
    expect(matchPattern("leads by teammate")).toEqual({ name: "userLeadCounts", arguments: { query: "leads by teammate" } });
    expect(matchPattern("show me by salesperson")).toEqual({ name: "userLeadCounts", arguments: { query: "show me by salesperson" } });
  });

  it("pipeline summary", () => {
    expect(matchPattern("pipeline summary")).toEqual({ name: "pipelineSummary", arguments: {} });
    expect(matchPattern("pipeline")).toEqual({ name: "pipelineSummary", arguments: {} });
  });

  it("lead status", () => {
    expect(matchPattern("what's the status of our leads")).toEqual({ name: "leadStatus", arguments: { query: "what's the status of our leads" } });
    expect(matchPattern("how many leads are qualified")).toEqual({ name: "leadStatus", arguments: { query: "how many leads are qualified" } });
  });

  it("generalized follow-up counts (a date range other than 'today')", () => {
    expect(matchPattern("follow ups this week")).toEqual({ name: "followUpCount", arguments: { query: "follow ups this week" } });
    expect(matchPattern("follow ups yesterday")).toEqual({ name: "followUpCount", arguments: { query: "follow ups yesterday" } });
  });

  it("a bare date-only follow-up ('what about yesterday') matches nothing here - it's handled by the orchestrator's anchor re-run, not the pattern matcher", () => {
    expect(matchPattern("what about yesterday?")).toBeNull();
    expect(matchPattern("and last week?")).toBeNull();
  });
});

describe("matchPattern - analytics tools (Phase D)", () => {
  it("'why did leads decrease this week' routes to explainChange, checked before leadCount despite containing both 'lead' and a date phrase", () => {
    expect(matchPattern("Why did leads decrease this week?")).toEqual({ name: "explainChange", arguments: { query: "Why did leads decrease this week?" } });
    expect(matchPattern("why did we get fewer leads yesterday")).toEqual({ name: "explainChange", arguments: { query: "why did we get fewer leads yesterday" } });
  });

  it("trend questions route to trend", () => {
    expect(matchPattern("what's the lead trend this week")).toEqual({ name: "trend", arguments: { query: "what's the lead trend this week" } });
    expect(matchPattern("are leads trending up or down")).toEqual({ name: "trend", arguments: { query: "are leads trending up or down" } });
  });

  it("anomaly questions route to anomalies", () => {
    expect(matchPattern("any unusual days this month for leads")).toEqual({ name: "anomalies", arguments: { query: "any unusual days this month for leads" } });
    expect(matchPattern("were there any lead anomalies last week")).toEqual({ name: "anomalies", arguments: { query: "were there any lead anomalies last week" } });
  });

  it("'team performance' routes to teamPerformance, checked before both campaignPerformance's and userLeadCounts' bare rules", () => {
    expect(matchPattern("team performance this week")).toEqual({ name: "teamPerformance", arguments: { query: "team performance this week" } });
    expect(matchPattern("how's my team performing")).toEqual({ name: "teamPerformance", arguments: { query: "how's my team performing" } });
  });

  it("'compare campaigns' routes to campaignComparison, checked before campaignPerformance's and campaignLeadCounts' bare rules", () => {
    expect(matchPattern("compare campaigns this week vs last")).toEqual({ name: "campaignComparison", arguments: { query: "compare campaigns this week vs last" } });
    expect(matchPattern("campaign comparison")).toEqual({ name: "campaignComparison", arguments: { query: "campaign comparison" } });
  });

  it("'compare sources' routes to sourceComparison, checked before sourceLeadCounts' bare rule", () => {
    expect(matchPattern("compare sources this month")).toEqual({ name: "sourceComparison", arguments: { query: "compare sources this month" } });
    expect(matchPattern("source comparison")).toEqual({ name: "sourceComparison", arguments: { query: "source comparison" } });
  });

  it("'overall conversion rate' routes to conversionRate; a bare 'conversion rate' keeps its existing campaignPerformance behavior unchanged", () => {
    expect(matchPattern("what's our overall conversion rate this month")).toEqual({ name: "conversionRate", arguments: { query: "what's our overall conversion rate this month" } });
    expect(matchPattern("total conversion rate")).toEqual({ name: "conversionRate", arguments: { query: "total conversion rate" } });
    // Unchanged from before this tool existed (see campaignPerformance's own comment).
    expect(matchPattern("what's our conversion rate")).toEqual({ name: "campaignPerformance", arguments: { query: "what's our conversion rate" } });
    expect(matchPattern("overall conversion rate by campaign")).toEqual({ name: "campaignPerformance", arguments: { query: "overall conversion rate by campaign" } });
  });
});

describe("matchPattern - RUTA Insight/Alert Engine (Phase E)", () => {
  it("a bare 'why' with no 'lead' routes to explainLastInsight, distinct from explainChange's 'why' + 'lead' rule", () => {
    expect(matchPattern("Why?")).toEqual({ name: "explainLastInsight", arguments: {} });
    expect(matchPattern("why is that")).toEqual({ name: "explainLastInsight", arguments: {} });
    expect(matchPattern("why did this happen")).toEqual({ name: "explainLastInsight", arguments: {} });
    // Still routes to explainChange when "lead" is present, unchanged.
    expect(matchPattern("why did leads drop")).toEqual({ name: "explainChange", arguments: { query: "why did leads drop" } });
  });

  it("mute/unmute alert commands", () => {
    expect(matchPattern("mute alerts")).toEqual({ name: "muteAlerts", arguments: {} });
    expect(matchPattern("stop notifications")).toEqual({ name: "muteAlerts", arguments: {} });
    expect(matchPattern("turn off alerts")).toEqual({ name: "muteAlerts", arguments: {} });
    expect(matchPattern("unmute alerts")).toEqual({ name: "unmuteAlerts", arguments: {} });
    expect(matchPattern("turn on notifications")).toEqual({ name: "unmuteAlerts", arguments: {} });
    expect(matchPattern("resume alerts")).toEqual({ name: "unmuteAlerts", arguments: {} });
  });

  it("alert settings status", () => {
    expect(matchPattern("alert settings")).toEqual({ name: "alertSettings", arguments: {} });
    expect(matchPattern("notification preferences")).toEqual({ name: "alertSettings", arguments: {} });
  });
});
