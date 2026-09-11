// RUTA Insight/Alert Engine - notification PREFERENCES, FREQUENCY CONTROL,
// and QUIET HOURS. A tenant/user with no row in ruta_notification_preferences
// gets DEFAULT_PREFERENCES below - a row only gets created once someone
// actually changes something, via a WhatsApp command (see rutaTools.ts's
// "mute alerts" / "unmute alerts" / "alert settings" tools, which are the
// v1 control surface for this - consistent with the rest of this feature
// being WhatsApp-first rather than requiring a separate settings UI/API).

import { and, eq, gte } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { rutaNotificationPreferences, rutaNotificationQueue } from "../../infrastructure/db/schema";

export interface NotificationPreferences {
  enabled: boolean;
  maxPerDay: number;
  quietHoursStartMinute: number | null;
  quietHoursEndMinute: number | null;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: true,
  maxPerDay: 5,
  // 10pm-8am, company-local time - a sensible default "don't buzz someone's
  // phone at 2am" quiet window. Overridable per user via the WhatsApp
  // "quiet hours" command; either field can be cleared independently to
  // turn quiet hours off entirely (both null).
  quietHoursStartMinute: 22 * 60,
  quietHoursEndMinute: 8 * 60,
};

export async function getPreferences(tenantId: string, userId: string): Promise<NotificationPreferences> {
  const db = await getDb();
  const [row] = await db
    .select({
      enabled: rutaNotificationPreferences.enabled,
      maxPerDay: rutaNotificationPreferences.maxPerDay,
      quietHoursStartMinute: rutaNotificationPreferences.quietHoursStartMinute,
      quietHoursEndMinute: rutaNotificationPreferences.quietHoursEndMinute,
    })
    .from(rutaNotificationPreferences)
    .where(and(eq(rutaNotificationPreferences.tenantId, tenantId), eq(rutaNotificationPreferences.userId, userId)))
    .limit(1);
  return row ?? DEFAULT_PREFERENCES;
}

/** Upserts a partial preference change - e.g. {enabled:false} for "mute
 * alerts". Creates the row on first use (see this file's own header). */
export async function updatePreferences(tenantId: string, userId: string, patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> {
  const db = await getDb();
  const current = await getPreferences(tenantId, userId);
  const merged = { ...current, ...patch };
  await db
    .insert(rutaNotificationPreferences)
    .values({ tenantId, userId, ...merged, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [rutaNotificationPreferences.tenantId, rutaNotificationPreferences.userId],
      set: { ...merged, updatedAt: new Date() },
    });
  return merged;
}

// ---------------------------------------------------------------------------
// Quiet hours - pure time-of-day math against a timezone. Mirrors the
// "Intl.DateTimeFormat offset trick" documented at length in
// rutaDateRange.ts's own file header (a separate, self-contained copy here
// rather than exporting that module's internals - different granularity,
// minute-of-day rather than calendar-day). Like the rest of this codebase's
// timezone handling, this derives the offset from a single reference
// instant rather than per-day, which is exact for fixed-offset zones (e.g.
// Asia/Kolkata, this codebase's primary target) and correct to within an
// hour around a DST transition for zones that observe one - an acceptable
// approximation for a "don't buzz someone's phone at night" feature, not a
// billing-critical calculation.
// ---------------------------------------------------------------------------

function minuteOfDayInTimezone(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

function timezoneOffsetMinutes(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asIfUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asIfUtc - instant.getTime()) / 60_000);
}

/** True if `instant` falls inside [startMinute, endMinute) local time -
 * handles a window that wraps past midnight (startMinute > endMinute, e.g.
 * 22:00-08:00) the same way a plain clock would. */
export function isWithinQuietHours(instant: Date, timezone: string, prefs: NotificationPreferences): boolean {
  if (prefs.quietHoursStartMinute === null || prefs.quietHoursEndMinute === null) return false;
  const minute = minuteOfDayInTimezone(instant, timezone);
  const { quietHoursStartMinute: start, quietHoursEndMinute: end } = prefs;
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

/** When `instant` is inside quiet hours, returns the instant quiet hours
 * next end (today's or tomorrow's occurrence of quietHoursEndMinute,
 * whichever is still ahead) - the time a delayed alert should actually be
 * delivered. Callers should only invoke this after confirming
 * isWithinQuietHours(instant, ...) is true. */
export function nextEligibleInstant(instant: Date, timezone: string, prefs: NotificationPreferences): Date {
  if (prefs.quietHoursStartMinute === null || prefs.quietHoursEndMinute === null) return instant;
  const offset = timezoneOffsetMinutes(instant, timezone);
  const localParts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant);
  const get = (type: string) => Number(localParts.find((p) => p.type === type)?.value ?? 0);
  const todayLocalMidnightUtcMs = Date.UTC(get("year"), get("month") - 1, get("day")) - offset * 60_000;
  const todayEndMs = todayLocalMidnightUtcMs + prefs.quietHoursEndMinute * 60_000;
  const tomorrowEndMs = todayEndMs + 24 * 60 * 60_000;
  return new Date(todayEndMs > instant.getTime() ? todayEndMs : tomorrowEndMs);
}

// ---------------------------------------------------------------------------
// Frequency control - a rolling 24-hour count of SENT notifications for
// this user (not "today" in company-local time - a rolling window is
// simpler to reason about and doesn't reset all at once at local midnight,
// which would let a burst happen right at the boundary).
// ---------------------------------------------------------------------------

export async function countSentInLast24h(tenantId: string, userId: string): Promise<number> {
  const db = await getDb();
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ id: rutaNotificationQueue.id })
    .from(rutaNotificationQueue)
    .where(and(eq(rutaNotificationQueue.tenantId, tenantId), eq(rutaNotificationQueue.userId, userId), eq(rutaNotificationQueue.status, "sent"), gte(rutaNotificationQueue.deliveredAt, since)));
  return rows.length;
}

export async function isUnderFrequencyCap(tenantId: string, userId: string, prefs: NotificationPreferences): Promise<boolean> {
  const sentCount = await countSentInLast24h(tenantId, userId);
  return sentCount < prefs.maxPerDay;
}
