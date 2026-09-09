CREATE TABLE IF NOT EXISTS "crm"."platform_notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "created_by" uuid NOT NULL,
  "target_type" text NOT NULL,
  "target_company_id" uuid,
  "target_user_id" uuid,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "cta_label" text,
  "cta_url" text,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."platform_notifications" ADD CONSTRAINT "platform_notifications_created_by_platform_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "crm"."platform_admins"("id") ON DELETE restrict ON UPDATE no action;
 ALTER TABLE "crm"."platform_notifications" ADD CONSTRAINT "platform_notifications_target_company_id_companies_id_fk" FOREIGN KEY ("target_company_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
 ALTER TABLE "crm"."platform_notifications" ADD CONSTRAINT "platform_notifications_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_notifications_company_id" ON "crm"."platform_notifications" USING btree ("target_company_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_notifications_user_id" ON "crm"."platform_notifications" USING btree ("target_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_notifications_published_at" ON "crm"."platform_notifications" USING btree ("published_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crm"."platform_notification_reads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "notification_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "read_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."platform_notification_reads" ADD CONSTRAINT "platform_notification_reads_notification_id_platform_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "crm"."platform_notifications"("id") ON DELETE cascade ON UPDATE no action;
 ALTER TABLE "crm"."platform_notification_reads" ADD CONSTRAINT "platform_notification_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_platform_notification_reads_notification_user" ON "crm"."platform_notification_reads" USING btree ("notification_id", "user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_platform_notification_reads_user_id" ON "crm"."platform_notification_reads" USING btree ("user_id");