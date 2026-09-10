ALTER TABLE "crm"."companies" ALTER COLUMN "industry_template" SET DEFAULT 'general';--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "custom_template_config" jsonb;