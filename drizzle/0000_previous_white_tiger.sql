CREATE SCHEMA "crm";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"platform" text DEFAULT 'facebook' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"industry" text,
	"company_size" text,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."lead_processing_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"lead_id" uuid,
	"raw_event_id" uuid,
	"event_type" text NOT NULL,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"crm_campaign_id" uuid,
	"meta_lead_id" text NOT NULL,
	"platform" text NOT NULL,
	"page_id" text NOT NULL,
	"form_id" text NOT NULL,
	"form_name" text,
	"ad_id" text,
	"ad_name" text,
	"ad_set_id" text,
	"ad_set_name" text,
	"campaign_id" text,
	"campaign_name" text,
	"full_name" text,
	"email" text,
	"phone_number" text,
	"form_responses" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta_created_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"pipeline_stage" text DEFAULT 'new' NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"processed_at" timestamp with time zone,
	"recovered_by_reconciliation" boolean DEFAULT false NOT NULL,
	"raw_event_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."raw_meta_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"campaign_id" uuid,
	"object_type" text NOT NULL,
	"raw_payload" jsonb NOT NULL,
	"signature_header" text,
	"meta_lead_id" text,
	"page_id" text,
	"form_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"enqueued_at" timestamp with time zone,
	"enqueue_error" text,
	"qstash_message_id" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lead_id" uuid
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."reconciliation_runs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid,
	"campaign_id" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"forms_scanned" integer DEFAULT 0 NOT NULL,
	"meta_leads_seen" integer DEFAULT 0 NOT NULL,
	"missing_leads_found" integer DEFAULT 0 NOT NULL,
	"missing_leads_recovered" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permissions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"full_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"must_change_password" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."webhook_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"verify_token" text NOT NULL,
	"app_secret_encrypted" text NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"page_id" text,
	"form_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."campaigns" ADD CONSTRAINT "campaigns_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."leads" ADD CONSTRAINT "leads_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."leads" ADD CONSTRAINT "leads_crm_campaign_id_campaigns_id_fk" FOREIGN KEY ("crm_campaign_id") REFERENCES "crm"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."raw_meta_events" ADD CONSTRAINT "raw_meta_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."raw_meta_events" ADD CONSTRAINT "raw_meta_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "crm"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."reconciliation_runs" ADD CONSTRAINT "reconciliation_runs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "crm"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."roles" ADD CONSTRAINT "roles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "crm"."roles"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."webhook_configs" ADD CONSTRAINT "webhook_configs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "crm"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."webhook_configs" ADD CONSTRAINT "webhook_configs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_campaigns_company_id" ON "crm"."campaigns" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_campaigns_status" ON "crm"."campaigns" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_companies_slug" ON "crm"."companies" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_lead_processing_log_lead_id" ON "crm"."lead_processing_log" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_lead_processing_log_occurred_at" ON "crm"."lead_processing_log" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_leads_meta_lead_id" ON "crm"."leads" USING btree ("meta_lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_status" ON "crm"."leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_form_id" ON "crm"."leads" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_campaign_id" ON "crm"."leads" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_created_at" ON "crm"."leads" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_crm_campaign_id" ON "crm"."leads" USING btree ("crm_campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_pipeline_stage" ON "crm"."leads" USING btree ("pipeline_stage");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_raw_meta_events_meta_lead_id" ON "crm"."raw_meta_events" USING btree ("meta_lead_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_raw_meta_events_status_received_at" ON "crm"."raw_meta_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_raw_meta_events_campaign_id" ON "crm"."raw_meta_events" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_roles_company_name" ON "crm"."roles" USING btree ("company_id","name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_roles_company_id" ON "crm"."roles" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_sessions_user_id" ON "crm"."sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_users_email" ON "crm"."users" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_users_company_id" ON "crm"."users" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_webhook_configs_campaign_id" ON "crm"."webhook_configs" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_webhook_configs_slug" ON "crm"."webhook_configs" USING btree ("slug");