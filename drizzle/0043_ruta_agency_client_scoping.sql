-- RUTA WhatsApp query bot: Agency vs Individual client scoping (see
-- claude/whatsapp-agency-vs-individual-query-scoping.md). Adds the ONE new
-- column this feature needs - a per-conversation "which client is this
-- Agency account currently asking about" pointer, the WhatsApp equivalent
-- of the web app's client-context cookie (agencyClientContext.ts). Always
-- null for an Individual account's conversations; never trusted on its own
-- once set (re-validated on every message that uses it - see
-- rutaAgencyClientScoping.ts).
--
-- Guarded (IF NOT EXISTS / duplicate_object exception block) the same way
-- every migration since 0021/the 42701 incident is - safe to run against a
-- database in any state, including one where this migration partially
-- applied already.
ALTER TABLE "crm"."ruta_conversations" ADD COLUMN IF NOT EXISTS "active_client_company_id" uuid;--> statement-breakpoint
DO $$
BEGIN
  ALTER TABLE "crm"."ruta_conversations" ADD CONSTRAINT "ruta_conversations_active_client_company_id_companies_id_fk" FOREIGN KEY ("active_client_company_id") REFERENCES "crm"."companies"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
