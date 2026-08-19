ALTER TABLE "crm"."forms" ADD COLUMN "branch_mode" text DEFAULT 'specific' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."forms" ADD COLUMN "branch_field_key" text;--> statement-breakpoint
ALTER TABLE "crm"."forms" ADD COLUMN "branch_field_map" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."forms" ADD COLUMN "default_pipeline_stage" text;--> statement-breakpoint
ALTER TABLE "crm"."forms" ADD COLUMN "default_crm_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."forms" ADD COLUMN "default_source" text;--> statement-breakpoint
ALTER TABLE "crm"."forms" ADD COLUMN "default_owner_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."forms" ADD CONSTRAINT "forms_default_crm_campaign_id_campaigns_id_fk" FOREIGN KEY ("default_crm_campaign_id") REFERENCES "crm"."campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."forms" ADD CONSTRAINT "forms_default_owner_id_users_id_fk" FOREIGN KEY ("default_owner_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
-- Backfill: every form created before Branch Configuration existed only had
-- a nullable branch_id (null = company-wide). The new branch_mode column
-- defaults to 'specific' for the ALTER above (matching a form that DOES have
-- a branch_id set), so any pre-existing company-wide form (branch_id IS
-- NULL) must be corrected to 'all' here - otherwise it would read as
-- "specific branch: none", which src/application/formBranch.ts treats
-- identically to 'all' today, but would be a silently wrong label the
-- moment a company later sets a branch_id on that same row without also
-- updating branch_mode. Forms with a branch_id already set need no change -
-- 'specific' is already correct for them.
UPDATE "crm"."forms" SET "branch_mode" = 'all' WHERE "branch_id" IS NULL;
