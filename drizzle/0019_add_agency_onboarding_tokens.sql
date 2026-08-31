CREATE TABLE IF NOT EXISTS "crm"."agency_onboarding_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agency_company_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"client_name" text NOT NULL,
	"contact_email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"resulting_company_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_onboarding_tokens" ADD CONSTRAINT "agency_onboarding_tokens_agency_company_id_companies_id_fk" FOREIGN KEY ("agency_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_onboarding_tokens" ADD CONSTRAINT "agency_onboarding_tokens_resulting_company_id_companies_id_fk" FOREIGN KEY ("resulting_company_id") REFERENCES "crm"."companies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."agency_onboarding_tokens" ADD CONSTRAINT "agency_onboarding_tokens_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_onboarding_tokens_agency_company_id" ON "crm"."agency_onboarding_tokens" USING btree ("agency_company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_agency_onboarding_tokens_token_hash" ON "crm"."agency_onboarding_tokens" USING btree ("token_hash");