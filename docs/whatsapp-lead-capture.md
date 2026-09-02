# WhatsApp Lead Capture

This document describes how RUTA extends its existing Meta integration to
also capture leads that arrive via WhatsApp (Click-to-WhatsApp ads and
direct/organic WhatsApp messages), and the design decisions that keep it a
true extension of the Meta Instant Form pipeline rather than a second,
parallel system.

## The core idea

One Meta connection, two lead approaches. A tenant connects Meta exactly
once (the same `meta_connections` OAuth flow that already powers Instant
Form leads). From that single connection, RUTA:

1. Discovers whether the tenant has a WhatsApp Business Account and phone
   number under the same Meta Business Manager - automatically, via the
   Graph API, never by asking the tenant to type in a WABA ID, phone number
   ID, access token, or webhook URL.
2. Resolves, per synced ad, whether that ad's lead destination is a Meta
   Instant Form or a Click-to-WhatsApp destination - from real Meta
   configuration data, never guessed from an ad's name.
3. Captures inbound leads from either destination into the exact same
   `leads` table, through the exact same webhook endpoint, using the exact
   same background-processing pipeline shape.

There is no separate "Connect WhatsApp" screen, no `WhatsAppLead` entity,
and no second webhook URL. Everywhere this feature touches the codebase, it
extends an existing mechanism rather than adding a parallel one.

## Schema additions

All additive - no existing column, table, or migration was altered.

- **`leads.lead_approach`** (nullable `text`, indexed) - the new, generic
  "how was this lead captured" axis, orthogonal to the existing
  `leads.source` catalog (which keeps its exact pre-existing values:
  `meta_lead_ads`, `whatsapp`, `manual`, etc. - untouched, for backward
  compatibility). See `src/domain/leadApproach.ts` for the fixed catalog:
  `meta_instant_form`, `whatsapp`, `website`, `messenger`, `instagram`,
  `phone`, `manual`, `unknown`. A WhatsApp lead gets
  `source: "whatsapp"` + `leadApproach: "whatsapp"`; a Meta Instant Form
  lead (synced going forward) gets `source: "meta_lead_ads"` +
  `leadApproach: "meta_instant_form"`. Old leads simply have
  `leadApproach: null`, which every UI/reporting surface treats identically
  to `"unknown"`.
- **`meta_whatsapp_accounts`** - every WhatsApp phone number discovered for
  the tenant (Business Manager → owned WhatsApp Business Accounts → phone
  numbers), one row per number, with `isSelected` marking which one RUTA
  actually uses. Auto-selected when exactly one is found; a picker only
  ever appears when there's a genuine choice to make.
- **`meta_lead_routes`** - one row per synced ad, remembering its resolved
  lead approach (`meta_instant_form` / `whatsapp` / `unknown`), confidence
  (`DETERMINED` / `UNDETERMINED`), and - for a WhatsApp-routed ad - which
  discovered WhatsApp account it's associated with. Refreshed on every
  campaign sync, never accumulated as history.
- **`whatsapp_message_events`** - inbound-message durability + idempotency,
  the WhatsApp counterpart to `meta_lead_events`. One row per WhatsApp
  message id (`wamid...`), unique on `(tenant_id, wa_message_id)`.

## Discovery and routing (Phases 2-4)

`src/application/metaSync/whatsappDiscoveryService.ts` walks
Business Manager → WhatsApp Business Account(s) → phone number(s) using the
same user access token the rest of the Meta connection already has, and is
called from `completeMetaConnection` (`metaOAuth.ts`) the exact same
best-effort way Forms/Instagram discovery already is - a tenant without the
optional `whatsapp_business_management` scope granted simply discovers zero
WhatsApp assets, never a broken connection.

`src/application/metaSync/metaLeadApproachResolver.ts` resolves each synced
ad's lead approach using two real, documented Meta fields, checked in this
order:

1. The ad's own creative link:
   `creative.object_story_spec.link_data.call_to_action.value.lead_gen_form_id`
   - if present, the ad is `meta_instant_form` (this is a per-ad fact - two
   ads in the same ad set can point at different forms).
2. The ad set's `destination_type` field - if exactly `"WHATSAPP"`, the ad
   is `whatsapp` (a per-ad-set fact - Meta's own documented, required field
   for Click-to-WhatsApp ad sets).

Anything else is `unknown`, with a logged, human-readable reason - never
guessed from a campaign or ad name. This runs automatically as part of
`metaCampaignService.ts`'s existing campaign sync, once per ad, and its
result is persisted (`meta_lead_routes`) so no later step ever needs to
re-call the Graph API to answer "how does this ad capture leads".

## The webhook (Phases 6-7)

