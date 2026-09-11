// Date-range phrase parsing for RUTA's natural-language queries ("leads
// today", "leads this week", "leads between 1 aug and 10 aug", "what about
// yesterday?"). Pure text-in/Date-out - no DB access, no tenant/user
// concept - kept separate from rutaTools.ts so both the tool bodies AND the
// orchestrator's "bare date-only follow-up" detector (rutaAiAssistant.ts)
// can share exactly the same parsing rules without importing the whole
// tools file.
//
// Every returned range is a half-open [start, end) window of real UTC
// instants, computed against the COMPANY's own timezone (never server UTC,
// never the sender's device time) - same convention as
// rutaTools.ts's todayRangeInTimezone, which this file's todayRange()
// reimplements identically on purpose (see that function's own comment for
// why the two copies must stay in lockstep). `label` is the human-facing
// phrase echoed back in a reply ("today", "this week", "between Aug 1 and
// Aug 10").

export interface DateRange {
  start: Date;
  end: Date;
  label: string;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
};
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

// ---------------------------------------------------------------------------
// Timezone-aware calendar-day <-> UTC-instant conversion. Mirrors
// rutaTools.ts's todayRangeInTimezone's own offset trick, generalized to any
// calendar date (not just "now") by re-deriving the timezone offset near
// THAT date's own local noon, rather than assuming a single fixed offset for
// every day in a range - correct even if the range happens to straddle a DST
// transition somewhere that observes one (Asia/Kolkata itself does not).
// ---------------------------------------------------------------------------

function localMidnightUtc(ymd: Ymd, timezone: string): Date {
  const noonGuess = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d, 12, 0, 0));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(noonGuess);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wallMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  const offsetMs = wallMs - noonGuess.getTime();
  const midnightGuessMs = Date.UTC(ymd.y, ymd.m - 1, ymd.d, 0, 0, 0);
  return new Date(midnightGuessMs - offsetMs);
}

function todayYmdInTimezone(timezone: string): Ymd {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

/** Pure calendar-day arithmetic (no timezone involved) - shifting a Y/M/D by
 * N days is safe to do with plain UTC Date math since we only ever read the
 * resulting Y/M/D back out, never a wall-clock time. */
function addDays(ymd: Ymd, delta: number): Ymd {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + delta));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function dayOfWeekMonday0(ymd: Ymd): number {
  // JS getUTCDay(): 0=Sun..6=Sat. Convert to 0=Mon..6=Sun.
  const dow = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
  return (dow + 6) % 7;
}

function rangeFromYmd(startYmd: Ymd, endYmdExclusive: Ymd, timezone: string, label: string): DateRange {
  return { start: localMidnightUtc(startYmd, timezone), end: localMidnightUtc(endYmdExclusive, timezone), label };
}

function formatShortDate(ymd: Ymd, currentYear: number): string {
  const monthLabel = MONTH_LABELS[ymd.m - 1] ?? "";
  return ymd.y === currentYear ? `${monthLabel} ${ymd.d}` : `${monthLabel} ${ymd.d}, ${ymd.y}`;
}

// ---------------------------------------------------------------------------
// Named ranges.
// ---------------------------------------------------------------------------

export function todayRange(timezone: string): DateRange {
  const today = todayYmdInTimezone(timezone);
  return rangeFromYmd(today, addDays(today, 1), timezone, "today");
}

export function dayOffsetRange(timezone: string, daysAgo: number): DateRange {
  const today = todayYmdInTimezone(timezone);
  const day = addDays(today, -daysAgo);
  const label = daysAgo === 0 ? "today" : daysAgo === 1 ? "yesterday" : `${daysAgo} days ago`;
  return rangeFromYmd(day, addDays(day, 1), timezone, label);
}

export function weekRange(timezone: string, weeksAgo: number): DateRange {
  const today = todayYmdInTimezone(timezone);
  const mondayThisWeek = addDays(today, -dayOfWeekMonday0(today));
  const monday = addDays(mondayThisWeek, -7 * weeksAgo);
  return rangeFromYmd(monday, addDays(monday, 7), timezone, weeksAgo === 0 ? "this week" : weeksAgo === 1 ? "last week" : `${weeksAgo} weeks ago`);
}

export function monthRange(timezone: string, monthsAgo: number): DateRange {
  const today = todayYmdInTimezone(timezone);
  let m = today.m - 1 - monthsAgo; // 0-based month index, may go negative/over 11
  let y = today.y;
  while (m < 0) {
    m += 12;
    y -= 1;
  }
  while (m > 11) {
    m -= 12;
    y += 1;
  }
  const first: Ymd = { y, m: m + 1, d: 1 };
  const nextM = m === 11 ? 0 : m + 1;
  const nextY = m === 11 ? y + 1 : y;
  const firstOfNext: Ymd = { y: nextY, m: nextM + 1, d: 1 };
  return rangeFromYmd(first, firstOfNext, timezone, monthsAgo === 0 ? "this month" : monthsAgo === 1 ? "last month" : `${MONTH_LABELS[m]} ${y}`);
}

