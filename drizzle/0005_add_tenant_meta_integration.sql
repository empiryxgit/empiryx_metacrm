CREATE TABLE IF NOT EXISTS "crm"."meta_ad_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_connection_id" uuid NOT NULL,
	"ad_account_id" text NOT NULL,
	"name" text NOT NULL,
	"is_selected" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."meta_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"access_token_encrypted" text NOT NULL,
	"token_expires_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."meta_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"form_id" text NOT NULL,
	"form_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."meta_lead_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"leadgen_id" text NOT NULL,
	"page_id" text,
	"form_id" text,
	"ad_id" text,
	"adset_id" text,
	"campaign_id" text,
	"raw_payload" jsonb NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."meta_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_connection_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"page_name" text NOT NULL,
	"page_access_token_encrypted" text NOT NULL,
	"instagram_business_account_id" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"webhook_subscribed" boolean DEFAULT false NOT NULL,
	"webhook_status" text DEFAULT 'pending' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "crm"."campaigns" ADD COLUMN "source" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "crm"."campaigns" ADD COLUMN "meta_campaign_id" text;--> statement-breakpoint
ALTER TABLE "crm"."campaigns" ADD COLUMN "meta_ad_account_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_ad_accounts" ADD CONSTRAINT "meta_ad_accounts_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_ad_accounts" ADD CONSTRAINT "meta_ad_accounts_meta_connection_id_meta_connections_id_fk" FOREIGN KEY ("meta_connection_id") REFERENCES "crm"."meta_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_connections" ADD CONSTRAINT "meta_connections_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_forms" ADD CONSTRAINT "meta_forms_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_events" ADD CONSTRAINT "meta_lead_events_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_pages" ADD CONSTRAINT "meta_pages_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_pages" ADD CONSTRAINT "meta_pages_meta_connection_id_meta_connections_id_fk" FOREIGN KEY ("meta_connection_id") REFERENCES "crm"."meta_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_ad_accounts_tenant_id" ON "crm"."meta_ad_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_ad_accounts_meta_connection_id" ON "crm"."meta_ad_accounts" USING btree ("meta_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_ad_accounts_tenant_account" ON "crm"."meta_ad_accounts" USING btree ("tenant_id","ad_account_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_connections_tenant_id" ON "crm"."meta_connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_connections_one_active_per_tenant" ON "crm"."meta_connections" USING btree ("tenant_id") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_forms_tenant_id" ON "crm"."meta_forms" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_forms_page_id" ON "crm"."meta_forms" USING btree ("page_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_forms_tenant_form" ON "crm"."meta_forms" USING btree ("tenant_id","form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_lead_events_tenant_id" ON "crm"."meta_lead_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_lead_events_status_received_at" ON "crm"."meta_lead_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_lead_events_page_id" ON "crm"."meta_lead_events" USING btree ("page_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_lead_events_form_id" ON "crm"."meta_lead_events" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_lead_events_tenant_leadgen" ON "crm"."meta_lead_events" USING btree ("tenant_id","leadgen_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_pages_tenant_id" ON "crm"."meta_pages" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_pages_meta_connection_id" ON "crm"."meta_pages" USING btree ("meta_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_pages_tenant_page" ON "crm"."meta_pages" USING btree ("tenant_id","page_id");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."campaigns" ADD CONSTRAINT "campaigns_meta_ad_account_id_meta_ad_accounts_id_fk" FOREIGN KEY ("meta_ad_account_id") REFERENCES "crm"."meta_ad_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_campaigns_meta_campaign_id" ON "crm"."campaigns" USING btree ("meta_campaign_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_campaigns_meta_ad_account_id" ON "crm"."campaigns" USING btree ("meta_ad_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_campaigns_tenant_meta_campaign" ON "crm"."campaigns" USING btree ("company_id","meta_campaign_id") WHERE meta_campaign_id is not null;