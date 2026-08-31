ALTER TABLE "crm"."agency_onboarding_tokens" RENAME TO "organization_invitations";--> statement-breakpoint
ALTER TABLE "crm"."organization_invitations" RENAME COLUMN "contact_email" TO "email";--> statement-breakpoint
ALTER TABLE "crm"."organization_invitations" RENAME COLUMN "used_at" TO "accepted_at";--> statement-breakpoint
ALTER TABLE "crm"."organization_invitations" DROP CONSTRAINT "agency_onboarding_tokens_agency_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "crm"."organization_invitations" DROP CONSTRAINT "agency_onboarding_tokens_resulting_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "crm"."organization_invitations" DROP CONSTRAINT "agency_onboarding_tokens_created_by_users_id_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ix_agency_onboarding_tokens_agency_company_id";--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ux_agency_onboarding_tokens_token_hash";--> statement-breakpoint
ALTER TABLE "crm"."organization_invitations" ADD COLUMN "status" text DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
-- Backfill for any row that already existed under the old
-- agency_onboarding_tokens shape (unlikely - this feature only just
-- shipped - but correct either way): the ADD COLUMN default above gives
-- every existing row 'PENDING', which is wrong for one that was already
-- revoked, already accepted (used_at, now renamed to accepted_at, was
-- set), or already past its expiry - see
-- src/domain/organizationInvitationStatus.ts for why EXPIRED is derived
-- here at migration time for pre-existing rows but never written by the
-- application afterward (new rows are always created PENDING; expiry is
-- computed at read time going forward, not swept by a job).
UPDATE "crm"."organization_invitations" SET "status" = CASE
  WHEN "revoked_at" IS NOT NULL THEN 'REVOKED'
  WHEN "accepted_at" IS NOT NULL THEN 'ACCEPTED'
  WHEN "expires_at" < now() THEN 'EXPIRED'
  ELSE 'PENDING'
END;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."organization_invitations" ADD CONSTRAINT "organization_invitations_agency_company_id_companies_id_fk" FOREIGN KEY ("agency_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."organization_invitations" ADD CONSTRAINT "organization_invitations_resulting_company_id_companies_id_fk" FOREIGN KEY ("resulting_company_id") REFERENCES "crm"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."organization_invitations" ADD CONSTRAINT "organization_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_organization_invitations_agency_company_id" ON "crm"."organization_invitations" USING btree ("agency_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_organization_invitations_token_hash" ON "crm"."organization_invitations" USING btree ("token_hash");--> statement-breakpoint
-- Cosmetic only, same as 0017's rename migration: drizzle-kit's rename
-- detection doesn't touch the primary key constraint's own name, so
-- without this it would linger as "agency_onboarding_tokens_pkey" forever.
ALTER TABLE "crm"."organization_invitations" RENAME CONSTRAINT "agency_onboarding_tokens_pkey" TO "organization_invitations_pkey";