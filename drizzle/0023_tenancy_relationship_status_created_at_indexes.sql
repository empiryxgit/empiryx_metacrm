-- Hardening pass over the tenancy/relationship tables (companies = this
-- codebase's "organizations"; agency_clients = "organization_relationships";
-- organization_invitations, roles, users unchanged in name). Every
-- statement below is purely ADDITIVE: no column, row, table, or existing
-- index/constraint is dropped, altered, or renamed, and no data is
-- deleted. Safe to run against production - each CREATE INDEX uses
-- IF NOT EXISTS (idempotent/re-runnable), and the one new UNIQUE index
-- (statement 8 below) is preceded by a non-destructive data-cleanup step
-- so it cannot fail against pre-existing data (see that step's own
-- comment).
--
-- Lock note for a larger production table: these are plain CREATE INDEX
-- statements (not CONCURRENTLY) because drizzle's migrator runs every
-- migration file inside one transaction, and CREATE INDEX CONCURRENTLY
-- cannot run inside a transaction block (see scripts/migrate.ts's own
-- comment on why). A plain CREATE INDEX takes a SHARE lock for its
-- duration - it blocks concurrent WRITES to that table (reads are
-- unaffected) but does not block them indefinitely. At this project's
-- current scale (Vercel Hobby + Neon, a handful of tenants) every table
-- below is small and this finishes in well under a second. If any of
-- these tables ever grow large enough for that lock window to matter,
-- create the index CONCURRENTLY by hand outside a transaction instead of
-- relying on this migration file for that specific statement.
--
-- No new "permissions" table: this schema's role permissions already live
-- as a jsonb string[] on roles.permissions (see roles table below and
-- src/domain/permissions.ts's own header comment), checked in application
-- code, never queried by permission content in SQL (no WHERE/@> on that
-- column anywhere in this codebase) - there is nothing to index there,
-- and normalizing it into a relational permissions/role_permissions
-- table would be a materially larger, app-code-touching change than
-- "modify existing tables only where necessary." Happy to build that out
-- as a separate, deliberate migration if it's actually wanted.

CREATE INDEX IF NOT EXISTS "ix_agency_client_assignments_created_at" ON "crm"."agency_client_assignments" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_clients_status" ON "crm"."agency_clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_agency_clients_created_at" ON "crm"."agency_clients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_companies_status" ON "crm"."companies" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_companies_created_at" ON "crm"."companies" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_organization_invitations_status" ON "crm"."organization_invitations" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_organization_invitations_created_at" ON "crm"."organization_invitations" USING btree ("created_at");--> statement-breakpoint
-- Data-cleanup step, required before the unique index below can be
-- created safely: generateOnboardingLink (src/application/
-- agencyOnboarding.ts) never guarded against the same agency generating a
-- second still-outstanding invite to the same email while an earlier one
-- is still PENDING, so production may already hold duplicate (agency,
-- email) PENDING rows. This UPDATEs status only - it NEVER deletes a
-- row - keeping the newest PENDING row per (agency_company_id, email)
-- pair exactly as-is, and marking any OLDER duplicates REVOKED (with
-- revoked_at backfilled to "now" only where it was not already set).
-- Affects zero rows, harmlessly, on a database with no such duplicates.
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY agency_company_id, email
    ORDER BY created_at DESC, id DESC
  ) AS rn
  FROM "crm"."organization_invitations"
  WHERE status = 'PENDING'
)
UPDATE "crm"."organization_invitations" AS oi
SET status = 'REVOKED', revoked_at = COALESCE(oi.revoked_at, now())
FROM ranked
WHERE oi.id = ranked.id AND ranked.rn > 1;--> statement-breakpoint
-- At most one PENDING invitation per (agency, email) going forward -
-- ACCEPTED/EXPIRED/REVOKED rows are exempt and keep accumulating as
-- history exactly as before. Same partial-unique-index idiom this schema
-- already uses for "at most one active X" (see
-- ux_agency_clients_one_claimed_agency_per_client /
-- ux_meta_connections_one_active_per_tenant).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_organization_invitations_one_pending_per_agency_email" ON "crm"."organization_invitations" USING btree ("agency_company_id","email") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_roles_created_at" ON "crm"."roles" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_users_status" ON "crm"."users" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_users_created_at" ON "crm"."users" USING btree ("created_at");
