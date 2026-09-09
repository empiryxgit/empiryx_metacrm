// Pure logic tests for the trial/subscription state machine - no DB, same
// convention as onboarding.test.ts/industryTemplates.test.ts. Every case
// here is a fixed point in time (never `new Date()` at call time) so the
// suite is deterministic regardless of when it runs.

import { describe, expect, it } from "vitest";
import {
  effectiveCampaignLimit,
  effectiveClientLimit,
  isEntitlementBlocked,
  resolveEntitlementState,
  resolveSubscriptionStatusColumn,
  trialEndDate,
  TRIAL_CAMPAIGN_LIMIT,
  TRIAL_CLIENT_LIMIT_AGENCY,
  TRIAL_DURATION_DAYS,
  type EntitlementCompanyRow,
} from "./trial";

const NOW = new Date("2026-06-15T12:00:00.000Z");

function row(overrides: Partial<EntitlementCompanyRow>): EntitlementCompanyRow {
  return {
    subscriptionStatus: "active",
    subscriptionExpiresAt: null,
    trialStartedAt: null,
    trialEndsAt: null,
    ...overrides,
  };
}

describe("resolveSubscriptionStatusColumn", () => {
  it("passes through every recognized value", () => {
    expect(resolveSubscriptionStatusColumn("trialing")).toBe("trialing");
    expect(resolveSubscriptionStatusColumn("active")).toBe("active");
    expect(resolveSubscriptionStatusColumn("expired")).toBe("expired");
  });

  it("defaults an unrecognized/missing value to 'active' - never throws", () => {
    expect(resolveSubscriptionStatusColumn(undefined)).toBe("active");
    expect(resolveSubscriptionStatusColumn(null)).toBe("active");
    expect(resolveSubscriptionStatusColumn("bogus")).toBe("active");
  });
});

describe("trialEndDate", () => {
  it("is exactly TRIAL_DURATION_DAYS after `from`", () => {
    const end = trialEndDate(NOW);
    expect(end.getTime() - NOW.getTime()).toBe(TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
  });
});

describe("resolveEntitlementState", () => {
  it("a pre-existing/grandfathered company (active, no expiry, no trial dates) is always 'subscribed'", () => {
    const state = resolveEntitlementState(row({}), NOW);
    expect(state).toEqual({ kind: "subscribed", expiresAt: null });
    expect(isEntitlementBlocked(state)).toBe(false);
  });

  it("a claimed CLIENT company (same inert default - never given its own trial) also resolves 'subscribed'", () => {
    // Exactly what createCompany() produces for a company created WITHOUT
    // the optional `trial` param - see this file's own header comment and
    // src/infrastructure/db/repositories/tenancy.ts's createCompany.
    const state = resolveEntitlementState(row({}), NOW);
    expect(state.kind).toBe("subscribed");
  });

  it("a brand-new trial mid-way through its 15 days is 'trialing' with the correct days remaining", () => {
    const trialEndsAt = new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000);
    const state = resolveEntitlementState(row({ subscriptionStatus: "trialing", trialEndsAt }), NOW);
    expect(state).toEqual({ kind: "trialing", daysRemaining: 5, trialEndsAt });
    expect(isEntitlementBlocked(state)).toBe(false);
  });

  it("a trial that has just run out (trialEndsAt in the past) is 'trial_expired'", () => {
    const trialEndsAt = new Date(NOW.getTime() - 1000);
    const state = resolveEntitlementState(row({ subscriptionStatus: "trialing", trialEndsAt }), NOW);
    expect(state).toEqual({ kind: "trial_expired", trialEndsAt });
    expect(isEntitlementBlocked(state)).toBe(true);
  });

  it("a trial ending at exactly `now` counts as expired, not trialing (boundary is exclusive)", () => {
    const state = resolveEntitlementState(row({ subscriptionStatus: "trialing", trialEndsAt: NOW }), NOW);
    expect(state.kind).toBe("trial_expired");
  });

  it("a 'trialing' row with no trialEndsAt on file degrades to already-expired rather than throwing", () => {
    const state = resolveEntitlementState(row({ subscriptionStatus: "trialing", trialEndsAt: null }), NOW);
    expect(state.kind).toBe("trial_expired");
  });

  it("a paid base plan still inside its cycle is 'subscribed' with the real expiry", () => {
    const expiresAt = new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000);
    const state = resolveEntitlementState(row({ subscriptionStatus: "active", subscriptionExpiresAt: expiresAt }), NOW);
    expect(state).toEqual({ kind: "subscribed", expiresAt });
  });

  it("a paid base plan past its cycle end is 'subscription_expired'", () => {
    const expiresAt = new Date(NOW.getTime() - 1000);
    const state = resolveEntitlementState(row({ subscriptionStatus: "active", subscriptionExpiresAt: expiresAt }), NOW);
    expect(state).toEqual({ kind: "subscription_expired", expiresAt });
    expect(isEntitlementBlocked(state)).toBe(true);
  });

  it("an explicitly 'expired' status resolves 'subscription_expired' even with no expiry timestamp on file", () => {
    const state = resolveEntitlementState(row({ subscriptionStatus: "expired", subscriptionExpiresAt: null }), NOW);
    expect(state.kind).toBe("subscription_expired");
  });
});

describe("effectiveCampaignLimit / effectiveClientLimit", () => {
  it("pins the limit to TRIAL_CAMPAIGN_LIMIT/TRIAL_CLIENT_LIMIT_AGENCY while trialing, ignoring baseLimit", () => {
    const trialing = resolveEntitlementState(row({ subscriptionStatus: "trialing", trialEndsAt: new Date(NOW.getTime() + 1000) }), NOW);
    expect(effectiveCampaignLimit(trialing, 5, 0)).toBe(TRIAL_CAMPAIGN_LIMIT);
    expect(effectiveCampaignLimit(trialing, 999, 0)).toBe(TRIAL_CAMPAIGN_LIMIT);
    expect(effectiveClientLimit(trialing, 5, 0)).toBe(TRIAL_CLIENT_LIMIT_AGENCY);
  });

  it("uses the real baseLimit once genuinely subscribed", () => {
    const subscribed = resolveEntitlementState(row({}), NOW);
    expect(effectiveCampaignLimit(subscribed, 5, 1)).toBe(5);
    expect(effectiveCampaignLimit(subscribed, 15, 10)).toBe(15); // base + overage
    expect(effectiveClientLimit(subscribed, 5, 2)).toBe(5);
  });

  it("pins the limit to exactly `used` once blocked (trial_expired or subscription_expired) - blocks new creation, never reports over-limit", () => {
    const trialExpired = resolveEntitlementState(row({ subscriptionStatus: "trialing", trialEndsAt: new Date(NOW.getTime() - 1000) }), NOW);
    expect(effectiveCampaignLimit(trialExpired, 5, 1)).toBe(1);
    expect(effectiveClientLimit(trialExpired, 5, 1)).toBe(1);

    const subscriptionExpired = resolveEntitlementState(row({ subscriptionExpiresAt: new Date(NOW.getTime() - 1000) }), NOW);
    expect(effectiveCampaignLimit(subscriptionExpired, 10, 7)).toBe(7);
    expect(effectiveClientLimit(subscriptionExpired, 5, 3)).toBe(3);
  });

  it("a blocked account with zero existing campaigns/clients has a limit of 0, not a negative or the base limit", () => {
    const trialExpired = resolveEntitlementState(row({ subscriptionStatus: "trialing", trialEndsAt: new Date(NOW.getTime() - 1000) }), NOW);
    expect(effectiveCampaignLimit(trialExpired, 5, 0)).toBe(0);
  });
});
