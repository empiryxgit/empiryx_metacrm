CREATE TABLE IF NOT EXISTS "crm"."password_reset_tokens" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "crm"."password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "crm"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_password_reset_tokens_user_id" ON "crm"."password_reset_tokens" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ux_password_reset_tokens_token_hash" ON "crm"."password_reset_tokens" USING btree ("token_hash");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_password_reset_tokens_created_at" ON "crm"."password_reset_tokens" USING btree ("created_at");
