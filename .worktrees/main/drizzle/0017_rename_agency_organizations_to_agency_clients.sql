ALTER TABLE "crm"."agency_organizations" RENAME TO "agency_clients";--> statement-breakpoint
-- drizzle-kit's own rename diff leaves the primary key carrying the old
-- table name (cosmetic only - it still functions - but renamed here for
-- consistency with every other constraint/index below).
ALTER TABLE "crm"."agency_clients" RENAME CONSTRAINT "agency_organizations_pkey" TO "agency_clients_pkey";--> statement-breakpoint
ALTER TABLE "crm"."agency_clients" DROP CONSTRAINT "ck_agency_organizations_not_self";--> statement-breakpoint
ALTER TABLE "crm"."agency_clients" DROP CONSTRAINT "agency_organizations_agency_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "crm"."agency_clients" DROP CONSTRAINT "agency_organizations_client_company_id_companies_id_fk";
--> statement-breakpoint
ALTER TABLE "crm"."agency_clients" DROP CONSTRAINT "agency_organizations_created_by_users_id_fk";
--> statement-breakpoint
-- drizzle-kit generates these unqualified, which silently no-ops against
-- the default search_path ("$user", public) instead of dropping the actual
-- crm-schema index - schema-qualified by hand so the old objects are
-- actually removed instead of orphaned alongside their renamed replacements.
DROP INDEX IF EXISTS "crm"."ix_agency_organizations_agency_company_id";--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ix_agency_organizations_client_company_id";--> statement-breakpoint
DROP INDEX IF EXISTS "crm"."ux_agency_organizations_one_active_per_client";--> statement-breakpoint
ALTER TABLE "crm"."agency_clients" ALTER COLUMN "status" SET DEFAULT 'invited';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_clients" ADD CONSTRAINT "agency_clients_agency_company_id_companies_id_fk" FOREIGN KEY ("agency_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_clients" ADD CONSTRAINT "agency_clients_client_company_id_companies_id_fk" FOREIGN KEY ("client_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_clients" ADD CONSTRAINT "agency_clients_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_clients_agency_company_id" ON "crm"."agency_clients" USING btree ("agency_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_clients_client_company_id" ON "crm"."agency_clients" USING btree ("client_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_agency_clients_agency_client" ON "crm"."agency_clients" USING btree ("agency_company_id","client_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_agency_clients_one_claimed_agency_per_client" ON "crm"."agency_clients" USING btree ("client_company_id") WHERE status IN ('invited', 'pending', 'active', 'suspended');--> statement-breakpoint
ALTER TABLE "crm"."agency_clients" ADD CONSTRAINT "ck_agency_clients_not_self" CHECK ("crm"."agency_clients"."agency_company_id" <> "crm"."agency_clients"."client_company_id");