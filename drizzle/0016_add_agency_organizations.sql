CREATE TABLE IF NOT EXISTS "crm"."agency_organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_company_id" uuid NOT NULL,
	"client_company_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ck_agency_organizations_not_self" CHECK ("crm"."agency_organizations"."agency_company_id" <> "crm"."agency_organizations"."client_company_id")
);
--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "created_by" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_organizations" ADD CONSTRAINT "agency_organizations_agency_company_id_companies_id_fk" FOREIGN KEY ("agency_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_organizations" ADD CONSTRAINT "agency_organizations_client_company_id_companies_id_fk" FOREIGN KEY ("client_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_organizations" ADD CONSTRAINT "agency_organizations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_organizations_agency_company_id" ON "crm"."agency_organizations" USING btree ("agency_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_organizations_client_company_id" ON "crm"."agency_organizations" USING btree ("client_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_agency_organizations_one_active_per_client" ON "crm"."agency_organizations" USING btree ("client_company_id") WHERE status = 'active';--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD CONSTRAINT "companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
