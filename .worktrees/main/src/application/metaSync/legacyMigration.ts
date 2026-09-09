// LegacyMetaMigrationService (Phase 18) - "Create a safe migration
// strategy" for CRM campaigns that still use the old, fully-manual Meta
// setup (App Secret / Access Token / Page ID / Lead Form IDs, entered by
// hand on the pre-Phase-7 campaign screen - see schema.ts's webhookConfigs
// doc comment) instead of the tenant-level Meta OAuth integration.
//
// This module NEVER writes anything and NEVER deletes anything - it is a
// pure read-side comparison between a legacy webhookConfigs row's raw Meta
// Page id and whatever Pages the tenant's OWN later, tenant-level OAuth
// connection has since synced (meta_pages), and it reports what a person
// can safely do next. Nothing here ever mutates webhookConfigs, campaigns,
// leads, raw_meta_events, meta_connections, meta_pages, users or any other
// table - "migrating" a campaign only ever happens when an admin takes an
// explicit action elsewhere (connecting Meta, selecting a Page, or mapping
// a synced Meta campaign to this CRM campaign via the existing
// /api/campaigns/meta/{id}/map endpoint). Every legacy record keeps
// working and keeps existing regardless of what this reports.
//
// Matching is possible at all only because both schemas deliberately store
// Meta's OWN Page id as plain text under the same convention (see
// webhookConfigs.pageId's and metaPages.pageId's doc comments) - a legacy
// campaign whose Page has since been connected via OAuth (same Meta Page,
// reconnected the new way) is automatically detectable without asking the
// tenant to re-identify anything.

import { getRelevantMetaConnectionView, listMetaPages } from "../../infrastructure/db/repositories/metaIntegration";

export type LegacyMigrationRecommendation =
  // No usable Meta connection on the new integration yet (never connected,
  // or the tenant's own Disconnect - both read the same as "not connected"
  // to getRelevantMetaConnectionView, matching the main status screen).
  | "connect_required"
  // A connection exists but currently needs attention (needs_reauth/error)
  // - matching against its Pages would be unreliable/stale until fixed.
  | "reconnect_required"
  // Connection is healthy, but no Page among its currently-synced Pages
  // matches this legacy config's Page id (or the legacy config never had
  // one on record) - nothing to auto-match; a person decides what to do.
  | "page_not_found"
  // The SAME Page is already synced under the new integration, but hasn't
  // been selected/its webhook isn't active yet - one step away.
  | "select_page_required"
  // The SAME Page is connected, selected, and its webhook is active -
  // leads for it are already flowing through the new pipeline; safe to
  // map its synced Meta campaigns to this CRM campaign whenever ready.
  | "ready_to_map";

export interface LegacyMigrationStatus {
  recommendation: LegacyMigrationRecommendation;
  matchedPageName: string | null;
}

/**
 * `legacyPageId` is webhookConfigs.pageId for one campaign's legacy config
 * (may be null - not every legacy config had one recorded). Read-only:
 * two existing repository reads, no writes.
 */
export async function evaluateLegacyWebhookMigration(
  tenantId: string,
  legacyPageId: string | null,
): Promise<LegacyMigrationStatus> {
  const connection = await getRelevantMetaConnectionView(tenantId);

  if (!connection) return { recommendation: "connect_required", matchedPageName: null };
  if (connection.status !== "active") return { recommendation: "reconnect_required", matchedPageName: null };
  if (!legacyPageId) return { recommendation: "page_not_found", matchedPageName: null };

  const pages = await listMetaPages(tenantId);
  const matched = pages.find((p) => p.pageId === legacyPageId);
  if (!matched) return { recommendation: "page_not_found", matchedPageName: null };

  if (!matched.isSelected || matched.webhookStatus !== "active") {
    return { recommendation: "select_page_required", matchedPageName: matched.pageName };
  }

  return { recommendation: "ready_to_map", matchedPageName: matched.pageName };
}
