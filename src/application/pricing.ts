// Platform Admin "Packages" (editable pricing config) - the bridge between
// src/domain/billing.ts's pure, hardcoded pricing catalog and the new
// crm.platform_packages / crm.platform_billing_cycle_discounts tables (see
// drizzle/0034_platform_packages_and_billing_refunds.sql for the full
// reasoning on exactly what became DB-editable vs. what deliberately stayed
// a fixed domain constant).
//
// This is the ONLY module that ever reads either table - src/application/
// billing.ts and every other call site goes through resolvePricingConfig()
// and the effective* helpers below, never straight at the repository. That
// is what makes the fallback rule below safe to state in exactly one place:
//
//   Every field is read from the DB when a row for it exists, and falls
//   back to src/domain/billing.ts's own constant when it doesn't (table
//   empty, row deleted by hand, or a brand-new environment that hasn't run
//   migration 0034 yet). A brand-new environment therefore behaves EXACTLY
//   as it did before this feature existed - nothing about existing
//   pricing/limit behavior changes just by this file existing, only once an
//   admin has actually edited something (or migration 0034's own seed rows,
//   which are simply today's constants copied into the DB, have applied)
//   does a real DB value ever differ from the domain fallback.
//
// Deliberately excluded from all of this (stays a fixed domain constant,
// never read from either table): TRIAL_DURATION_DAYS/TRIAL_CAMPAIGN_LIMIT/
// TRIAL_CLIENT_LIMIT_AGENCY (src/domain/trial.ts - the trial state machine
// itself, out of scope for "editable pricing config") and
// AGENCY_BUNDLE_EXTRA_CLIENTS/AGENCY_BUNDLE_EXTRA_CAMPAIGNS (src/domain/
// billing.ts - what one Agency overage bundle is physically made of, which
// markBillingOrderPaidAndApply's raw SQL in repositories/billing.ts hardcodes
// directly and would silently disagree with if this ever became editable
// without also rewriting that SQL).

import {
  AGENCY_BASE_PLAN_MONTHLY_PAISE,
  AGENCY_BUNDLE_MONTHLY_PAISE,
  BASE_CAMPAIGN_LIMIT,
  BASE_CLIENT_LIMIT_AGENCY,
  BILLING_CYCLE_KEYS,
  CYCLE_DISCOUNT,
  CYCLE_MONTHS,
  INDIVIDUAL_BASE_PLAN_MONTHLY_PAISE,
  INDIVIDUAL_EXTRA_CAMPAIGN_MONTHLY_PAISE,
  type BillingCycle,
  type OverageKind,
} from "../domain/billing";
import { isAccountType, type AccountType } from "../domain/accountType";
import { listCycleDiscounts, listPlatformPackages } from "../infrastructure/db/repositories/platformPackages";

export interface EffectivePackageConfig {
  baseMonthlyPaise: number;
  baseCampaignLimit: number;
  /** Only meaningful for "agency" - always null for "individual" (see
   * BASE_CLIENT_LIMIT_AGENCY's own doc comment in src/domain/billing.ts). */
  baseClientLimit: number | null;
  overageUnitMonthlyPaise: number;
}

export interface EffectivePricingConfig {
  individual: EffectivePackageConfig;
  agency: EffectivePackageConfig;
  /** Fraction (0..1), same unit CYCLE_DISCOUNT's own values already are -
   * see effectiveCycleDiscountFraction below for the one place a stored
   * whole-number percent is divided back down to this. */
  cycleDiscount: Record<BillingCycle, number>;
}

function fallbackPackageConfig(accountType: AccountType): EffectivePackageConfig {
  return {
    baseMonthlyPaise: accountType === "agency" ? AGENCY_BASE_PLAN_MONTHLY_PAISE : INDIVIDUAL_BASE_PLAN_MONTHLY_PAISE,
    baseCampaignLimit: BASE_CAMPAIGN_LIMIT[accountType] ?? BASE_CAMPAIGN_LIMIT.individual,
    baseClientLimit: accountType === "agency" ? BASE_CLIENT_LIMIT_AGENCY : null,
    overageUnitMonthlyPaise: accountType === "agency" ? AGENCY_BUNDLE_MONTHLY_PAISE : INDIVIDUAL_EXTRA_CAMPAIGN_MONTHLY_PAISE,
  };
}

function fallbackConfig(): EffectivePricingConfig {
  return {
    individual: fallbackPackageConfig("individual"),
    agency: fallbackPackageConfig("agency"),
    cycleDiscount: { ...CYCLE_DISCOUNT },
  };
}

/** Exposed for public/admin/packages.html's own "Reset to default" display
 * (see getPlatformPackagesOverview in src/application/platformAdmin.ts) -
 * the exact same src/domain/billing.ts constants resolvePricingConfig
 * itself falls back to, so an admin can always see what "default" means
 * without needing to delete a row to find out. */
export function getFallbackPricingConfig(): EffectivePricingConfig {
  return fallbackConfig();
}

