// Phase 14 of the trial/subscription entitlement spec: "never delete data
// on downgrade - mark excess inactive instead." A "downgrade" here is any
// moment where the number of a company's already-existing campaigns/clients
// exceeds its CURRENTLY effective limit - in practice almost always because
// a paid extra-capacity cycle expired (see activeExtraSlots in
// src/application/billing.ts), since nothing in this app yet lets a company
// reduce its own base plan directly. This module is pure selection logic
// only - no DB access at all - so it's fully unit-testable in isolation;
// src/application/billing.ts's reconcileCapacityDowngrade is the only
// caller, and it alone does the actual DB reads/writes.
//
// Rule: keep the OLDEST `limit` many currently-active items (oldest wins -
// a long-standing campaign/client is never punished just because a newer
// one happened to be created after capacity shrank); everything beyond
// that, among the active set, is "excess" and gets marked inactive.
// Already-inactive items are never re-selected, which is what makes this
// idempotent - re-running it against an already-downgraded company (e.g. on
// every 15-minute reconciliation sweep) is always a no-op.

export interface DowngradeCandidate {
  id: string;
  createdAt: Date | string;
  /** true if this row is currently in an "active" (capacity-consuming AND
   * functioning) state - a campaign whose status isn't "paused"/"archived",
   * or an agency_clients relationship whose status is "active"/"invited"/
   * "pending" (not yet "suspended"/"removed"). Already-inactive rows are
   * never selected, regardless of why they became inactive (the tenant's
   * own choice, or a prior downgrade run). */
  isActive: boolean;
}

/** Returns the ids that should be newly marked inactive to bring the
 * currently-active count down to `limit`. Returns `[]` when already at or
 * under the limit, or when `limit` is negative/invalid (fails safe - never
 * selects anything rather than risk over-selecting on a bad input). */
export function selectExcessForDowngrade(items: DowngradeCandidate[], limit: number): string[] {
  if (!Number.isFinite(limit) || limit < 0) return [];
  const active = items.filter((item) => item.isActive);
  if (active.length <= limit) return [];
  const oldestFirst = [...active].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  return oldestFirst.slice(limit).map((item) => item.id);
}
