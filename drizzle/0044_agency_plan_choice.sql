-- Lets an Agency choose, at subscribe time, which pricing TIER its own
-- base plan is on - "Individual" (same price/limits an Individual account
-- gets, no client concept at all) or "Agency" (the existing bundled
-- campaigns+clients tier) - instead of accountType = "agency" alone always
-- forcing Agency-tier pricing onto every agency owner, even one who only
-- ever plans to use RUTA for their own leads. See companies.
-- subscription_plan_type's own doc comment in schema.ts and
-- resolveEffectivePlanAccountType in src/domain/billing.ts for the full
-- reasoning and how this is resolved everywhere a limit/price is checked.
--
-- Nullable, and deliberately NOT backfilled for any existing row: every
-- company created before this migration - including every already-
-- subscribed Agency customer - keeps resolving to the "agency" tier
-- exactly as it always has (resolveEffectivePlanAccountType's own
-- documented fallback), so this migration changes no existing account's
-- limits or pricing on its own. Only set going forward, by
-- markBillingOrderPaidAndApply, the moment an Agency's chosen plan is
-- actually paid for.
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "subscription_plan_type" text;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
-- Which plan tier ("individual" | "agency") a base_subscription order was
-- for - only ever set on orders of that kind; null for every overage
-- order (individual_campaigns/agency_bundles), which has no separate plan
-- choice of its own. Snapshotted here the same way every other pricing
-- figure on this table already is, and read back by
-- markBillingOrderPaidAndApply to know what to write onto companies.
-- subscription_plan_type once the order is paid.
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD COLUMN "plan_type" text;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
