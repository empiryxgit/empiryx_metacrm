ALTER TABLE "crm"."leads" ALTER COLUMN "platform" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."leads" ALTER COLUMN "page_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."leads" ALTER COLUMN "form_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."leads" ALTER COLUMN "raw_event_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "industry_template" text DEFAULT 'real_estate' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "source" text DEFAULT 'meta_lead_ads' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "lead_type" text DEFAULT 'digital_lead' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "owner_id" uuid;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "next_follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."leads" ADD CONSTRAINT "leads_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_lead_type" ON "crm"."leads" USING btree ("lead_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_owner_id" ON "crm"."leads" USING btree ("owner_id");