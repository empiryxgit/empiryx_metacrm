// Pure unit tests for rutaDateRange.ts - no DB, no network, no
// DATABASE_URL required (unlike the security/*.acceptance.test.ts suites),
// so these run in every environment including this sandbox. Covers the
// parsing rules the natural-language query tools (rutaTools.ts) and the
// orchestrator's bare-date-follow-up detector (rutaAiAssistant.ts) both
// depend on.

import { describe, expect, it } from "vitest";
import { dayOffsetRange, explicitRange, matchBareDateFollowUp, monthRange, parseDateRangePhrase, singleDateRange, todayRange, tryParseExplicitDate, weekRange } from "./rutaDateRange";

const TZ = "Asia/Kolkata";

describe("todayRange / dayOffsetRange", () => {
  it("today's range is a 24h half-open window", () => {
    const r = todayRange(TZ);
    expect(r.end.getTime() - r.start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(r.label).toBe("today");
  });

  it("yesterday is exactly one day before today", () => {
    const today = todayRange(TZ);
    const yesterday = dayOffsetRange(TZ, 1);
    expect(yesterday.end.getTime()).toBe(today.start.getTime());
    expect(yesterday.start.getTime()).toBe(today.start.getTime() - 24 * 60 * 60 * 1000);
    expect(yesterday.label).toBe("yesterday");
  });
});

describe("weekRange / monthRange", () => {
  it("this week starts on Monday and spans 7 days", () => {
    const r = weekRange(TZ, 0);
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
    // The start instant, read back in the same timezone, must fall on a Monday.
    const dow = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short" }).format(r.start);
    expect(dow).toBe("Mon");
    expect(r.label).toBe("this week");
  });

  it("last week is exactly 7 days before this week", () => {
    const thisWeek = weekRange(TZ, 0);
    const lastWeek = weekRange(TZ, 1);
    expect(lastWeek.end.getTime()).toBe(thisWeek.start.getTime());
    expect(lastWeek.label).toBe("last week");
  });

  it("this month starts on the 1st", () => {
    const r = monthRange(TZ, 0);
    const day = new Intl.DateTimeFormat("en-US", { timeZone: TZ, day: "numeric" }).format(r.start);
    expect(day).toBe("1");
    expect(r.label).toBe("this month");
  });

  it("last month immediately precedes this month", () => {
    const thisMonth = monthRange(TZ, 0);
    const lastMonth = monthRange(TZ, 1);
    expect(lastMonth.end.getTime()).toBe(thisMonth.start.getTime());
  });
});

describe("tryParseExplicitDate", () => {
  it("parses ISO dates", () => {
    expect(tryParseExplicitDate("2026-08-03", TZ)).toEqual({ y: 2026, m: 8, d: 3 });
  });

  it("parses day/month/year (India convention)", () => {
    expect(tryParseExplicitDate("03/08/2026", TZ)).toEqual({ y: 2026, m: 8, d: 3 });
  });

  it("parses 'day month' and 'month day' with an ordinal suffix", () => {
    expect(tryParseExplicitDate("3 august", TZ)).toMatchObject({ m: 8, d: 3 });
    expect(tryParseExplicitDate("3rd august", TZ)).toMatchObject({ m: 8, d: 3 });
    expect(tryParseExplicitDate("aug 3", TZ)).toMatchObject({ m: 8, d: 3 });
    expect(tryParseExplicitDate("august 3rd 2026", TZ)).toEqual({ y: 2026, m: 8, d: 3 });
  });

  it("rejects garbage", () => {
    expect(tryParseExplicitDate("campaign", TZ)).toBeNull();
    expect(tryParseExplicitDate("", TZ)).toBeNull();
    expect(tryParseExplicitDate("32 august", TZ)).toBeNull();
  });
});

describe("singleDateRange / explicitRange", () => {
  it("a single date is a one-day window", () => {
    const r = singleDateRange({ y: 2026, m: 8, d: 3 }, TZ);
    expect(r.end.getTime() - r.start.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(r.label).toContain("Aug 3");
  });

  it("an explicit range is inclusive of both endpoints and order-independent", () => {
    const forward = explicitRange({ y: 2026, m: 8, d: 1 }, { y: 2026, m: 8, d: 10 }, TZ);
    const backward = explicitRange({ y: 2026, m: 8, d: 10 }, { y: 2026, m: 8, d: 1 }, TZ);
    expect(forward.start.getTime()).toBe(backward.start.getTime());
    expect(forward.end.getTime()).toBe(backward.end.getTime());
    expect(forward.end.getTime() - forward.start.getTime()).toBe(10 * 24 * 60 * 60 * 1000);
    expect(forward.label).toBe("between Aug 1 and Aug 10");
  });
});

describe("parseDateRangePhrase - full-sentence scanning", () => {
  it("finds named ranges anywhere in a sentence", () => {
    expect(parseDateRangePhrase("how many leads did we get yesterday", TZ)?.label).toBe("yesterday");
    expect(parseDateRangePhrase("leads this week please", TZ)?.label).toBe("this week");
    expect(parseDateRangePhrase("what about last month", TZ)?.label).toBe("last month");
  });

  it("finds an explicit between/and range", () => {
    const r = parseDateRangePhrase("leads between 1 aug and 10 aug", TZ);
    expect(r?.label).toBe("between Aug 1 and Aug 10");
  });

  it("finds a single explicit date embedded in a sentence", () => {
    const r = parseDateRangePhrase("how many leads on 3 august", TZ);
    expect(r?.label).toContain("Aug 3");
  });

  it("finds 'last N days'", () => {
    const r = parseDateRangePhrase("leads in the last 7 days", TZ);
    expect(r?.label).toBe("the last 7 days");
  });

  it("returns null when there is no date phrase at all", () => {
    expect(parseDateRangePhrase("which campaign gave the most", TZ)).toBeNull();
    expect(parseDateRangePhrase("", TZ)).toBeNull();
  });
});

describe("matchBareDateFollowUp - strict whole-message check", () => {
  it("matches a plain 'what about yesterday?' follow-up", () => {
    expect(matchBareDateFollowUp("What about yesterday?", TZ)?.label).toBe("yesterday");
    expect(matchBareDateFollowUp("and this week?", TZ)?.label).toBe("this week");
    expect(matchBareDateFollowUp("yesterday", TZ)?.label).toBe("yesterday");
  });

  it("matches a bare explicit date with light scaffolding", () => {
    expect(matchBareDateFollowUp("what about 3 august?", TZ)?.label).toContain("Aug 3");
    expect(matchBareDateFollowUp("on 03/08/2026", TZ)?.label).toContain("Aug 3");
  });

  it("does NOT match a message that names a different, complete query", () => {
    expect(matchBareDateFollowUp("which campaign gave the most", TZ)).toBeNull();
    expect(matchBareDateFollowUp("follow ups yesterday", TZ)).toBeNull();
    expect(matchBareDateFollowUp("leads by source", TZ)).toBeNull();
  });

  it("does NOT match empty or non-date text", () => {
    expect(matchBareDateFollowUp("", TZ)).toBeNull();
    expect(matchBareDateFollowUp("help", TZ)).toBeNull();
  });
});
