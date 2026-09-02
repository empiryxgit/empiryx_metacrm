CREATE TABLE IF NOT EXISTS "crm"."meta_lead_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_connection_id" uuid,
	"meta_ad_account_id" uuid,
	"meta_campaign_id" uuid,
	"meta_ad_set_id" uuid,
	"meta_ad_id" uuid NOT NULL,
	"approach" text DEFAULT 'unknown' NOT NULL,
	"confidence" text DEFAULT 'UNDETERMINED' NOT NULL,
	"form_id" text,
	"whatsapp_account_id" uuid,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."meta_whatsapp_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_connection_id" uuid NOT NULL,
	"waba_id" text NOT NULL,
	"waba_name" text,
	"phone_number_id" text NOT NULL,
	"display_phone_number" text,
	"verified_name" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."whatsapp_message_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"wa_message_id" text NOT NULL,
	"waba_id" text,
	"phone_number_id" text,
	"from_phone_number" text,
	"contact_name" text,
	"message_type" text,
	"message_text" text,
	"referral" jsonb,
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
ALTER TABLE "crm"."leads" ADD COLUMN "lead_approach" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_routes" ADD CONSTRAINT "meta_lead_routes_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_routes" ADD CONSTRAINT "meta_lead_routes_meta_connection_id_meta_connections_id_fk" FOREIGN KEY ("meta_connection_id") REFERENCES "crm"."meta_connections"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_routes" ADD CONSTRAINT "meta_lead_routes_meta_ad_account_id_meta_ad_accounts_id_fk" FOREIGN KEY ("meta_ad_account_id") REFERENCES "crm"."meta_ad_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_routes" ADD CONSTRAINT "meta_lead_routes_meta_campaign_id_meta_campaigns_id_fk" FOREIGN KEY ("meta_campaign_id") REFERENCES "crm"."meta_campaigns"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_routes" ADD CONSTRAINT "meta_lead_routes_meta_ad_set_id_meta_ad_sets_id_fk" FOREIGN KEY ("meta_ad_set_id") REFERENCES "crm"."meta_ad_sets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_routes" ADD CONSTRAINT "meta_lead_routes_meta_ad_id_meta_ads_id_fk" FOREIGN KEY ("meta_ad_id") REFERENCES "crm"."meta_ads"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_lead_routes" ADD CONSTRAINT "meta_lead_routes_whatsapp_account_id_meta_whatsapp_accounts_id_fk" FOREIGN KEY ("whatsapp_account_id") REFERENCES "crm"."meta_whatsapp_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_whatsapp_accounts" ADD CONSTRAINT "meta_whatsapp_accounts_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_whatsapp_accounts" ADD CONSTRAINT "meta_whatsapp_accounts_meta_connection_id_meta_connections_id_fk" FOREIGN KEY ("meta_connection_id") REFERENCES "crm"."meta_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."whatsapp_message_events" ADD CONSTRAINT "whatsapp_message_events_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_lead_routes_tenant_id" ON "crm"."meta_lead_routes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_lead_routes_approach" ON "crm"."meta_lead_routes" USING btree ("approach");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_lead_routes_tenant_ad" ON "crm"."meta_lead_routes" USING btree ("tenant_id","meta_ad_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_whatsapp_accounts_tenant_id" ON "crm"."meta_whatsapp_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_whatsapp_accounts_meta_connection_id" ON "crm"."meta_whatsapp_accounts" USING btree ("meta_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_whatsapp_accounts_tenant_phone_number" ON "crm"."meta_whatsapp_accounts" USING btree ("tenant_id","phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_whatsapp_accounts_one_selected_per_tenant" ON "crm"."meta_whatsapp_accounts" USING btree ("tenant_id") WHERE is_selected = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_whatsapp_message_events_tenant_id" ON "crm"."whatsapp_message_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_whatsapp_message_events_status_received_at" ON "crm"."whatsapp_message_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_whatsapp_message_events_phone_number_id" ON "crm"."whatsapp_message_events" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_whatsapp_message_events_tenant_message" ON "crm"."whatsapp_message_events" USING btree ("tenant_id","wa_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_lead_approach" ON "crm"."leads" USING btree ("lead_approach");