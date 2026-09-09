-- 15-day free trial + base-plan subscription state (see src/domain/trial.ts
-- for the state machine these columns feed, and src/application/billing.ts
-- for how trial/subscription state changes the campaign/client limits
-- already enforced by getCampaignLimitStatus/getClientLimitStatus).
--
-- subscription_status defaults to 'active' with no expiry (subscription_
-- expires_at stays null) so every EXISTING company - created before this
-- migration - is grandfathered as a fully active account with no trial:
-- resolveEntitlementState() treats status 'active' + null expiry as
-- permanently "subscribed", identical to how these companies already
-- behave today (the base plan limit applied unconditionally, forever).
-- Only src/application/auth.ts's registerCompanyAndOwner explicitly
-- overrides these three columns (to 'trialing' + trial_started_at/
-- trial_ends_at) for a brand-new top-level registration going forward -
-- every other createCompany() caller (agency client provisioning) leaves
-- them at this same inert default, which is correct: a claimed client
-- company never has a plan of its own, entitlement always resolves to its
-- claiming agency's own row (see resolvePoolRootCompanyId).
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "trial_started_at" timestamp with time zone;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "trial_ends_at" timestamp with time zone;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "subscription_status" text DEFAULT 'active' NOT NULL;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "subscription_cycle" text;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD COLUMN "subscription_expires_at" timestamp with time zone;
EXCEPTION
 WHEN duplicate_column THEN null;
END $$;
