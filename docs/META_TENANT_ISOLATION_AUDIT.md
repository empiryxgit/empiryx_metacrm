# Meta tenant isolation audit (Phase 19)

> Note on scope: the request this audit responds to was cut off mid-sentence
> after "For incoming webhook:". Everything up to that point establishes a
> single principle - tenant identity must never be taken solely from a
> user-submitted id - so this document applies that principle explicitly to
> both incoming webhook receivers (the highest-risk surface, since neither
> one has an authenticated session to read a tenant from) in its own
> section below. If a different requirement was intended to follow that
> sentence, flag it and this audit will be extended.

## Scope

Validated tenant isolation for every record type named in the request:
Meta Connection, Page, Instagram Account, Ad Account, Campaign, Form, Lead
Event, and Lead. For each: every repository read/write was checked for a
`tenantId`/`companyId` condition in its `WHERE` clause, every API route was
checked that the tenant id it passes down comes from the authenticated
session (never a request parameter), and the two webhook receivers were
checked end-to-end for how they resolve which tenant an inbound,
unauthenticated Meta payload belongs to.

## Result

Tenant isolation was already correctly enforced almost everywhere - this
codebase has consistently followed a "re-check every id against tenantId,
never trust a bare id" convention since Phase 2. The audit found and fixed
two defense-in-depth gaps (below); everything else is confirmed compliant
with no code changes needed. A full functional test (two real tenants, one
positive and one negative assertion per record type - 20 assertions total)
verified every category after the fixes; see the bottom of this document.

## How tenant identity is established (the foundation everything else relies on)

Every authenticated API route resolves the acting tenant as
`auth.companyId`, taken from `requirePermission`/`requireAuth`
(`src/infrastructure/auth/context.ts`), which reads it from a signed JWT
access-token cookie set at login - never from a URL param, query string, or
request body. No handler in the Meta integration accepts a `tenantId` or
`companyId` from the client and uses it directly; where a client supplies
some OTHER id (a page's row id, a Meta campaign's row id, a CRM campaign id
to map to, ...), that id is always re-checked against `auth.companyId`
before use, and a mismatch returns a generic 404 - a cross-tenant probe can
never distinguish "wrong id" from "someone else's id."

The one place tenant identity crosses an external boundary during normal
(non-webhook) use is the Meta OAuth redirect. `state` is a signed,
single-use, 10-minute JWT (`src/infrastructure/auth/oauthState.ts`) sealed
server-side from the caller's own verified session at `/connect` time;
`/callback` recovers `tenantId`/`userId` ONLY from that verified token,
never from a query parameter, and the embedded nonce is consumed via Redis
so the same state value can't be replayed even if it leaked.

## For incoming webhooks: tenant is never taken from the payload

Both Meta webhook receivers are intentionally unauthenticated (Meta calls
them, not a logged-in browser), which means neither has a session to read
`auth.companyId` from. Both resolve tenant identity from a value THIS
SERVER previously and independently decided to associate with a tenant -
never from anything in the request itself:

- **New pipeline** (`POST /api/webhooks/meta/leadgen`, alias
  `/page-events`): the payload carries only Meta's own `page_id` - no
  tenant field exists in the shape at all. Tenant is resolved via
  `getSubscribedMetaPagesByPageId(pageId)`
  (`src/infrastructure/db/repositories/metaLeadEvents.ts`), which looks up
  which tenant(s) this server itself recorded as owning that Page (Phase
  5's "Select Page" + Phase 7's webhook subscription), filtered to
  `webhookSubscribed = true` so a Page a tenant synced but never
  subscribed can never be attributed events. This happens INSIDE
  `captureLeadgenEvents` (`src/application/metaSync/metaLeadEventService.ts`),
  only after the request's `X-Hub-Signature-256` HMAC has been verified
  against `META_APP_SECRET` - an unverified body is rejected before any
  lookup or durability write happens at all.
- **Legacy pipeline** (`POST /api/webhooks/meta/{slug}`): the URL's `slug`
  is an unguessable, per-campaign, randomly generated routing segment
  (`randomBytes(18)`, see `generateSlug` in
  `src/infrastructure/db/repositories/campaigns.ts`) - not a tenant id
  itself, but the lookup key for the one `webhook_configs` row it belongs
  to. `getWebhookConfigBySlug(slug)` resolves `companyId`/`campaignId` from
  that row; a non-matching slug returns a generic 404 that never confirms
  whether a slug is "close" to a real one. The request is then verified
  against THAT campaign's own `X-Hub-Signature-256` (its own `appSecret`)
  before `ingestWebhookPayload` ever runs - the same "verify before trust,
  resolve tenant only from what this server already decided" shape as the
  new pipeline.

