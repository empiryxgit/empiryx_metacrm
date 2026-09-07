import { describe, expect, it } from "vitest";
import { selectExcessForDowngrade, type DowngradeCandidate } from "./capacityDowngrade";

function item(id: string, daysAgo: number, isActive = true): DowngradeCandidate {
  return { id, createdAt: new Date(Date.now() - daysAgo * 86_400_000), isActive };
}

describe("selectExcessForDowngrade", () => {
  it("returns [] when active count is at or under the limit", () => {
    const items = [item("a", 3), item("b", 2), item("c", 1)];
    expect(selectExcessForDowngrade(items, 3)).toEqual([]);
    expect(selectExcessForDowngrade(items, 5)).toEqual([]);
  });

  it("selects the newest active items beyond the limit, keeping the oldest", () => {
    // a is oldest (3 days ago), c is newest (1 day ago).
    const items = [item("a", 3), item("b", 2), item("c", 1)];
    expect(selectExcessForDowngrade(items, 2)).toEqual(["c"]);
    expect(selectExcessForDowngrade(items, 1)).toEqual(["b", "c"]);
    expect(selectExcessForDowngrade(items, 0)).toEqual(["a", "b", "c"]);
  });

  it("never selects an item that is already inactive", () => {
    const items = [item("a", 3), item("b", 2, false), item("c", 1)];
    // Only "a" and "c" are active; already over a limit of 1, only the
    // newest ACTIVE one ("c") is selected - "b" is skipped entirely even
    // though it's older, because it's already inactive.
    expect(selectExcessForDowngrade(items, 1)).toEqual(["c"]);
  });

  it("is idempotent - re-running against an already-downgraded set is a no-op", () => {
    const items = [item("a", 3), item("b", 2, false), item("c", 1, false)];
    // Only "a" is still active, well under any reasonable limit.
    expect(selectExcessForDowngrade(items, 1)).toEqual([]);
  });

  it("fails safe (selects nothing) for an invalid limit", () => {
    const items = [item("a", 3), item("b", 2)];
    expect(selectExcessForDowngrade(items, -1)).toEqual([]);
    expect(selectExcessForDowngrade(items, Number.NaN)).toEqual([]);
  });

  it("handles an empty item list", () => {
    expect(selectExcessForDowngrade([], 5)).toEqual([]);
    expect(selectExcessForDowngrade([], 0)).toEqual([]);
  });
});
