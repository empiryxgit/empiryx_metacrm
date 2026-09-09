-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- Phase 9 - separate the CRM Campaign (internal business object) from the
-- Meta Campaign (external Meta object). Undoes Phase 6/8's "reuse the
-- existing campaigns table for a synced Meta campaign too" shortcut.
--
-- Non-destructive: every pre-existing `campaigns` row that was standing in
-- for a synced Meta campaign (source='meta_sync', meta_campaign_id set) is
-- backfilled into a new `meta_campaigns` row whose crm_campaign_id points
-- BACK at the very same `campaigns.id` it came from. This preserves, with
-- zero behavioral change, every pre-existing campaign's name/branch/leads
-- (crmCampaignId on `leads` is untouched throughout - the CRM campaign row
-- itself never moves or gets recreated, only stops double-duty as a Meta
-- campaign going forward).
-- =============================================================================

-- ---- 1. Create the new first-class Meta Campaign table --------------------

CREATE TABLE "crm"."meta_campaigns" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "meta_ad_account_id" uuid,
  "crm_campaign_id" uuid,
  "meta_campaign_id" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "last_sync_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
--> statement-breakpoint

ALTER TABLE "crm"."meta_campaigns"
  ADD CONSTRAINT "meta_campaigns_tenant_id_companies_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "crm"."companies"("id") ON DELETE CASCADE;
--> statement-breakpoint

ALTER TABLE "crm"."meta_campaigns"
  ADD CONSTRAINT "meta_campaigns_meta_ad_account_id_meta_ad_accounts_id_fk"
  FOREIGN KEY ("meta_ad_account_id") REFERENCES "crm"."meta_ad_accounts"("id") ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE "crm"."meta_campaigns"
  ADD CONSTRAINT "meta_campaigns_crm_campaign_id_campaigns_id_fk"
  FOREIGN KEY ("crm_campaign_id") REFERENCES "crm"."campaigns"("id") ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX "ix_meta_campaigns_tenant_id" ON "crm"."meta_campaigns" ("tenant_id");
--> statement-breakpoint
CREATE INDEX "ix_meta_campaigns_crm_campaign_id" ON "crm"."meta_campaigns" ("crm_campaign_id");
--> statement-breakpoint
CREATE INDEX "ix_meta_campaigns_meta_ad_account_id" ON "crm"."meta_campaigns" ("meta_ad_account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ux_meta_campaigns_tenant_meta_campaign" ON "crm"."meta_campaigns" ("tenant_id", "meta_campaign_id");
--> statement-breakpoint

-- ---- 2. Backfill: every pre-existing synced campaign maps to itself -------
-- Auto-maps crm_campaign_id = the OLD campaigns.id, preserving continuity
-- for all leads/branch/name already attached to that campaign row.

INSERT INTO "crm"."meta_campaigns" (
  "tenant_id", "meta_ad_account_id", "crm_campaign_id", "meta_campaign_id",
  "name", "status", "last_sync_at", "created_at", "updated_at"
)
SELECT
  "company_id", "meta_ad_account_id", "id", "meta_campaign_id",
  "name", "status", "updated_at", "created_at", "updated_at"
FROM "crm"."campaigns"
WHERE "meta_campaign_id" IS NOT NULL;
--> statement-breakpoint

-- ---- 3. meta_ad_sets: repoint from campaigns to meta_campaigns ------------
-- The Meta ad hierarchy belongs to the Meta campaign now, never the CRM
-- campaign it may or may not be mapped to. Every existing ad set's old
-- campaign_id (a `campaigns.id`) is resolved to the new meta_campaigns row
-- that was just backfilled to point at that very same campaigns.id.

ALTER TABLE "crm"."meta_ad_sets" ADD COLUMN "meta_campaign_id" uuid;
--> statement-breakpoint

UPDATE "crm"."meta_ad_sets" AS "mas"
SET "meta_campaign_id" = "mc"."id"
FROM "crm"."meta_campaigns" AS "mc"
WHERE "mc"."crm_campaign_id" = "mas"."campaign_id";
--> statement-breakpoint

ALTER TABLE "crm"."meta_ad_sets" ALTER COLUMN "meta_campaign_id" SET NOT NULL;
--> statement-breakpoint

ALTER TABLE "crm"."meta_ad_sets" DROP CONSTRAINT "meta_ad_sets_campaign_id_campaigns_id_fk";
--> statement-breakpoint

ALTER TABLE "crm"."meta_ad_sets"
  ADD CONSTRAINT "meta_ad_sets_meta_campaign_id_meta_campaigns_id_fk"
  FOREIGN KEY ("meta_campaign_id") REFERENCES "crm"."meta_campaigns"("id") ON DELETE CASCADE;
--> statement-breakpoint

DROP INDEX "crm"."ix_meta_ad_sets_campaign_id";
--> statement-breakpoint

CREATE INDEX "ix_meta_ad_sets_meta_campaign_id" ON "crm"."meta_ad_sets" ("meta_campaign_id");
--> statement-breakpoint

ALTER TABLE "crm"."meta_ad_sets" DROP COLUMN "campaign_id";
--> statement-breakpoint

-- ---- 4. campaigns: drop the now-obsolete Meta-specific columns -----------
-- The CRM campaign row never again carries a raw Meta id or ad-account FK
-- directly - that provenance now lives on meta_campaigns, connected via
-- meta_campaigns.crm_campaign_id (set in step 2 above for existing rows).

DROP INDEX "crm"."ix_campaigns_meta_campaign_id";
--> statement-breakpoint
DROP INDEX "crm"."ix_campaigns_meta_ad_account_id";
--> statement-breakpoint
DROP INDEX "crm"."ux_campaigns_tenant_meta_campaign";
--> statement-breakpoint

ALTER TABLE "crm"."campaigns" DROP CONSTRAINT "campaigns_meta_ad_account_id_meta_ad_accounts_id_fk";
--> statement-breakpoint

ALTER TABLE "crm"."campaigns" DROP COLUMN "meta_campaign_id";
--> statement-breakpoint
ALTER TABLE "crm"."campaigns" DROP COLUMN "meta_ad_account_id";