export function lastNDaysRange(timezone: string, n: number): DateRange {
  const today = todayYmdInTimezone(timezone);
  const start = addDays(today, -(n - 1));
  return rangeFromYmd(start, addDays(today, 1), timezone, `the last ${n} days`);
}

export function singleDateRange(ymd: Ymd, timezone: string): DateRange {
  const currentYear = todayYmdInTimezone(timezone).y;
  return rangeFromYmd(ymd, addDays(ymd, 1), timezone, `on ${formatShortDate(ymd, currentYear)}`);
}

export function explicitRange(startYmd: Ymd, endYmd: Ymd, timezone: string): DateRange {
  const currentYear = todayYmdInTimezone(timezone).y;
  // endYmd is the last INCLUDED day - the stored range is exclusive of the
  // day after it, same half-open convention as every other range here.
  const [a, b] = compareYmd(startYmd, endYmd) <= 0 ? [startYmd, endYmd] : [endYmd, startYmd];
  return rangeFromYmd(a, addDays(b, 1), timezone, `between ${formatShortDate(a, currentYear)} and ${formatShortDate(b, currentYear)}`);
}

function compareYmd(a: Ymd, b: Ymd): number {
  return a.y - b.y || a.m - b.m || a.d - b.d;
}

// ---------------------------------------------------------------------------
// Explicit single-date token parsing - "3 august", "aug 3", "3rd august
// 2026", "2026-08-03", "03/08/2026" (day-first, matching this app's India
// user base). Year defaults to the current year (in the given timezone) when
// omitted.
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const SLASH_DATE_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;
const DAY_THEN_MONTH_RE = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]+)(?:\s+(\d{4}))?$/i;
const MONTH_THEN_DAY_RE = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/i;

export function tryParseExplicitDate(rawToken: string, timezone: string): Ymd | null {
  const token = rawToken.trim().toLowerCase().replace(/,/g, "");
  if (!token) return null;
  const currentYear = todayYmdInTimezone(timezone).y;

  const iso = ISO_DATE_RE.exec(token);
  if (iso) return validYmd({ y: Number(iso[1]), m: Number(iso[2]), d: Number(iso[3]) });

  const slash = SLASH_DATE_RE.exec(token);
  if (slash) {
    const d = Number(slash[1]);
    const m = Number(slash[2]);
    const yRaw = Number(slash[3]);
    const y = yRaw < 100 ? 2000 + yRaw : yRaw;
    return validYmd({ y, m, d });
  }

  const dayFirst = DAY_THEN_MONTH_RE.exec(token);
  if (dayFirst) {
    const month = MONTHS[dayFirst[2] ?? ""];
    if (month === undefined) return null;
    return validYmd({ y: dayFirst[3] ? Number(dayFirst[3]) : currentYear, m: month + 1, d: Number(dayFirst[1]) });
  }

  const monthFirst = MONTH_THEN_DAY_RE.exec(token);
  if (monthFirst) {
    const month = MONTHS[monthFirst[1] ?? ""];
    if (month === undefined) return null;
    return validYmd({ y: monthFirst[3] ? Number(monthFirst[3]) : currentYear, m: month + 1, d: Number(monthFirst[2]) });
  }

  return null;
}

function validYmd(ymd: Ymd): Ymd | null {
  if (!Number.isInteger(ymd.y) || !Number.isInteger(ymd.m) || !Number.isInteger(ymd.d)) return null;
  if (ymd.m < 1 || ymd.m > 12 || ymd.d < 1 || ymd.d > 31) return null;
  return ymd;
}

// ---------------------------------------------------------------------------
// Main dispatcher - scans free text for a recognizable date-range phrase
// ANYWHERE in the string (a tool's own query text is a full sentence, e.g.
// "how many leads did we get yesterday"). For the stricter "is this message
// NOTHING BUT a date phrase" check used by the orchestrator's follow-up
// detector, see matchBareDateFollowUp below.
// ---------------------------------------------------------------------------

