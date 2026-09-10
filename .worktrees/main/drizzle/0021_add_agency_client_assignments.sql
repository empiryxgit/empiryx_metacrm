CREATE TABLE IF NOT EXISTS "crm"."agency_client_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_company_id" uuid NOT NULL,
	"client_company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_client_assignments" ADD CONSTRAINT "agency_client_assignments_agency_company_id_companies_id_fk" FOREIGN KEY ("agency_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_client_assignments" ADD CONSTRAINT "agency_client_assignments_client_company_id_companies_id_fk" FOREIGN KEY ("client_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_client_assignments" ADD CONSTRAINT "agency_client_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_client_assignments" ADD CONSTRAINT "agency_client_assignments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_client_assignments_agency_company_id" ON "crm"."agency_client_assignments" USING btree ("agency_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_client_assignments_user_id" ON "crm"."agency_client_assignments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_client_assignments_client_company_id" ON "crm"."agency_client_assignments" USING btree ("client_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_agency_client_assignments_user_client" ON "crm"."agency_client_assignments" USING btree ("user_id","client_company_id");