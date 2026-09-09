ALTER TABLE "crm"."companies" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "lead_terminology" text DEFAULT 'Lead' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "selected_lead_sources" jsonb;