Neither receiver has a `tenantId`/`companyId` field it reads from the
request at any point - by construction, not merely by convention.

## The two gaps found, and the fix

Both gaps were internal, QStash-signature-verified worker code paths (not
directly reachable with an attacker-supplied id) rather than live
vulnerabilities - but "every Meta record must belong to the correct
tenant" is treated in this codebase as an invariant to enforce at every
lookup, not something to assume holds because of how a value arrived. Both
were hardened to fail closed instead of trusting an unscoped internal
lookup:

1. **`getWebhookConfigByCampaignIdInternal`** (legacy pipeline,
   `src/infrastructure/db/repositories/campaigns.ts`) - looked up a
   campaign's decrypted Meta access token by `campaignId` alone, with no
   `companyId` condition. `processLead.ts` calls it with a `companyId` it
   already has (from the same QStash message as `crmCampaignId`, both set
   together from the original slug-resolved webhook config), but nothing
   cross-checked the two agreed. Now takes `(companyId, campaignId)` and
   scopes by both, matching every other `*Internal` lookup in this
   codebase (`getMetaPageInternal`, `getActiveMetaConnectionInternal`). A
   future bug that ever let the two ids diverge now gets `null` (the
   existing "config not found, not retryable" path) instead of silently
   handing back a different tenant's Meta access token.
2. **`getMetaLeadEventById`** (new pipeline,
   `src/infrastructure/db/repositories/metaLeadEvents.ts`) - same shape:
   looked up a `meta_lead_events` row by `id` alone. `processMetaLeadEvent`
   calls it with a `tenantId` it already has (from the same QStash message
   as `leadEventId`), unchecked against the row's own `tenantId`. Now takes
   `(tenantId, id)` and scopes by both, matching this same file's own
   `getMetaLeadEventByTenantAndLeadgenId`.

Both are pure narrowing changes - a legitimate call already always supplies
matching ids, so no real caller's behavior changes; only a hypothetically
mismatched call now fails safely instead of silently trusting the wrong
tenant's data.

## Verified compliant, no changes needed

- **Meta Connection**: every read (`getRelevantMetaConnectionView`,
  `getActiveMetaConnectionInternal`, ...) is scoped by `tenantId`;
  `disconnectActiveMetaConnection`/`upsertMetaConnection` only ever
  update/insert rows for the given `tenantId`.
- **Page / Instagram Account / Ad Account**: every list/select/internal
  lookup takes `tenantId` plus the target row id and scopes by both (see
  `selectMetaPage`, `selectMetaAdAccount`, `selectMetaInstagramAccount`,
  `getMetaPageInternal`, `getMetaPageInternalByPageId`) - a foreign row id
  returns `null`/404, same as a nonexistent one.
- **Campaign** (`meta_campaigns`): `getMetaCampaignWithMappingByRowId`,
  `mapMetaCampaignToCrmCampaign`, `unmapMetaCampaign` all scope by
  `tenantId` + row id. `handleMapMetaCampaign`
  (`api/campaigns/handler.ts`) additionally re-verifies the TARGET CRM
  campaign (`crmCampaignId`, client-supplied) belongs to `auth.companyId`
  via `getCampaign` before ever calling the mapping function - a request
  can never link a Meta campaign to another tenant's CRM campaign.
- **Form**: `getMetaFormById`, `listFieldMappingsForForm`,
  `getFieldMappingsByMetaFormId`, `saveFieldMappings` all scope by
  `tenantId`; `saveFieldMappings` additionally re-checks every mapping row
  id against both `tenantId` AND the specific form's row id before
  updating it.
- **Lead**: every mutation (`updateLeadPipelineStage`,
  `updateLeadCrmFields`) and the lead-count aggregates
  (`getLeadCountsForCampaigns`, `getLeadCountsByMetaCampaignId`) are scoped
  by `companyId`. `leadExistsByMetaLeadId` is intentionally global (not
  tenant-scoped) - it's a boolean uniqueness guard on Meta's own globally
  unique lead id, discloses nothing, and is what stops the SAME real lead
  from ever being written twice regardless of which pipeline or tenant a
  redelivery routes through.

## Functional verification

Ran a local-Postgres test creating two real tenants (A, B) and, for every
one of the eight record types, asserting (a) tenant B gets `null`/`false`/
empty trying to read or mutate a row that belongs to tenant A by its
internal row id, and (b) tenant A can still read/mutate its own row
normally (no regression). All 20 assertions passed, including both
Phase 19 fixes and six previously-existing categories that required no
change. `tsc --noEmit`, the vitest suite, and the Vercel Function count
(still exactly 12) were also verified clean after the fix.
