-- Adds the composite indexes RUTA's CRM tools (crmTools.ts) and analytics
-- tools (analyticsTools.ts) actually need. Every one of these tools filters
-- leads by "companyId = ? AND metaCreatedAt >= ? AND metaCreatedAt < ?" as
-- its very first predicate (lead counts, campaign/source breakdowns,
-- campaign performance, trend buckets, anomaly detection, date-range
-- aggregation) - before this migration, that column had NO index at all,
-- composite or otherwise (only unrelated columns like pipeline_stage,
-- owner_id, and branch_id were indexed). At this project's current scale
-- this hasn't caused an outage, but it is a real, growing gap: every one
-- of these queries has been doing a full table scan of `leads` per tenant,
-- and RUTA's whole feature area is exactly "ask this question a lot, from
-- WhatsApp, expect a fast reply."
--
-- Purely ADDITIVE: no column, row, table, or existing index/constraint is
-- dropped, altered, or renamed, and no data is touched. Every statement
-- uses IF NOT EXISTS (idempotent/re-runnable). Same lock-window note as
-- migration 0023: these run as plain CREATE INDEX (not CONCURRENTLY)
-- inside drizzle's single migration transaction - see scripts/migrate.ts's
-- own comment on why CONCURRENTLY can't be used here. At this project's
-- current scale (Vercel Hobby + Neon, a handful of tenants) `leads` and
-- `lead_follow_ups` are both small and this finishes well under a second;
-- if either table ever grows large enough for the SHARE-lock window to
-- matter, create the index CONCURRENTLY by hand outside a transaction
-- instead of relying on this migration file for that specific statement.

CREATE INDEX IF NOT EXISTS "ix_leads_company_id_meta_created_at" ON "crm"."leads" USING btree ("company_id","meta_created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_company_id_next_follow_up_at" ON "crm"."leads" USING btree ("company_id","next_follow_up_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_leads_company_id_owner_id" ON "crm"."leads" USING btree ("company_id","owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_lead_follow_ups_company_id_created_by_created_at" ON "crm"."lead_follow_ups" USING btree ("company_id","created_by","created_at");
