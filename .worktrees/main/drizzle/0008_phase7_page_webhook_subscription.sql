ALTER TABLE "crm"."meta_pages" ADD COLUMN "webhook_last_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "crm"."meta_pages" ADD COLUMN "webhook_last_error" text;