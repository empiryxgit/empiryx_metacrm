-- RUTA Conversation Context (Phase F) - the WhatsApp AI Assistant's own
-- conversation state, kept separate from every CRM table (leads,
-- campaigns, pipeline, ...). Two new tables:
--   - ruta_conversations: one row per conversation "thread" for a
--     (tenant_id, user_id) pair, holding the single-slot disambiguation/
--     date-range-anchor pointer a follow-up resolves against (relocated
--     from user_whatsapp_links.pending_query_context - that column is left
--     in place, unused, rather than dropped here).
--   - ruta_conversation_turns: an append-only, bounded (pruned in the
--     application layer - see rutaConversation.ts's MAX_TURNS_PER_
--     CONVERSATION) log of what was actually asked/answered, scoped by
--     conversation_id AND tenant_id AND user_id together.
-- All additive; nothing here changes the meaning of an existing column or
-- drops anything. See src/infrastructure/db/schema.ts's own comment on
-- this section for the full design rationale.

-- ---------------------------------------------------------------------------
-- ruta_conversations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "crm"."ruta_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "phone_number" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
  "idle_expires_at" timestamp with time zone NOT NULL,
  "pending_context" jsonb,
  "pending_context_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_conversations" ADD CONSTRAINT "ruta_conversations_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_conversations" ADD CONSTRAINT "ruta_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ruta_conversations_tenant_user_activity" ON "crm"."ruta_conversations" ("tenant_id","user_id","last_activity_at");
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ruta_conversation_turns
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "crm"."ruta_conversation_turns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "tool_name" text NOT NULL,
  "session_role" text,
  "range_start_at" timestamp with time zone,
  "range_end_at" timestamp with time zone,
  "range_label" text,
  "user_message_excerpt" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_conversation_turns" ADD CONSTRAINT "ruta_conversation_turns_conversation_id_ruta_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "crm"."ruta_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_conversation_turns" ADD CONSTRAINT "ruta_conversation_turns_tenant_id_companies_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."ruta_conversation_turns" ADD CONSTRAINT "ruta_conversation_turns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ruta_conversation_turns_conversation_created_at" ON "crm"."ruta_conversation_turns" ("conversation_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_ruta_conversation_turns_tenant_user_created_at" ON "crm"."ruta_conversation_turns" ("tenant_id","user_id","created_at");
