// notificationPreferences.ts - pure quiet-hours/timezone math (no DB) plus
// DB-backed default/upsert/frequency-cap behavior (real Postgres,
// describe.skipIf(!process.env.DATABASE_URL)). Local fixture helpers mirror
// analyticsTools.test.ts/crmTools.test.ts's own convention.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../infrastructure/db/client";
import { companies, roles, rutaNotificationQueue, users } from "../../infrastructure/db/schema";
import {
  DEFAULT_PREFERENCES,
  countSentInLast24h,
  getPreferences,
  isUnderFrequencyCap,
  isWithinQuietHours,
  nextEligibleInstant,
  updatePreferences,
  type NotificationPreferences,
} from "./notificationPreferences";

const TZ = "Asia/Kolkata"; // UTC+5:30, fixed offset - no DST to worry about

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

// ---------------------------------------------------------------------------
// Pure quiet-hours math - no DB.
// ---------------------------------------------------------------------------

function prefsWithQuietHours(startMinute: number | null, endMinute: number | null): NotificationPreferences {
  return { enabled: true, maxPerDay: 5, quietHoursStartMinute: startMinute, quietHoursEndMinute: endMinute };
}

describe("isWithinQuietHours - pure math", () => {
  it("always false when either bound is null (quiet hours off)", () => {
    const noon = new Date("2026-06-15T06:30:00.000Z"); // 12:00 IST
    expect(isWithinQuietHours(noon, TZ, prefsWithQuietHours(null, 8 * 60))).toBe(false);
    expect(isWithinQuietHours(noon, TZ, prefsWithQuietHours(22 * 60, null))).toBe(false);
  });

  it("a non-wrapping window (e.g. 9am-5pm) is a plain half-open range", () => {
    const prefs = prefsWithQuietHours(9 * 60, 17 * 60);
    const at10am = new Date("2026-06-15T04:30:00.000Z"); // 10:00 IST
    const at5pmExactly = new Date("2026-06-15T11:30:00.000Z"); // 17:00 IST - end is exclusive
    const at8am = new Date("2026-06-15T02:30:00.000Z"); // 08:00 IST
    expect(isWithinQuietHours(at10am, TZ, prefs)).toBe(true);
    expect(isWithinQuietHours(at5pmExactly, TZ, prefs)).toBe(false);
    expect(isWithinQuietHours(at8am, TZ, prefs)).toBe(false);
  });

  it("a midnight-wrapping window (22:00-08:00, the default) behaves like a real clock", () => {
    const prefs = prefsWithQuietHours(22 * 60, 8 * 60);
    const at11pm = new Date("2026-06-15T17:30:00.000Z"); // 23:00 IST
    const at2am = new Date("2026-06-15T20:30:00.000Z"); // 02:00 IST (next day)
    const atNoon = new Date("2026-06-15T06:30:00.000Z"); // 12:00 IST
    const atExactly8am = new Date("2026-06-15T02:30:00.000Z"); // 08:00 IST - end is exclusive
    const atExactly10pm = new Date("2026-06-15T16:30:00.000Z"); // 22:00 IST - start is inclusive
    expect(isWithinQuietHours(at11pm, TZ, prefs)).toBe(true);
    expect(isWithinQuietHours(at2am, TZ, prefs)).toBe(true);
    expect(isWithinQuietHours(atNoon, TZ, prefs)).toBe(false);
    expect(isWithinQuietHours(atExactly8am, TZ, prefs)).toBe(false);
    expect(isWithinQuietHours(atExactly10pm, TZ, prefs)).toBe(true);
  });
});

describe("nextEligibleInstant - pure math", () => {
  it("resolves to TODAY's end-of-quiet-hours when that's still ahead", () => {
    const prefs = prefsWithQuietHours(22 * 60, 8 * 60);
    const at11pm = new Date("2026-06-15T17:30:00.000Z"); // 23:00 IST, 15 June
    const next = nextEligibleInstant(at11pm, TZ, prefs);
    // 08:00 IST on 16 June = 02:30 UTC on 16 June
    expect(next.toISOString()).toBe("2026-06-16T02:30:00.000Z");
  });

  it("resolves to TOMORROW's end-of-quiet-hours when today's has already passed", () => {
    const prefs = prefsWithQuietHours(22 * 60, 8 * 60);
    const at2am = new Date("2026-06-15T20:30:00.000Z"); // 02:00 IST, 16 June (today's 08:00 boundary already passed for this "today")
    const next = nextEligibleInstant(at2am, TZ, prefs);
    expect(next.getTime()).toBeGreaterThan(at2am.getTime());
    // Must land on an 08:00 IST boundary either way.
    const istHour = new Date(next.getTime() + 5.5 * 60 * 60 * 1000).getUTCHours();
    expect(istHour).toBe(8);
  });

  it("returns the instant unchanged when quiet hours are off", () => {
    const now = new Date();
    expect(nextEligibleInstant(now, TZ, prefsWithQuietHours(null, null))).toBe(now);
  });
});

