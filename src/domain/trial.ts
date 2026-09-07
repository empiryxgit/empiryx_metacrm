// The 15-day free trial + base-plan subscription state machine - the
// application-wide concept of "is this account's own plan currently
// usable at all," which src/application/billing.ts's
// getCampaignLimitStatus/getClientLimitStatus feed into their existing
// campaign/client limit checks (api/campaigns/handler.ts's
// assertCampaignLimitNotReached, api/admin/users/handler.ts's
// assertClientLimitNotReached - already the single enforcement point for
// both, so making their LIMIT trial-aware is enough to make trial capacity
// (and trial expiration) enforced everywhere those are already called,
// with no new call sites needed).
//
// Same fixed-catalog convention as accountType.ts/industryTemplates.ts:
// plain constants plus small pure resolver functions, never a magic
// number or a raw companies.subscriptionStatus string compared ad hoc at
// a call site. Pure/no DB access here on purpose, same posture as
// src/domain/billing.ts - src/application/billing.ts is where these rules
// meet a real company row.

export type SubscriptionStatusColumn = "trialing" | "active" | "expired";

export const SUBSCRIPTION_STATUS_KEYS: SubscriptionStatusColumn[] = ["trialing", "active", "expired"];

export function isSubscriptionStatusColumn(value: unknown): value is SubscriptionStatusColumn {
  return typeof value === "string" && (SUBSCRIPTION_STATUS_KEYS as string[]).includes(value);
}

/** Same "never reject/crash over an unrecognized stored value, just
 * default it" posture as resolveAccountType/resolveOnboardingStatus -
 * "active" (permanently subscribed, no trial) is what companies.
 * subscriptionStatus's own column default already is, so a missing/
 * corrupt value here degrades to the exact same grandfathered behavior a
 * pre-existing row gets. */
export function resolveSubscriptionStatusColumn(value: string | undefined | null): SubscriptionStatusColumn {
  return isSubscriptionStatusColumn(value ?? undefined) ? (value as SubscriptionStatusColumn) : "active";
}

// Per the product spec: both Individual and Agency trials last exactly 15
// days; Individual gets exactly 1 live campaign, Agency gets exactly 1
// client and 1 live campaign for that client. These are the TRIAL-only
// overrides of src/domain/billing.ts's baseCampaignLimit()/
// BASE_CLIENT_LIMIT_AGENCY (the PAID plan's own base allowance, 5/10/5) -
// never the same numbers, never merged into one constant.
export const TRIAL_DURATION_DAYS = 15;
export const TRIAL_CAMPAIGN_LIMIT = 1;
export const TRIAL_CLIENT_LIMIT_AGENCY = 1;

export function trialEndDate(from: Date = new Date()): Date {
  const end = new Date(from);
  end.setDate(end.getDate() + TRIAL_DURATION_DAYS);
  return end;
}

/** The exact company columns resolveEntitlementState reads - a narrow,
 * structural subset of the Drizzle `companies` row (never the whole row
 * type, so this stays usable from both the real repository row and a
 * plain test fixture). */
export interface EntitlementCompanyRow {
  subscriptionStatus: string | null | undefined;
  subscriptionExpiresAt: Date | string | null | undefined;
  trialStartedAt: Date | string | null | undefined;
  trialEndsAt: Date | string | null | undefined;
}

/**
 * Four possible states, always resolved lazily by comparing stored
 * timestamps to `now` at read time - same "no cron sweep, just compare to
 * now()" posture as extraSlotsActive() in src/application/billing.ts -
 * never a status flipped by a background job:
 *
 *  - "trialing": the 15-day trial is running. daysRemaining is always >= 1
 *    (see resolveEntitlementState - the instant it would hit 0, the state
 *    becomes "trial_expired" instead).
 *  - "trial_expired": the trial ran out and the account never converted to
 *    a paid base subscription. Existing campaigns/clients/leads are left
 *    untouched, but no NEW one can be created - see
 *    effectiveCampaignLimit/effectiveClientLimit below.
 *  - "subscribed": a paid base plan is active - either genuinely purchased
 *    (subscriptionExpiresAt in the future) or a grandfathered/legacy row
 *    with no expiry on file at all (expiresAt: null - see this type's own
 *    "subscribed forever" case), which is exactly how every company
 *    created before this feature already behaved.
 *  - "subscription_expired": a previously-active paid base plan's cycle
 *    has lapsed with no renewal - same "block new creation, keep existing
 *    data" treatment as "trial_expired".
 */
export type EntitlementState =
  | { kind: "trialing"; daysRemaining: number; trialEndsAt: Date }
  | { kind: "trial_expired"; trialEndsAt: Date }
  | { kind: "subscribed"; expiresAt: Date | null }
  | { kind: "subscription_expired"; expiresAt: Date };

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function resolveEntitlementState(company: EntitlementCompanyRow, now: Date = new Date()): EntitlementState {
  const status = resolveSubscriptionStatusColumn(company.subscriptionStatus);

  if (status === "trialing") {
    // A "trialing" row with no trialEndsAt on file (shouldn't happen once
    // registerCompanyAndOwner always sets both together, but never trust
    // that from a pure resolver) degrades to "already expired" rather than
    // throwing or granting an unbounded trial.
    const trialEndsAt = company.trialEndsAt ? new Date(company.trialEndsAt) : now;
    const msRemaining = trialEndsAt.getTime() - now.getTime();
    if (msRemaining > 0) {
      return { kind: "trialing", daysRemaining: Math.ceil(msRemaining / MS_PER_DAY), trialEndsAt };
    }
    return { kind: "trial_expired", trialEndsAt };
  }

  if (status === "expired") {
    const expiresAt = company.subscriptionExpiresAt ? new Date(company.subscriptionExpiresAt) : now;
    return { kind: "subscription_expired", expiresAt };
  }

  // status === "active"
  const expiresAt = company.subscriptionExpiresAt ? new Date(company.subscriptionExpiresAt) : null;
  if (expiresAt && expiresAt.getTime() <= now.getTime()) {
    return { kind: "subscription_expired", expiresAt };
  }
  return { kind: "subscribed", expiresAt };
}

export function isEntitlementBlocked(state: EntitlementState): boolean {
  return state.kind === "trial_expired" || state.kind === "subscription_expired";
}

/** The campaign-count LIMIT to check `used` against right now - what makes
 * "exactly 1 campaign during trial" and "no new campaign once expired"
 * real, enforced numbers rather than marketing copy, by feeding directly
 * into getCampaignLimitStatus (src/application/billing.ts), the same
 * function api/campaigns/handler.ts's assertCampaignLimitNotReached
 * already gates every campaign creation on. `baseLimit` is the PAID plan's
 * own allowance (baseCampaignLimit(accountType) + any purchased overage) -
 * only actually used while "subscribed". Once blocked, the limit is
 * pinned to `used` (never below it) so remaining is exactly 0 without
 * ever reporting the account as somehow over its own limit. */
export function effectiveCampaignLimit(state: EntitlementState, baseLimit: number, used: number): number {
  if (state.kind === "trialing") return TRIAL_CAMPAIGN_LIMIT;
  if (isEntitlementBlocked(state)) return used;
  return baseLimit;
}

/** Same idea as effectiveCampaignLimit, for the Agency-only client count
 * (getClientLimitStatus). */
export function effectiveClientLimit(state: EntitlementState, baseLimit: number, used: number): number {
  if (state.kind === "trialing") return TRIAL_CLIENT_LIMIT_AGENCY;
  if (isEntitlementBlocked(state)) return used;
  return baseLimit;
}
