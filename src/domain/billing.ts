// Campaign/client capacity limits and overage pricing - the application
// side of the tiers shown on the marketing page (public/index.html
// #pricing). Same fixed-catalog convention as accountType.ts/
// industryTemplates.ts: plain constants plus small resolver functions,
// never a magic number typed ad hoc at a call site. Pure/no DB access here
// on purpose - src/application/billing.ts is where these numbers meet real
// company/campaign rows.
//
// Where these numbers come from (see public/index.html's own PICKERS
// object and its "How many campaigns or clients can I connect?" FAQ
// answer):
//   Individual - ₹2,500/mo base plan, 5 Meta ad campaigns included.
//   Agency Basic - ₹6,999/mo base plan, 5 clients / 10 campaigns total.
// Overage rates (confirmed with the user via AskUserQuestion, derived from
// those same base prices - see this feature's own commit message/PR
// description for the exact numbers each was recommended from):
//   Individual - ₹500 per extra campaign / month.
//   Agency - ₹1,400 per bundle / month, where one bundle is a FIXED unit of
//     1 extra client + 2 extra campaigns together (never sold separately -
//     "for Agency pricing would be on minimum 1 client and 2 campaign").
// Both follow the exact same billing-cycle discount structure as the base
// plans (10% quarterly, 20% half-yearly, 25% yearly).

import type { AccountType } from "./accountType";

export type BillingCycle = "monthly" | "quarterly" | "halfyearly" | "yearly";

export const BILLING_CYCLE_KEYS: BillingCycle[] = ["monthly", "quarterly", "halfyearly", "yearly"];

export function isBillingCycle(value: unknown): value is BillingCycle {
  return typeof value === "string" && (BILLING_CYCLE_KEYS as string[]).includes(value);
}

export const CYCLE_LABELS: Record<BillingCycle, string> = {
  monthly: "Monthly",
  quarterly: "Quarterly",
  halfyearly: "Half-Yearly",
  yearly: "Yearly",
};

// Months covered by ONE purchase of each cycle, and the discount applied to
// (unit price * quantity * months) - exactly the math public/index.html's
// own PICKERS table uses for the base plans.
export const CYCLE_MONTHS: Record<BillingCycle, number> = { monthly: 1, quarterly: 3, halfyearly: 6, yearly: 12 };
export const CYCLE_DISCOUNT: Record<BillingCycle, number> = { monthly: 0, quarterly: 0.1, halfyearly: 0.2, yearly: 0.25 };

// ---------------------------------------------------------------------------
// Base plan allowances
// ---------------------------------------------------------------------------

/** "5 Meta ad campaigns" (Individual) / "10 campaigns total" (Agency Basic)
 * - see public/index.html's .plan-result-campaigns copy. Never compared
 * against directly outside baseCampaignLimit() so a future tiered-plan
 * system has one place to change. */
export const BASE_CAMPAIGN_LIMIT: Record<AccountType, number> = { individual: 5, agency: 10 };

/** "5 clients" (Agency Basic) - Individual has no client concept, so this
 * is only ever checked for accountType "agency". */
export const BASE_CLIENT_LIMIT_AGENCY = 5;

export function baseCampaignLimit(accountType: AccountType): number {
  return BASE_CAMPAIGN_LIMIT[accountType] ?? BASE_CAMPAIGN_LIMIT.individual;
}

// ---------------------------------------------------------------------------
// Overage pricing
// ---------------------------------------------------------------------------

/** What a company buys more of when it hits its base allowance -
 * "individual_campaigns" (raw extra campaign slots, one at a time) or
 * "agency_bundles" (a fixed 1-client + 2-campaign unit). Stored verbatim on
 * billingOrders.kind. */
export type OverageKind = "individual_campaigns" | "agency_bundles";

export function overageKindForAccountType(accountType: AccountType): OverageKind {
  return accountType === "agency" ? "agency_bundles" : "individual_campaigns";
}

export const INDIVIDUAL_EXTRA_CAMPAIGN_MONTHLY_PAISE = 50_000; // ₹500/campaign/mo
export const AGENCY_BUNDLE_MONTHLY_PAISE = 140_000; // ₹1,400/bundle/mo
export const AGENCY_BUNDLE_EXTRA_CLIENTS = 1;
export const AGENCY_BUNDLE_EXTRA_CAMPAIGNS = 2;

function unitMonthlyPaise(kind: OverageKind): number {
  return kind === "agency_bundles" ? AGENCY_BUNDLE_MONTHLY_PAISE : INDIVIDUAL_EXTRA_CAMPAIGN_MONTHLY_PAISE;
}

/** Total order amount (in paise - Razorpay's own smallest-unit convention)
 * for `quantity` units of `kind`, paid upfront for one `cycle` - identical
 * formula to the base plans on the marketing page:
 * unitMonthly * quantity * months * (1 - discount), rounded to the nearest
 * paise (Razorpay's Orders API requires an integer amount). */
export function computeOverageAmountInPaise(kind: OverageKind, quantity: number, cycle: BillingCycle): number {
  const months = CYCLE_MONTHS[cycle];
  const discount = CYCLE_DISCOUNT[cycle];
  return Math.round(unitMonthlyPaise(kind) * quantity * months * (1 - discount));
}

/** How many extra campaign / client slots `quantity` units of `kind` grant. */
export function overageSlotsForQuantity(kind: OverageKind, quantity: number): { extraCampaigns: number; extraClients: number } {
  if (kind === "agency_bundles") {
    return {
      extraCampaigns: quantity * AGENCY_BUNDLE_EXTRA_CAMPAIGNS,
      extraClients: quantity * AGENCY_BUNDLE_EXTRA_CLIENTS,
    };
  }
  return { extraCampaigns: quantity, extraClients: 0 };
}

/** `from` + the number of months `cycle` covers - when a paid-for overage
 * cycle ends and the extra slots it granted stop being honored (see
 * extraSlotsActive() in src/application/billing.ts). */
export function cycleEndDate(cycle: BillingCycle, from: Date = new Date()): Date {
  const end = new Date(from);
  end.setMonth(end.getMonth() + CYCLE_MONTHS[cycle]);
  return end;
}