// Module-level cache - deliberately process-lifetime, not per-request. A
// Vercel serverless function's module scope is reused across warm
// invocations of the SAME lambda instance (the standard "keep expensive
// setup outside the handler" pattern this runtime already relies on for its
// DB connection pool - see getDb() in src/infrastructure/db/client.ts), so
// this avoids two extra SELECTs on every single billing/limit check without
// ever needing its own cron/sweep to stay fresh. TTL is short (30s) so an
// admin's own edit is visible within, at most, a handful of seconds even on
// an instance this call didn't invalidate directly (see
// invalidatePricingConfigCache below - the admin's OWN request always sees
// its own edit immediately, this TTL only bounds staleness for a
// DIFFERENT concurrent lambda instance that happened to have this cached).
const CACHE_TTL_MS = 30_000;
let cached: { config: EffectivePricingConfig; expiresAt: number } | null = null;

export async function resolvePricingConfig(): Promise<EffectivePricingConfig> {
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  const fallback = fallbackConfig();
  try {
    const [packageRows, cycleRows] = await Promise.all([listPlatformPackages(), listCycleDiscounts()]);

    const config: EffectivePricingConfig = {
      individual: { ...fallback.individual },
      agency: { ...fallback.agency },
      cycleDiscount: { ...fallback.cycleDiscount },
    };

    for (const row of packageRows) {
      if (!row.isActive) continue;
      if (!isAccountType(row.accountType)) continue;
      const accountType: AccountType = row.accountType;
      config[accountType] = {
        baseMonthlyPaise: row.baseMonthlyPaise,
        baseCampaignLimit: row.baseCampaignLimit,
        baseClientLimit: accountType === "agency" ? row.baseClientLimit ?? fallback.agency.baseClientLimit : null,
        overageUnitMonthlyPaise: row.overageUnitMonthlyPaise,
      };
    }

    for (const row of cycleRows) {
      if (!BILLING_CYCLE_KEYS.includes(row.cycle as BillingCycle)) continue;
      config.cycleDiscount[row.cycle as BillingCycle] = Math.max(0, Math.min(100, row.discountPercent)) / 100;
    }

    cached = { config, expiresAt: Date.now() + CACHE_TTL_MS };
    return config;
  } catch (err) {
    // Same "never let a pricing lookup crash the request that just wants to
    // check a limit" posture as every other best-effort read in this
    // codebase (recordAgencyAuditEvent's own try/catch) - a transient DB
    // hiccup here degrades to the exact pre-this-feature hardcoded
    // behavior rather than 500ing every campaign-limit check in the app.
    console.error("[pricing] Failed to resolve DB-backed pricing config, falling back to domain constants:", err);
    return fallback;
  }
}

/** Called right after any Packages/cycle-discount admin write (see
 * updatePlatformPackage/updateCycleDiscount in src/application/
 * platformAdmin.ts) so the admin's OWN next request - and every other
 * request handled by this same warm lambda instance - sees the edit
 * immediately rather than waiting out CACHE_TTL_MS. */
export function invalidatePricingConfigCache(): void {
  cached = null;
}

export function effectivePackageFor(config: EffectivePricingConfig, accountType: AccountType): EffectivePackageConfig {
  return accountType === "agency" ? config.agency : config.individual;
}

export function effectiveBaseCampaignLimit(config: EffectivePricingConfig, accountType: AccountType): number {
  return effectivePackageFor(config, accountType).baseCampaignLimit;
}

export function effectiveBaseClientLimitAgency(config: EffectivePricingConfig): number {
  return config.agency.baseClientLimit ?? BASE_CLIENT_LIMIT_AGENCY;
}

/** Same "* (1 - discount)" arithmetic as computeOverageAmountInPaise/
 * computeBaseSubscriptionAmountInPaise in src/domain/billing.ts, just
 * reading the discount fraction out of `config` instead of the hardcoded
 * CYCLE_DISCOUNT map. `kind`/`quantity`/`cycle` keep the exact same meaning
 * those two domain functions already gave them - see OverageKind's own doc
 * comment there. */
export function effectiveOverageAmountInPaise(config: EffectivePricingConfig, kind: OverageKind, quantity: number, cycle: BillingCycle): number {
  const months = CYCLE_MONTHS[cycle];
  const discount = config.cycleDiscount[cycle];
  const unitMonthlyPaise = effectiveOverageUnitMonthlyPaise(config, kind);
  return Math.round(unitMonthlyPaise * quantity * months * (1 - discount));
}

export function effectiveBaseSubscriptionAmountInPaise(config: EffectivePricingConfig, accountType: AccountType, cycle: BillingCycle): number {
  const months = CYCLE_MONTHS[cycle];
  const discount = config.cycleDiscount[cycle];
  const unitMonthlyPaise = effectivePackageFor(config, accountType).baseMonthlyPaise;
  return Math.round(unitMonthlyPaise * months * (1 - discount));
}

export function effectiveCycleDiscountPct(config: EffectivePricingConfig, cycle: BillingCycle): number {
  return Math.round(config.cycleDiscount[cycle] * 100);
}

/** One unit's monthly price for `kind` - the same number
 * effectiveOverageAmountInPaise(config, accountType, 1, "monthly") would
 * compute, exposed directly for call sites (getBillingStatus's own overage
 * pricing table) that build a per-cycle price LIST rather than pricing one
 * purchase. `kind` still selects which side of the config to read from
 * (overageKindForAccountType(accountType) is what every real call site
 * already derives this from - see src/domain/billing.ts). */
export function effectiveOverageUnitMonthlyPaise(config: EffectivePricingConfig, kind: OverageKind): number {
  return kind === "agency_bundles" ? config.agency.overageUnitMonthlyPaise : config.individual.overageUnitMonthlyPaise;
}
