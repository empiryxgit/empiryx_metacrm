// insightStore.ts - the "Insight Record" persistence layer. Real Postgres
// (describe.skipIf(!process.env.DATABASE_URL)), proving the dedupe
// guarantee (onConflictDoNothing keyed on (tenantId, dedupeKey)) that the
// rest of the pipeline (insightScanService.ts, notificationQueue.ts) relies
// on to only ever notify for a GENUINELY NEW insight.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../../infrastructure/db/client";
import { companies } from "../../infrastructure/db/schema";
import { getInsightById, listRecentInsights, recordInsight } from "./insightStore";
import type { DetectedInsight } from "./insightDetection";

const TZ = "Asia/Kolkata";

let counter = 0;
function unique(label: string): string {
  counter += 1;
  return `${label}-${Date.now()}-${counter}`;
}

async function makeTenant(label: string): Promise<string> {
  const db = await getDb();
  const [company] = await db.insert(companies).values({ name: `Store ${label}`, slug: unique(`is-${label}`), accountType: "individual", timezone: TZ }).returning();
  return company!.id;
}

function detected(overrides: Partial<DetectedInsight> = {}): DetectedInsight {
  return {
    kind: "overdue_followups",
    severity: "warning",
    dedupeKey: unique("dedupe"),
    title: "Overdue follow-ups",
    message: "⚠️ RUTA Alert\n5 follow-ups are overdue or due right now, company-wide.",
    metrics: { count: 5 },
    ...overrides,
  };
}

describe.skipIf(!process.env.DATABASE_URL)("insightStore - behavior (real Postgres)", () => {
  beforeEach(() => {});

  it("recordInsight inserts a genuinely new insight and returns the stored row", async () => {
    const tenantId = await makeTenant("new");
    const d = detected();
    const stored = await recordInsight(tenantId, d);
    expect(stored).not.toBeNull();
    expect(stored!.tenantId).toBe(tenantId);
    expect(stored!.kind).toBe(d.kind);
    expect(stored!.message).toBe(d.message);
    expect(stored!.metrics).toEqual(d.metrics);
  });

  it("a re-detection with the SAME dedupeKey for the SAME tenant is a true no-op - recordInsight returns null", async () => {
    const tenantId = await makeTenant("dupe");
    const d = detected();
    const first = await recordInsight(tenantId, d);
    expect(first).not.toBeNull();

    // Re-fires with a DIFFERENT message/metrics (as if the underlying
    // numbers changed slightly between scans) but the SAME dedupeKey - the
    // stored insight must stay exactly as first detected, never rewritten.
    const second = await recordInsight(tenantId, { ...d, message: "a completely different message", metrics: { count: 999 } });
    expect(second).toBeNull();

    const stillOriginal = await getInsightById(tenantId, first!.id);
    expect(stillOriginal!.message).toBe(d.message);
    expect(stillOriginal!.metrics).toEqual(d.metrics);
  });

  it("the SAME dedupeKey is independent per tenant - two tenants can both record it", async () => {
    const tenantA = await makeTenant("a");
    const tenantB = await makeTenant("b");
    const dedupeKey = unique("shared-key");
    const a = await recordInsight(tenantA, detected({ dedupeKey }));
    const b = await recordInsight(tenantB, detected({ dedupeKey }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.id).not.toBe(b!.id);
  });

  it("getInsightById is tenant-scoped - a real insight id from a DIFFERENT tenant resolves to null", async () => {
    const tenantA = await makeTenant("scope-a");
    const tenantB = await makeTenant("scope-b");
    const stored = await recordInsight(tenantA, detected());
    expect(await getInsightById(tenantB, stored!.id)).toBeNull();
    expect(await getInsightById(tenantA, stored!.id)).not.toBeNull();
  });

  it("listRecentInsights returns only this tenant's insights within the window, newest first", async () => {
    const tenantId = await makeTenant("recent");
    const other = await makeTenant("other");
    await recordInsight(other, detected());
    const first = await recordInsight(tenantId, detected({ title: "First" }));
    const second = await recordInsight(tenantId, detected({ title: "Second" }));
    const rows = await listRecentInsights(tenantId, 24);
    expect(rows.map((r) => r.id)).toEqual([second!.id, first!.id]);
  });
});
