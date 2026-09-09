CREATE TABLE IF NOT EXISTS "crm"."lead_follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"remarks" text NOT NULL,
	"outcome" text,
	"next_follow_up_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "crm"."leads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."lead_follow_ups" ADD CONSTRAINT "lead_follow_ups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_lead_follow_ups_lead_id" ON "crm"."lead_follow_ups" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_lead_follow_ups_company_id" ON "crm"."lead_follow_ups" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_lead_follow_ups_created_at" ON "crm"."lead_follow_ups" USING btree ("created_at");