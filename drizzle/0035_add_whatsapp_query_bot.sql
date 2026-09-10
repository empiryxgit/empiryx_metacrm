-- Internal WhatsApp Query Bot - RUTA's own users querying the CRM from
-- their phone (not leads, never customer-facing). See
-- claude/whatsapp-internal-query-bot-flow.md (CRM Automation project).
--
-- whatsapp_link_codes: short-lived one-time codes issued from Settings ->
-- Link WhatsApp, redeemed by texting "LINK <code>" to the tenant's
-- WhatsApp number.
CREATE TABLE IF NOT EXISTS "crm"."whatsapp_link_codes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "code" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "consumed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."whatsapp_link_codes" ADD CONSTRAINT "whatsapp_link_codes_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."whatsapp_link_codes" ADD CONSTRAINT "whatsapp_link_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_whatsapp_link_codes_code" ON "crm"."whatsapp_link_codes" USING btree ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_whatsapp_link_codes_user_id" ON "crm"."whatsapp_link_codes" USING btree ("user_id");
--> statement-breakpoint
-- user_whatsapp_links: the verified binding a redeemed code produces.
-- Both unique indexes together are the identity guarantee this whole
-- feature depends on - one CRM identity per WhatsApp number, one linked
-- number per user, both scoped per tenant.
CREATE TABLE IF NOT EXISTS "crm"."user_whatsapp_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "phone_number" text NOT NULL,
  "pending_query_context" jsonb,
  "pending_query_context_expires_at" timestamp with time zone,
  "linked_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."user_whatsapp_links" ADD CONSTRAINT "user_whatsapp_links_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."user_whatsapp_links" ADD CONSTRAINT "user_whatsapp_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_user_whatsapp_links_tenant_phone" ON "crm"."user_whatsapp_links" USING btree ("tenant_id","phone_number");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_user_whatsapp_links_tenant_user" ON "crm"."user_whatsapp_links" USING btree ("tenant_id","user_id");
