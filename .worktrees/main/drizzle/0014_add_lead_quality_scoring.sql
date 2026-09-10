ALTER TABLE "crm"."leads" ADD COLUMN "quality_score" integer;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "quality_label" text;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "quality_flags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."leads" ADD COLUMN "quality_scored_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_company_id_phone_number" ON "crm"."leads" USING btree ("company_id","phone_number");