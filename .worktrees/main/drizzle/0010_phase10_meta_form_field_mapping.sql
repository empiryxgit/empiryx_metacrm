-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- Phase 10 - dynamic Meta form field mapping. Every Meta lead form can ask
-- different questions - this adds each form's own question list
-- (meta_forms.questions) and a first-class, admin-editable mapping table
-- (meta_form_field_mappings) that ingestion reads instead of any
-- hard-coded field-name matching. Purely additive: no existing column is
-- touched, no backfill needed - existing meta_forms rows simply start with
-- questions='[]' until their next sync populates it.
-- =============================================================================

ALTER TABLE "crm"."meta_forms" ADD COLUMN "questions" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint

CREATE TABLE "crm"."meta_form_field_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "meta_form_id" uuid NOT NULL,
  "meta_field_key" text NOT NULL,
  "meta_field_label" text NOT NULL,
  "mapping_type" text DEFAULT 'custom' NOT NULL,
  "system_field" text,
  "custom_field_key" text,
  "custom_field_label" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "crm"."meta_form_field_mappings"
  ADD CONSTRAINT "meta_form_field_mappings_tenant_id_companies_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "crm"."meta_form_field_mappings"
  ADD CONSTRAINT "meta_form_field_mappings_meta_form_id_meta_forms_id_fk"
  FOREIGN KEY ("meta_form_id") REFERENCES "crm"."meta_forms"("id") ON DELETE CASCADE;
--> statement-breakpoint

CREATE INDEX "ix_meta_form_field_mappings_tenant_id" ON "crm"."meta_form_field_mappings" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "ix_meta_form_field_mappings_meta_form_id" ON "crm"."meta_form_field_mappings" ("meta_form_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_meta_form_field_mappings_tenant_form_field" ON "crm"."meta_form_field_mappings" ("tenant_id", "meta_form_id", "meta_field_key");
