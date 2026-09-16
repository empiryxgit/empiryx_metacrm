-- Remove the Branch feature entirely: the branches/branch_users tables, and
-- the branch_id (+ forms.branch_mode/branch_field_key/branch_field_map)
-- columns on campaigns/leads/forms/form_submissions. Per product decision:
-- leads are already scoped by campaign, so per-branch scoping is redundant
-- overhead. Any existing branch data on any tenant (including data from
-- earlier testing) is intentionally cleared, not preserved.
--
-- SAFE TO RUN ONLY AFTER the corresponding code deploy (which stops
-- reading/writing every one of these columns) is confirmed live. Running
-- this first, while old code from a still-in-progress deploy might still
-- read/write branch_id, would break that old code - see this migration's
-- companion application-code changes for the full removal.

-- ---- Data cleanup (explicit, ahead of the column/table drops below) ----
DELETE FROM "crm"."branch_users";--> statement-breakpoint
UPDATE "crm"."leads" SET "branch_id" = NULL WHERE "branch_id" IS NOT NULL;--> statement-breakpoint
UPDATE "crm"."campaigns" SET "branch_id" = NULL WHERE "branch_id" IS NOT NULL;--> statement-breakpoint
UPDATE "crm"."forms" SET "branch_id" = NULL, "branch_mode" = 'all', "branch_field_key" = NULL, "branch_field_map" = '{}'::jsonb WHERE "branch_id" IS NOT NULL OR "branch_mode" <> 'all' OR "branch_field_key" IS NOT NULL;--> statement-breakpoint
UPDATE "crm"."form_submissions" SET "branch_id" = NULL WHERE "branch_id" IS NOT NULL;--> statement-breakpoint

-- ---- Drop indexes on the columns about to be dropped ----
DROP INDEX IF EXISTS "crm"."ix_campaigns_branch_id";--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ix_form_submissions_branch_id";--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ix_forms_branch_id";--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ix_leads_branch_id";--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ix_leads_company_id_branch_id";--> statement-breakpoint

-- ---- Drop the branch_id (+ form Branch Configuration) columns ----
ALTER TABLE "crm"."campaigns" DROP COLUMN IF EXISTS "branch_id";--> statement-breakpoint
ALTER TABLE "crm"."leads" DROP COLUMN IF EXISTS "branch_id";--> statement-breakpoint
ALTER TABLE "crm"."forms" DROP COLUMN IF EXISTS "branch_id";--> statement-breakpoint
ALTER TABLE "crm"."forms" DROP COLUMN IF EXISTS "branch_mode";--> statement-breakpoint
ALTER TABLE "crm"."forms" DROP COLUMN IF EXISTS "branch_field_key";--> statement-breakpoint
ALTER TABLE "crm"."forms" DROP COLUMN IF EXISTS "branch_field_map";--> statement-breakpoint
ALTER TABLE "crm"."form_submissions" DROP COLUMN IF EXISTS "branch_id";--> statement-breakpoint

-- ---- Drop the branch tables themselves (branch_users first - it FKs into branches) ----
DROP TABLE IF EXISTS "crm"."branch_users";--> statement-breakpoint
DROP TABLE IF EXISTS "crm"."branches";
