-- Platform Admin "Packages" (editable pricing config) + "Subscriptions"
-- (full billing management) support - see src/application/pricing.ts for
-- how these two new tables are read, and this table's own row shape below
-- for exactly what became DB-editable vs. what stayed a fixed domain
-- constant (see src/domain/billing.ts's own updated header comment for the
-- full reasoning on that split).
--
-- platform_packages: one row per account type ("individual" | "agency"),
-- holding the base-plan price/limits and the overage unit price for that
-- account type - the same numbers src/domain/billing.ts previously only
-- ever hardcoded as BASE_CAMPAIGN_LIMIT/BASE_CLIENT_LIMIT_AGENCY/
-- INDIVIDUAL_BASE_PLAN_MONTHLY_PAISE/AGENCY_BASE_PLAN_MONTHLY_PAISE/
-- INDIVIDUAL_EXTRA_CAMPAIGN_MONTHLY_PAISE/AGENCY_BUNDLE_MONTHLY_PAISE.
-- Deliberately NOT included here: what one Agency overage "bundle" is
-- physically made of (AGENCY_BUNDLE_EXTRA_CLIENTS=1, AGENCY_BUNDLE_
-- EXTRA_CAMPAIGNS=2) - that composition is baked directly into
-- markBillingOrderPaidAndApply's raw SQL (src/infrastructure/db/
-- repositories/billing.ts) and the trial allowances (TRIAL_CAMPAIGN_LIMIT
-- etc., src/domain/trial.ts) - both stay fixed domain constants, never
-- editable from this table, so a Packages price edit can never silently
-- desync from what a bundle actually grants.
CREATE TABLE IF NOT EXISTS "crm"."platform_packages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "account_type" text NOT NULL,
  "base_monthly_paise" integer NOT NULL,
  "base_campaign_limit" integer NOT NULL,
  "base_client_limit" integer,
  "overage_unit_monthly_paise" integer NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."platform_packages" ADD CONSTRAINT "platform_packages_updated_by_platform_admins_id_fk" FOREIGN KEY ("updated_by") REFERENCES "crm"."platform_admins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_platform_packages_account_type" ON "crm"."platform_packages" USING btree ("account_type");
--> statement-breakpoint
-- Seeded with today's live src/domain/billing.ts constants so the DB is the
-- single source of truth from the moment this migration runs, rather than
-- Packages starting blank and quietly relying on the pure-domain fallback
-- (see resolvePricingConfig's own comment in src/application/pricing.ts -
-- that fallback exists only as a defensive backstop, e.g. a row deleted by
-- hand, never as the normal path once this has applied). ON CONFLICT DO
-- NOTHING makes this safe to re-run and safe to run AFTER an admin has
-- already edited a row - never overwrites a real edit.
INSERT INTO "crm"."platform_packages" ("account_type", "base_monthly_paise", "base_campaign_limit", "base_client_limit", "overage_unit_monthly_paise")
VALUES ('individual', 250000, 5, NULL, 50000)
ON CONFLICT ("account_type") DO NOTHING;
--> statement-breakpoint
INSERT INTO "crm"."platform_packages" ("account_type", "base_monthly_paise", "base_campaign_limit", "base_client_limit", "overage_unit_monthly_paise")
VALUES ('agency', 699900, 10, 5, 140000)
ON CONFLICT ("account_type") DO NOTHING;
--> statement-breakpoint
-- platform_billing_cycle_discounts: one row per BillingCycle
-- (src/domain/billing.ts), replacing the previously-hardcoded CYCLE_DISCOUNT
-- map. discount_percent is a whole-number percent (0-100), never a float,
-- so an admin edit can never introduce float-rounding drift into
-- computeOverageAmountInPaise/computeBaseSubscriptionAmountInPaise's own
-- "* (1 - discount)" arithmetic.
CREATE TABLE IF NOT EXISTS "crm"."platform_billing_cycle_discounts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "cycle" text NOT NULL,
  "discount_percent" integer DEFAULT 0 NOT NULL,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."platform_billing_cycle_discounts" ADD CONSTRAINT "platform_billing_cycle_discounts_updated_by_platform_admins_id_fk" FOREIGN KEY ("updated_by") REFERENCES "crm"."platform_admins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_platform_billing_cycle_discounts_cycle" ON "crm"."platform_billing_cycle_discounts" USING btree ("cycle");
--> statement-breakpoint
INSERT INTO "crm"."platform_billing_cycle_discounts" ("cycle", "discount_percent") VALUES ('monthly', 0) ON CONFLICT ("cycle") DO NOTHING;
--> statement-breakpoint
INSERT INTO "crm"."platform_billing_cycle_discounts" ("cycle", "discount_percent") VALUES ('quarterly', 10) ON CONFLICT ("cycle") DO NOTHING;
--> statement-breakpoint
INSERT INTO "crm"."platform_billing_cycle_discounts" ("cycle", "discount_percent") VALUES ('halfyearly', 20) ON CONFLICT ("cycle") DO NOTHING;
--> statement-breakpoint
INSERT INTO "crm"."platform_billing_cycle_discounts" ("cycle", "discount_percent") VALUES ('yearly', 25) ON CONFLICT ("cycle") DO NOTHING;
--> statement-breakpoint
-- Refund tracking on billing_orders - "view/refund individual Razorpay
-- payment orders per customer" (Platform Admin Subscriptions scope). This
-- codebase does not call Razorpay's own Refunds API from here (that would
-- move real money and was not separately confirmed with the user) - these
-- four columns record that an admin has marked a payment refunded
-- (presumably after actually issuing the refund from the Razorpay
-- Dashboard directly), so refundedAt/refundAmountInPaise/refundReason/
-- refundedBy is an audit-trail fact, not a live refund action. See
-- refundPaymentOrder in src/application/platformAdmin.ts.
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD COLUMN "refunded_at" timestamp with time zone;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD COLUMN "refund_amount_in_paise" integer;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD COLUMN "refund_reason" text;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD COLUMN "refunded_by" uuid;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."billing_orders" ADD CONSTRAINT "billing_orders_refunded_by_platform_admins_id_fk" FOREIGN KEY ("refunded_by") REFERENCES "crm"."platform_admins"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
