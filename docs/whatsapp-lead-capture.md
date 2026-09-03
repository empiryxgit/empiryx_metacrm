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

## What this is, and what it deliberately is not

This is best understood as **"WhatsApp ad-destination detection,"** not
"WhatsApp messaging integration." The distinction matters because it's easy
to look at "subscribes to the Cloud API `messages` webhook and reads
inbound message content" and assume that means a chatbot, an inbox, or
conversation automation lives here. None of that exists in this codebase,
and none of it is planned:

- **No** WhatsApp chatbot or AI auto-replies.
- **No** conversation management, inbox UI, or message history beyond the
  one message that created the Lead (which is stored, verbatim, in that
  Lead's Notes field - the same free-text field every other capture path
  already uses).
- **No** outbound WhatsApp messages of any kind are ever sent by this app.

What *is* here is the minimum mechanism Meta actually requires to turn a
Click-to-WhatsApp ad click into an identifiable Lead at all. This was
verified directly against Meta's current Marketing/Cloud API documentation
(not assumed from older examples, and not just from this project's own
prior research) while reframing this feature around "destination
detection": there is no per-click, per-user identifiable event for a
WhatsApp-destination ad - no webhook, no Graph API field - that exists
*before* the user's first WhatsApp message actually arrives. The click
identifier Meta itself generates for CTWA attribution (`ctwa_clid`) doesn't
exist until that point either; it travels *inside* the first inbound
message's `referral`/`context.ad` metadata, not through any separate
channel. So subscribing to that one message and reading its contents once
is not an optional design choice on top of "just detect the destination" -
it is the *only* Meta-provided path to an identifiable WhatsApp lead. What
this codebase deliberately does with that one message - capture it as a
Lead and stop - is the boundary that keeps this "ad destination detection,"
not "messaging integration."

See "Advertising Interaction vs. identifiable Lead" below for what happens
when no message ever arrives at all (an ad click Meta can only report as an
aggregate number, never a person).

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

## Advertising Interaction vs. identifiable Lead (Phase 17)

Not every click on a Click-to-WhatsApp ad turns into a WhatsApp message -
plenty of people tap the ad and never actually send anything. Meta reports
those clicks and "conversations started" as an **aggregate, ad-level
metric** (the `actions` field on the ad-insights endpoint, action types
`link_click` and `onsite_conversion.messaging_conversation_started_7d`) -
never as a list of people, and never with enough information to construct
an identifiable Lead. Turning that aggregate number into fabricated
individual Lead rows would be a real correctness bug (150 clicks does not
mean 150 leads), so this codebase never does that - the two numbers are
computed by entirely separate code paths and never merge:

- **Identifiable Leads** - real rows in `leads`, created only when an
  actual WhatsApp message arrives (see "The webhook" above). Source of
  truth: `leads.lead_approach = "whatsapp"`.
- **Advertising Interactions** - Meta's own aggregate click/conversation
  counts for the tenant's WhatsApp-routed ads
  (`src/infrastructure/meta/graphClient.ts`'s `getAdInsights`, summed by
  `src/application/metaSync/metaAdInteractionService.ts`). Fetched
  on-demand, never persisted (Meta already retains this history), and never
  written into `leads` or any table that could be confused with one.

The Dashboard surfaces both, deliberately worded to keep the distinction
visible to a non-technical tenant: "WhatsApp ad interactions: 150
conversations started (Meta's own aggregate ad metric, not individual
people) — 32 became identifiable leads in the CRM." This is fetched as a
second, progressive request (`?includeAdInteractions=true`) only for a
tenant who already has at least one WhatsApp-routed ad, so it never slows
down or adds Meta API load to the default dashboard load for the majority
of tenants who don't have any yet.

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
- **Settings → Integrations → Meta** - a "WhatsApp (ad destination)" row
  (shown only when a number was actually discovered, reworded from "WhatsApp
  Number" to keep the destination-detection framing explicit), its webhook
  subscription health (see the "leads not showing" incident below), and a
  "Lead Approaches" summary ("12 Instant Form, 5 WhatsApp, 2 Unknown"), with
  an explicit "N ads need attention" note whenever any ad resolved to
  Unknown. A discovered-but-ambiguous multi-number tenant sees a small
  inline picker here - the only place a WhatsApp-specific selection is ever
  asked for.
- **Dashboard** - a "How leads reach you" breakdown card (identifiable
  Leads only, same cohort/shape as the existing "Where your customers come
  from" source breakdown), plus the separate Advertising Interaction note
  described above.

## Known limitation: webhook subscription (fixed)

The original implementation discovered a tenant's WhatsApp number and
auto-selected it, but never actually told Meta to *start delivering* that
number's inbound-message events to this app - the asset-level
`POST /{waba-id}/subscribed_apps` opt-in (and its app-level counterpart)
that the Page/Instant Form pipeline has always performed
(`ensureAppLeadgenSubscription`/`subscribePageToLeadgen`) had no WhatsApp
equivalent. Meta doesn't error in this state, it simply never sends
anything, so a tenant could have a fully "connected" number and never
receive a lead. Fixed via `metaWhatsappWebhookService.ts` (mirrors the Page
pattern exactly) - see the project status doc for full detail. The fix
re-confirms the subscription on every discovery run, so a tenant who
selected their number before this fix existed gets subscribed retroactively
on their next reconnect, with no manual step required.

## Testing

`src/application/metaSync/whatsapp.flow.test.ts` covers, against a real
Postgres: discovery auto-selection, valid/malformed/duplicate/unknown-number
webhook capture, tenant isolation, end-to-end lead creation (with and
without referral attribution, and against an unsynced ad), idempotent
double-processing, the shared webhook endpoint's HTTP-level signature
verification for both a valid and a forged WhatsApp payload, and (added
alongside the webhook-subscription fix) that a connect/select actually
subscribes the webhook and records the outcome. Every existing Meta Instant
Form test continues to pass unmodified alongside it.

`src/application/metaSync/metaLeadApproachResolver.test.ts` (pure logic, no
Postgres) exercises the three-way destination-detection split in isolation:
Instant Form / WhatsApp / Unknown, the priority rule between the two
signals, and that neither the ad nor ad-set NAME is ever consulted.
`src/application/metaSync/sync.flow.test.ts` adds an integration-level
proof that a single campaign with a genuine mix of Instant Form and
WhatsApp ads resolves each ad independently (never one approach applied to
a whole campaign), plus an unrecognized-destination-type case resolving to
Unknown rather than being guessed.

`src/application/metaSync/metaAdInteraction.test.ts` covers the Advertising
Interaction summary: no connection / no WhatsApp-routed ads both resolve to
an honestly-empty "unavailable" result rather than an error; aggregate
numbers sum correctly across multiple ads; one ad's Graph API call failing
never fails the whole summary; tenant isolation; and, the one assertion
every test in this file effectively repeats, that this code path can never
create a Lead no matter what the aggregate metric reports.