Meta delivers every product an App subscribes to (Page leadgen *and* a
WhatsApp Business Account's messages) to that App's one registered Callback
URL. Because the Vercel Hobby plan's 12-Function cap was already fully
consumed by the existing deployment, WhatsApp events are **not** a new
endpoint - they're handled by the same `/api/webhooks/meta/leadgen` Vercel
Function, which now branches internally on the payload's top-level `object`
field (`"page"` → existing Instant Form flow; `"whatsapp_business_account"`
→ the WhatsApp flow) right after the shared HMAC signature check.

`src/application/metaSync/metaWhatsappEventService.ts` mirrors
`metaLeadEventService.ts`'s two-half shape exactly:

- `captureWhatsappEvents` - the fast, ack-blocking half. Parses the
  webhook body, resolves the owning tenant from the message's
  `metadata.phone_number_id` (never trusted from the payload as a claim -
  looked up against what discovery already recorded), and durably records
  the event (`recordWhatsappMessageEvent`, `onConflictDoNothing` on
  `(tenant_id, wa_message_id)` - the idempotency backstop). Postgres only;
  no Graph API call, no queue publish.
- `enqueueCapturedWhatsappEvents` - called only *after* the webhook
  handler has already responded 200 to Meta. Publishes one QStash message
  per newly-captured event (`publishWhatsappMessageReceived`, posting to
  the same `/api/internal/process-lead` endpoint as the other two lead
  pipelines, distinguished by `kind: "whatsapp_message_received"` - again,
  no new Function).

## Lead creation and attribution (Phases 8-9)

`src/application/metaSync/processWhatsAppMessageEvent.ts` is the QStash
worker. Unlike the Instant Form pipeline, it makes **no Graph API call** -
every field a WhatsApp lead needs (sender, contact name, first message,
and - when present - the Click-to-WhatsApp `referral` object) was already
delivered inline in the webhook payload.

Attribution: when the stored event carries a `referral.source_id` (the
originating ad's own Meta id, present only for a message that started from
clicking a Click-to-WhatsApp ad), it's looked up against `meta_lead_routes`
to recover the ad/ad-set/campaign/CRM-campaign chain - the same data
`metaCampaignService.ts` already resolved once at sync time. No referral,
or a referral naming an ad this tenant hasn't synced, leaves every
attribution field `null` - rendered everywhere as **"Unknown / Organic
WhatsApp"**, never guessed from the message text or contact name.

The lead itself is inserted via `insertWhatsappLead` into the same `leads`
table every other pipeline uses, idempotency-keyed as
`` `whatsapp:${waMessageId}` `` (Meta's own, real, stable message id) against
the existing `leads.meta_lead_id` unique index - the same authoritative
backstop the Instant Form pipeline relies on, reached here through a real
external id rather than a synthetic one.

## Self-healing (Phase 13)

`getUnenqueuedWhatsappMessageEvents` (mirroring
`getUnenqueuedMetaLeadEvents`) is swept by the existing 15-minute
reconciliation job (`src/application/reconcile.ts`), retrying the publish
for any event that was durably captured but never confirmed enqueued.
There is deliberately no "missing WhatsApp messages" scan analogous to the
Instant Form pipeline's Graph-API-backed recovery: the WhatsApp Cloud API
has no endpoint to list historical messages, so a webhook delivery Meta
never sent at all has nothing to reconcile against - this is a real,
structural difference from the Instant Form pipeline's guarantees, not an
oversight.

## What the tenant sees

- **Pipeline / Leads list** (`public/pipeline.html`) - a "Lead approach"
  column and filter, right next to the existing "Source" column. WhatsApp
  and Instant Form leads render in the same table; there is no separate
  WhatsApp Leads page.
- **Lead details** - a "Lead approach" row, plus (for a WhatsApp lead) Ad /
  Ad set names when attribution succeeded, or an explicit "Unknown /
  Organic WhatsApp" note when it didn't. The lead's first WhatsApp message
  is stored in its Notes field, same as every other free-text capture in
  this schema.
- **Settings → Integrations → Meta** - a "WhatsApp Number" row (shown only
  when a number was actually discovered) and a "Lead Approaches" summary
  ("12 Instant Form, 5 WhatsApp, 2 Unknown"), with an explicit
  "N ads need attention" note whenever any ad resolved to Unknown. A
  discovered-but-ambiguous multi-number tenant sees a small inline picker
  here - the only place a WhatsApp-specific selection is ever asked for.
- **Dashboard** - a "How leads reach you" breakdown card, the same
  cohort/shape as the existing "Where your customers come from" source
  breakdown.

## Testing

`src/application/metaSync/whatsapp.flow.test.ts` covers, against a real
Postgres: discovery auto-selection, valid/malformed/duplicate/unknown-number
webhook capture, tenant isolation, end-to-end lead creation (with and
without referral attribution, and against an unsynced ad), idempotent
double-processing, and the shared webhook endpoint's HTTP-level signature
verification for both a valid and a forged WhatsApp payload. Every existing
Meta Instant Form test continues to pass unmodified alongside it.
