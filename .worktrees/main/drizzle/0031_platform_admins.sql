CREATE TABLE IF NOT EXISTS "crm"."platform_admins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "full_name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_login_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_platform_admins_email" ON "crm"."platform_admins" USING btree ("email");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_admins_status" ON "crm"."platform_admins" USING btree ("status");
