CREATE TABLE IF NOT EXISTS "crm"."meta_ad_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"meta_ad_account_id" uuid,
	"ad_set_id" text NOT NULL,
	"ad_set_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."meta_ads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ad_set_id" uuid NOT NULL,
	"ad_id" text NOT NULL,
	"ad_name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."meta_instagram_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"meta_connection_id" uuid NOT NULL,
	"page_id" text NOT NULL,
	"instagram_account_id" text NOT NULL,
	"username" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_ad_sets" ADD CONSTRAINT "meta_ad_sets_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_ad_sets" ADD CONSTRAINT "meta_ad_sets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "crm"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_ad_sets" ADD CONSTRAINT "meta_ad_sets_meta_ad_account_id_meta_ad_accounts_id_fk" FOREIGN KEY ("meta_ad_account_id") REFERENCES "crm"."meta_ad_accounts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_ads" ADD CONSTRAINT "meta_ads_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_ads" ADD CONSTRAINT "meta_ads_ad_set_id_meta_ad_sets_id_fk" FOREIGN KEY ("ad_set_id") REFERENCES "crm"."meta_ad_sets"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_instagram_accounts" ADD CONSTRAINT "meta_instagram_accounts_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."meta_instagram_accounts" ADD CONSTRAINT "meta_instagram_accounts_meta_connection_id_meta_connections_id_fk" FOREIGN KEY ("meta_connection_id") REFERENCES "crm"."meta_connections"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_ad_sets_tenant_id" ON "crm"."meta_ad_sets" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_ad_sets_campaign_id" ON "crm"."meta_ad_sets" USING btree ("campaign_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_ad_sets_tenant_ad_set" ON "crm"."meta_ad_sets" USING btree ("tenant_id","ad_set_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_ads_tenant_id" ON "crm"."meta_ads" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_ads_ad_set_id" ON "crm"."meta_ads" USING btree ("ad_set_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_ads_tenant_ad" ON "crm"."meta_ads" USING btree ("tenant_id","ad_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_instagram_accounts_tenant_id" ON "crm"."meta_instagram_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_meta_instagram_accounts_meta_connection_id" ON "crm"."meta_instagram_accounts" USING btree ("meta_connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_instagram_accounts_tenant_account" ON "crm"."meta_instagram_accounts" USING btree ("tenant_id","instagram_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_instagram_accounts_one_selected_per_tenant" ON "crm"."meta_instagram_accounts" USING btree ("tenant_id") WHERE is_selected = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_ad_accounts_one_selected_per_tenant" ON "crm"."meta_ad_accounts" USING btree ("tenant_id") WHERE is_selected = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_meta_pages_one_selected_per_tenant" ON "crm"."meta_pages" USING btree ("tenant_id") WHERE is_selected = true;