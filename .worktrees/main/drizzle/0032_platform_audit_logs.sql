CREATE TABLE IF NOT EXISTS "crm"."platform_audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "admin_id" uuid NOT NULL,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" uuid NOT NULL,
  "previous_value" jsonb,
  "new_value" jsonb,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."platform_audit_logs" ADD CONSTRAINT "platform_audit_logs_admin_id_platform_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "crm"."platform_admins"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_audit_logs_admin_id" ON "crm"."platform_audit_logs" USING btree ("admin_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_audit_logs_entity" ON "crm"."platform_audit_logs" USING btree ("entity_type", "entity_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_audit_logs_created_at" ON "crm"."platform_audit_logs" USING btree ("created_at");