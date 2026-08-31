CREATE TABLE IF NOT EXISTS "crm"."agency_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_company_id" uuid NOT NULL,
	"client_company_id" uuid NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	CONSTRAINT "ck_agency_clients_not_self" CHECK ("crm"."agency_clients"."agency_company_id" <> "crm"."agency_clients"."client_company_id")
);
--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "created_by" uuid;--> statement-breakpoint
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
DO $$ BEGIN
 ALTER TABLE "crm"."companies" ADD CONSTRAINT "companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
