CREATE TABLE IF NOT EXISTS "crm"."form_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"field_type" text NOT NULL,
	"mapping_type" text DEFAULT 'custom' NOT NULL,
	"system_field" text,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"placeholder" text,
	"help_text" text,
	"default_value" text,
	"required" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"conditional" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"lead_id" uuid,
	"schema_version" integer NOT NULL,
	"fields_snapshot" jsonb NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"channel" text DEFAULT 'internal' NOT NULL,
	"submitter_ip" text,
	"submitter_user_agent" text,
	"status" text DEFAULT 'received' NOT NULL,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" text DEFAULT 'internal' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"public_key" text,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."form_fields" ADD CONSTRAINT "form_fields_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "crm"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "crm"."forms"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."form_submissions" ADD CONSTRAINT "form_submissions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."form_submissions" ADD CONSTRAINT "form_submissions_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "crm"."leads"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."forms" ADD CONSTRAINT "forms_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."forms" ADD CONSTRAINT "forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_form_fields_form_id" ON "crm"."form_fields" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_form_fields_form_id_position" ON "crm"."form_fields" USING btree ("form_id","position");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_form_submissions_form_id" ON "crm"."form_submissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_form_submissions_company_id" ON "crm"."form_submissions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_form_submissions_created_at" ON "crm"."form_submissions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_forms_company_id" ON "crm"."forms" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_forms_public_key" ON "crm"."forms" USING btree ("public_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_forms_company_id_type" ON "crm"."forms" USING btree ("company_id","type");