export function parseDateRangePhrase(text: string, timezone: string): DateRange | null {
  const t = text.trim();
  if (!t) return null;
  const lower = t.toLowerCase();

  if (/\byesterday\b/.test(lower)) return dayOffsetRange(timezone, 1);
  if (/\btoday\b/.test(lower)) return dayOffsetRange(timezone, 0);
  if (/\bthis week\b/.test(lower)) return weekRange(timezone, 0);
  if (/\blast week\b/.test(lower)) return weekRange(timezone, 1);
  if (/\bthis month\b/.test(lower)) return monthRange(timezone, 0);
  if (/\blast month\b/.test(lower)) return monthRange(timezone, 1);

  const lastNDays = /\blast\s+(\d{1,3})\s+days?\b/.exec(lower);
  if (lastNDays && lastNDays[1]) return lastNDaysRange(timezone, Number(lastNDays[1]));

  const daysAgo = /\b(\d{1,3})\s+days?\s+ago\b/.exec(lower);
  if (daysAgo && daysAgo[1]) return dayOffsetRange(timezone, Number(daysAgo[1]));

  const between = /\b(?:between|from)\s+(.+?)\s+(?:and|to)\s+(.+?)(?:[?.!]|$)/i.exec(t);
  if (between && between[1] && between[2]) {
    const a = tryParseExplicitDate(between[1], timezone);
    const b = tryParseExplicitDate(between[2], timezone);
    if (a && b) return explicitRange(a, b, timezone);
  }

  // A single explicit date, optionally introduced by "on"/"for" - scan
  // trailing word-groups of the message (2-4 tokens) rather than requiring
  // the whole string to be a date, since callers pass full sentences like
  // "leads on 3 august" or "how many leads for aug 3".
  const cleaned = t.replace(/[?.!]+$/, "").trim();
  const tokens = cleaned.split(/\s+/);
  for (let size = Math.min(4, tokens.length); size >= 1; size--) {
    for (let start = 0; start + size <= tokens.length; start++) {
      const candidate = tokens.slice(start, start + size).join(" ");
      const ymd = tryParseExplicitDate(candidate, timezone);
      if (ymd) return singleDateRange(ymd, timezone);
    }
  }

  return null;
}

/** Lightweight "does this text contain a date-range phrase at all" check,
 * for the fast pattern matcher (rutaTools.ts's matchPattern) - deliberately
 * does NOT need a timezone, since detecting a phrase is timezone-independent
 * (only converting it to real Date instants is). */
export function containsDateRangePhrase(text: string): boolean {
  return parseDateRangePhrase(text, "UTC") !== null;
}

// ---------------------------------------------------------------------------
// Bare date-only follow-up detection - "What about yesterday?", "and last
// week?" - used by the orchestrator (rutaAiAssistant.ts) to re-run the
// conversation's anchor query with a substituted date range, matching the
// example in the natural-language-queries spec (turn 3: "What about
// yesterday?" re-runs turn 1's lead-count question, not turn 2's campaign
// breakdown). Deliberately stricter than parseDateRangePhrase: the WHOLE
// message (after stripping a short list of known lead-in words) must be
// nothing but a date phrase - "follow ups yesterday" or "which campaign
// yesterday" must NOT match here, since those are complete queries of their
// own (and would already have been handled by normal classification before
// this is ever consulted - see rutaAiAssistant.ts's handleOneMessage).
// ---------------------------------------------------------------------------

const LEAD_IN_RE = /^(?:and\s+|so\s+)?(?:what|how)\s+(?:'s|is|about)\s+|^(?:and|on|for)\s+/i;

export function matchBareDateFollowUp(text: string, timezone: string): DateRange | null {
  let t = text.trim().replace(/[?.!]+$/, "").trim();
  if (!t) return null;
  t = t.replace(LEAD_IN_RE, "").trim();
  if (!t) return null;

  const range = parseDateRangePhrase(t, timezone);
  if (!range) return null;

  // Confirm the phrase we matched accounts for (nearly) the whole remaining
  // string, not just a fragment of a longer, different question. Re-derive
  // what parseDateRangePhrase would have matched as literal text and check
  // there isn't meaningfully more to the message than that.
  const lower = t.toLowerCase();
  const KNOWN_PHRASES = [
    /\byesterday\b/, /\btoday\b/, /\bthis week\b/, /\blast week\b/, /\bthis month\b/, /\blast month\b/,
    /\blast\s+\d{1,3}\s+days?\b/, /\b\d{1,3}\s+days?\s+ago\b/,
  ];
  const matchedPhrase = KNOWN_PHRASES.find((re) => re.test(lower));
  if (matchedPhrase) {
    const remainder = lower.replace(matchedPhrase, "").trim();
    return remainder.length === 0 ? range : null;
  }
  // Otherwise the phrase must have come from the explicit-date scan
  // (single date or between/from..and..) - accept it only if the whole
  // remaining text parses as a single explicit-date token (or two, for a
  // range), i.e. there are no other stray words RIGHT next to the digits/
  // month name (a short "on"/"between"/"and"/"to"/"from" scaffold is fine).
  const scaffold = lower.replace(/\b(on|between|from|and|to)\b/g, " ").replace(/\s+/g, " ").trim();
  return tryParseExplicitDate(scaffold, timezone) ? range : null;
}
