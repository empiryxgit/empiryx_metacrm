ALTER TABLE "crm"."meta_whatsapp_accounts" ADD COLUMN "webhook_subscribed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."meta_whatsapp_accounts" ADD COLUMN "webhook_status" text;--> statement-breakpoint
ALTER TABLE "crm"."meta_whatsapp_accounts" ADD COLUMN "webhook_last_error" text;--> statement-breakpoint
ALTER TABLE "crm"."meta_whatsapp_accounts" ADD COLUMN "webhook_last_verified_at" timestamp with time zone;