// ---------------------------------------------------------------------------
// DB-backed behavior - real Postgres.
// ---------------------------------------------------------------------------

async function makeTenant(label: string): Promise<string> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Prefs ${label}`, slug: unique(`np-${label}`), accountType: "individual", timezone: TZ }).returning();
  return company!.id;
}

async function makeUser(tenantId: string, label: string): Promise<string> {
  const db = await getDb();
  const [role] = await db.insert(roles).values({ companyId: tenantId, name: unique("Role"), permissions: [], isSystem: true }).returning();
  const [user] = await db.insert(users).values({ companyId: tenantId, roleId: role!.id, email: `${unique(label)}@example.com`, passwordHash: "x", fullName: label }).returning();
  return user!.id;
}

async function makeInsight(tenantId: string): Promise<string> {
  const db = await getDb();
  const { rutaInsights } = await import("../../infrastructure/db/schema");
  const [row] = await db
    .insert(rutaInsights)
    .values({ tenantId, kind: "overdue_followups", severity: "warning", dedupeKey: unique("dk"), title: "t", message: "m", metrics: {} })
    .returning();
  return row!.id;
}

async function insertSentNotification(tenantId: string, userId: string, deliveredAt: Date): Promise<void> {
  const db = await getDb();
  const insightId = await makeInsight(tenantId);
  await db.insert(rutaNotificationQueue).values({
    tenantId,
    insightId,
    userId,
    idempotencyKey: unique("idem"),
    status: "sent",
    deliveredAt,
  });
}

describe.skipIf(!process.env.DATABASE_URL)("notificationPreferences - behavior (real Postgres)", () => {
  beforeEach(() => {});

  it("getPreferences returns DEFAULT_PREFERENCES when no row exists", async () => {
    const tenantId = await makeTenant("defaults");
    const userId = await makeUser(tenantId, "U");
    const prefs = await getPreferences(tenantId, userId);
    expect(prefs).toEqual(DEFAULT_PREFERENCES);
  });

  it("updatePreferences creates a row on first use and merges partial patches thereafter", async () => {
    const tenantId = await makeTenant("upsert");
    const userId = await makeUser(tenantId, "U");

    const afterMute = await updatePreferences(tenantId, userId, { enabled: false });
    expect(afterMute.enabled).toBe(false);
    expect(afterMute.maxPerDay).toBe(DEFAULT_PREFERENCES.maxPerDay); // untouched field survives the merge

    const afterCapChange = await updatePreferences(tenantId, userId, { maxPerDay: 2 });
    expect(afterCapChange.enabled).toBe(false); // the earlier mute is still in effect - a fresh row, not overwritten
    expect(afterCapChange.maxPerDay).toBe(2);

    const readBack = await getPreferences(tenantId, userId);
    expect(readBack).toEqual(afterCapChange);
  });

  it("two different users of the same tenant have fully independent preference rows", async () => {
    const tenantId = await makeTenant("iso");
    const userA = await makeUser(tenantId, "A");
    const userB = await makeUser(tenantId, "B");
    await updatePreferences(tenantId, userA, { enabled: false });
    expect((await getPreferences(tenantId, userA)).enabled).toBe(false);
    expect((await getPreferences(tenantId, userB)).enabled).toBe(true); // still default
  });

  it("countSentInLast24h counts only 'sent' rows within the rolling window, and isUnderFrequencyCap respects maxPerDay", async () => {
    const tenantId = await makeTenant("freq");
    const userId = await makeUser(tenantId, "U");
    const now = new Date();
    const within = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
    const outside = new Date(now.getTime() - 25 * 60 * 60 * 1000); // 25h ago

    await insertSentNotification(tenantId, userId, within);
    await insertSentNotification(tenantId, userId, within);
    await insertSentNotification(tenantId, userId, outside); // outside the rolling window - not counted

    expect(await countSentInLast24h(tenantId, userId)).toBe(2);

    const prefs = { ...DEFAULT_PREFERENCES, maxPerDay: 2 };
    expect(await isUnderFrequencyCap(tenantId, userId, prefs)).toBe(false); // 2 sent, cap is 2 - at the cap, not under it
    expect(await isUnderFrequencyCap(tenantId, userId, { ...prefs, maxPerDay: 3 })).toBe(true);
  });
});
