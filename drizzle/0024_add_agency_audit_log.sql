CREATE TABLE IF NOT EXISTS "crm"."agency_audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"agency_company_id" uuid NOT NULL,
	"agency_user_id" uuid,
	"client_company_id" uuid,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_audit_log" ADD CONSTRAINT "agency_audit_log_agency_company_id_companies_id_fk" FOREIGN KEY ("agency_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_audit_log" ADD CONSTRAINT "agency_audit_log_agency_user_id_users_id_fk" FOREIGN KEY ("agency_user_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_audit_log" ADD CONSTRAINT "agency_audit_log_client_company_id_companies_id_fk" FOREIGN KEY ("client_company_id") REFERENCES "crm"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_audit_log_agency_company_id" ON "crm"."agency_audit_log" USING btree ("agency_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_audit_log_client_company_id" ON "crm"."agency_audit_log" USING btree ("client_company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_audit_log_action" ON "crm"."agency_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_audit_log_created_at" ON "crm"."agency_audit_log" USING btree ("created_at");