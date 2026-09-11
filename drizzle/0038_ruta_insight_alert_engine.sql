-- RUTA Insight/Alert Engine - a backend detection engine, separate from any
-- LLM, that periodically scans each tenant's own data for operationally
-- meaningful events (uncontacted high-volume leads, overdue follow-ups,
-- sudden campaign performance changes, conversion-rate drops, pipeline
-- risk, unusual lead-volume changes) and pushes a proactive WhatsApp alert
-- to eligible teammates. See src/application/insights/ for the full
-- pipeline: Scheduled Job -> Tenant-scoped Analytics -> Rules/Detection ->
-- Insight Record -> Notification Queue -> WhatsApp.
--
-- Three new tables, plus three new columns on the existing
-- user_whatsapp_links table (idempotent ADD COLUMN IF NOT EXISTS - safe to
-- re-run). All additive; nothing here changes the meaning of an existing
-- column or drops anything.

-- ---------------------------------------------------------------------------
-- ruta_insights - one row per DETECTED event. The (tenant_id, dedupe_key)
-- unique index is the idempotency mechanism for DETECTION itself: the same
-- rule re-firing for the same tenant/entity/period (e.g. the scan running
-- every 30 minutes while a condition remains true) upserts nothing new -
-- see insightStore.ts's use of ON CONFLICT DO NOTHING.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "crm"."ruta_insights" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "severity" text DEFAULT 'warning' NOT NULL,
  "dedupe_key" text NOT NULL,
  "title" text NOT NULL,
  "message" text NOT NULL,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "window_start" timestamp with time zone,
  "window_end" timestamp with time zone,
  "detected_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_insights" ADD CONSTRAINT "ruta_insights_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ruta_insights_tenant_dedupe" ON "crm"."ruta_insights" USING btree ("tenant_id","dedupe_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ruta_insights_tenant_detected_at" ON "crm"."ruta_insights" USING btree ("tenant_id","detected_at");

-- ---------------------------------------------------------------------------
-- ruta_notification_preferences - per (tenant, user). A missing row means
-- "use the defaults" (see notificationPreferences.ts) - a row only exists
-- once a user has actually changed something (muted, adjusted quiet hours,
-- ...), so most tenants never need one.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "crm"."ruta_notification_preferences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "max_per_day" integer DEFAULT 5 NOT NULL,
  "quiet_hours_start_minute" integer,
  "quiet_hours_end_minute" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_notification_preferences" ADD CONSTRAINT "ruta_notification_preferences_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_notification_preferences" ADD CONSTRAINT "ruta_notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ruta_notification_preferences_tenant_user" ON "crm"."ruta_notification_preferences" USING btree ("tenant_id","user_id");

-- ---------------------------------------------------------------------------
-- ruta_notification_queue - one row per (insight, recipient) delivery
-- attempt. The (tenant_id, idempotency_key) unique index (idempotency_key
-- = "<insightId>:<userId>") is what prevents ever double-notifying the
-- same user for the same insight, even if the scan or the QStash delivery
-- message is redelivered - see notificationQueue.ts / notificationDelivery.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "crm"."ruta_notification_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "insight_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "failure_reason" text,
  "qstash_message_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_notification_queue" ADD CONSTRAINT "ruta_notification_queue_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_notification_queue" ADD CONSTRAINT "ruta_notification_queue_insight_id_ruta_insights_id_fk" FOREIGN KEY ("insight_id") REFERENCES "crm"."ruta_insights"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_notification_queue" ADD CONSTRAINT "ruta_notification_queue_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_ruta_notification_queue_tenant_idempotency" ON "crm"."ruta_notification_queue" USING btree ("tenant_id","idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ruta_notification_queue_status_scheduled_for" ON "crm"."ruta_notification_queue" USING btree ("status","scheduled_for");

-- ---------------------------------------------------------------------------
-- user_whatsapp_links additions:
--   - last_inbound_message_at: stamped on every inbound message this user
--     sends the bot (rutaAiAssistant.ts). The notification delivery worker
--     (notificationDelivery.ts) uses this to know whether a proactive alert
--     is still inside Meta's 24-hour customer-service window (free-form
--     text allowed) or would need a pre-approved message template (not yet
--     provisioned - see that file's own comment).
--   - last_insight_id / last_insight_at: the most recent insight actually
--     DELIVERED to this user, so a bare "Why?" reply can retrieve and
--     explain it (see rutaTools.ts's explainLastInsight tool). Deliberately
--     a SEPARATE field from pending_query_context above, which has only a
--     3-minute TTL (disambiguation-only) - an alert can arrive and sit
--     unread for hours before someone asks "why?".
-- ---------------------------------------------------------------------------
ALTER TABLE "crm"."user_whatsapp_links" ADD COLUMN IF NOT EXISTS "last_inbound_message_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "crm"."user_whatsapp_links" ADD COLUMN IF NOT EXISTS "last_insight_id" uuid;
--> statement-breakpoint
ALTER TABLE "crm"."user_whatsapp_links" ADD COLUMN IF NOT EXISTS "last_insight_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."user_whatsapp_links" ADD CONSTRAINT "user_whatsapp_links_last_insight_id_ruta_insights_id_fk" FOREIGN KEY ("last_insight_id") REFERENCES "crm"."ruta_insights"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
