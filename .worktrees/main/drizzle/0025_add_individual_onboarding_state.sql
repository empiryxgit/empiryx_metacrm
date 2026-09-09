ALTER TABLE "crm"."companies" ADD COLUMN "onboarding_status" text DEFAULT 'COMPLETED' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."companies" ADD COLUMN "onboarding_step" text;