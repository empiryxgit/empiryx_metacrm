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
