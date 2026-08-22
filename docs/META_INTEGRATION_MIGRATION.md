# Meta integration migration strategy (Phase 18)

This document describes how RUTA moves a tenant from the legacy, fully
manual per-campaign Meta webhook setup to the tenant-level Meta OAuth
integration, and the guarantees that make the migration safe to leave
half-finished indefinitely.

## The two pipelines, briefly

- **Legacy (pre-Phase-7).** One CRM campaign is manually configured with a
  Meta App Secret, Access Token, Page ID, and Lead Form ID(s), entered by
  hand and stored on that campaign's `webhook_configs` row. Meta calls a
  per-campaign webhook URL (`/api/webhooks/meta/:slug`); events land in
  `raw_meta_events` and are processed by `src/application/processLead.ts`
  directly into that one campaign's leads.
- **New (Phase 3+).** A tenant connects Meta once via OAuth
  (`meta_connections`), selects a Facebook Page and Ad Account
  (`meta_pages` / `meta_ad_accounts`), and Pages/campaigns/forms sync in
  automatically (`meta_campaigns`, `meta_forms`). Meta calls one shared,
  app-level webhook (`/api/webhooks/meta/leadgen`); events land in
  `meta_lead_events` and are processed by
  `src/application/metaSync/processMetaLeadEvent.ts`. A synced Meta
  campaign is mapped to a CRM campaign explicitly, by an admin, via
  `POST /api/campaigns/meta/{id}/map` - never automatically by the sync
  itself.

Both pipelines write into the same `leads` table and can run side by side
indefinitely. Nothing about connecting, migrating, or even failing to
migrate ever requires the other pipeline to stop.

## What "migration" actually means here

There is no data migration in the traditional sense - no row is moved,
recoded, or deleted. "Migrating" a legacy campaign means: the tenant
connects the *same* Facebook Page through the new OAuth integration, and an
admin then maps that Page's synced Meta campaign(s) to the *same* CRM
campaign the legacy config used to feed. From that point forward, new leads
for that Page arrive through the new pipeline; the legacy webhook keeps
existing (and keeps working, if Meta is still calling it) but simply stops
being the campaign's only source of new leads once the admin is satisfied
the new one is active.

## Hard guarantees (do-not-delete)

1. **Existing leads are never deleted.** No code path introduced by this or
   any prior Meta-integration phase issues a `DELETE` against `leads`. Lead
   attribution (`campaignId`) is only ever set at write time or via an
   explicit map/unmap action; unmapping a Meta campaign clears the mapping
   going forward, it does not touch already-written leads.
2. **Existing campaigns are never deleted.** `campaigns` rows are only ever
   created or `UPDATE`d (name/platform/status/branch); there is no delete
   endpoint for a CRM campaign anywhere in the API.
3. **Existing pipeline data is never deleted.** `raw_meta_events`,
   `meta_lead_events`, and pipeline/stage data are append-only from these
   flows; connecting, disconnecting, reauthorizing, or failing to migrate
   Meta never removes a row from any of them.
4. **Existing users are never deleted.** Nothing in the Meta integration
   touches the `users` table at all.
5. **Existing tenant data is never deleted.** Disconnecting Meta
   (`disconnectActiveMetaConnection`) demotes the connection's `status` to
   `"revoked"` - it is a status change, not a delete - preserving it as
   history exactly like every other connection-lifecycle transition
   (`active` → `revoked` on reconnect-as-a-different-user,
   `active` → `needs_reauth`/`error` on a detected auth failure). The legacy
   `webhook_configs` table and its columns are never dropped or altered by
   the OAuth integration; see `docs` comments on `webhookConfigs` in
   `src/infrastructure/db/schema.ts` and Phase 17's removal of only the
   *UI entry point* for creating new manual configs, never the table.

None of this required new enforcement in Phase 18 - it was already true of
every prior phase's design, and Phase 18 does not change it. What Phase 18
adds is the migration path itself and its visibility.

## Automatic mapping when possible

Both `webhook_configs.page_id` and `meta_pages.page_id` store Meta's own,
stable Facebook Page id as plain text (the two schemas deliberately use the
same convention - see their doc comments). That means a legacy campaign's
Page can be automatically recognized the moment the *same* Page shows up
under the tenant's new OAuth connection, with no re-entry of any Meta ID
required.

`src/application/metaSync/legacyMigration.ts` implements this comparison
(`evaluateLegacyWebhookMigration`). It is a **pure read** - two existing
repository lookups, no writes, no deletes - and returns one of:

| Recommendation | Meaning |
|---|---|
| `connect_required` | Tenant has no usable Meta connection on the new integration yet. |
| `reconnect_required` | A connection exists but currently needs reauthorization or has an error. |
| `page_not_found` | Connection is healthy, but no currently-synced Page matches this legacy config's Page id (or none was recorded). |
| `select_page_required` | The *same* Page is already synced under the new integration, but hasn't been selected/its webhook isn't active yet. |
| `ready_to_map` | The *same* Page is connected, selected, and its webhook is active - leads for it are already flowing through the new pipeline; an admin can map its synced Meta campaign(s) to this CRM campaign whenever ready. |

This is surfaced on the campaign detail page (`public/campaign.html`), in
the "Legacy Meta Webhook" card added in Phase 17, immediately below the
legacy config's own read-only details - visible only to users who can
manage integrations. It is deliberately advisory only: nothing on this
screen (or anywhere else) performs the mapping automatically. An admin
still takes the explicit action (map, in the "Mapped Meta campaigns" table
on the same page).

## When automatic matching isn't possible

If the tenant hasn't connected Meta yet, the connection needs
reauthorization, or the legacy Page simply hasn't appeared under the new
integration (different Business Manager, access not yet granted, etc.),
the old record is left exactly as-is - continuing to receive leads through
the legacy pipeline if Meta is still calling its webhook - and the same
card tells the admin the concrete next step (connect, reconnect, or select
the right Page in Settings → Integrations → Meta). There is no deadline and
no automatic fallback behavior: a tenant can run both pipelines side by
side indefinitely, or never migrate a given legacy campaign at all, without
losing any data or lead-capture capability.

## Admin checklist to migrate one legacy campaign

1. Open the campaign in RUTA and check its "Legacy Meta Webhook" card for
   the migration recommendation.
2. If `connect_required` / `reconnect_required`: go to
   Settings → Integrations → Meta and connect or reconnect.
3. If `select_page_required`: select the matched Page in
   Settings → Integrations → Meta and confirm its webhook shows Active.
4. Once `ready_to_map`: go to the Campaigns screen, open the now-synced
   Meta campaign under "Meta Campaigns," and map it to this same CRM
   campaign (or use the "Mapped Meta campaigns" table on the campaign page).
5. Leave the legacy config in place. It is historical/deprecated, not
   harmful - there is no need to remove it, and no UI action exists to do
   so.
