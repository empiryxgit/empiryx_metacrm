# WhatsApp Automated Follow-Up Bot — Phase 2 Development Plan

**Scope of "Phase 2":** an outbound, automated WhatsApp follow-up that reaches a lead after capture, references the campaign/ad that produced them, and asks about their interest — then routes their reply back into the CRM pipeline. This builds on top of the existing WhatsApp Lead Capture feature (inbound-only today) rather than replacing any of it.

This document is a plan, not an implementation — nothing in the codebase has been changed to produce it. Everything below is grounded in what's actually in the repo today (read directly, not assumed); the "Open decisions" section at the end lists what needs an answer from you before Phase 2a starts.

---

## 1. What already exists (the foundation this builds on)

Read directly from the current codebase before writing this plan:

- **Inbound-only WhatsApp integration.** `metaWhatsappAccounts` (one connected WhatsApp Business number per tenant, with its own webhook-subscription bookkeeping), `whatsappMessageEvents` (durable inbound-message log, unique on `(tenantId, waMessageId)`), `whatsappDiscoveryService.ts` (finds/selects the tenant's number), `metaWhatsappWebhookService.ts` (subscribes it to Meta's webhook), `processWhatsAppMessageEvent.ts` (turns an inbound message into a `leads` row). This pipeline only *receives* — I confirmed there is no outbound-send call anywhere in `src/infrastructure/meta/graphClient.ts` today (no `/messages` POST, no template-send function). Phase 2 has to build outbound sending from scratch.
- **`meta_lead_routes`** already resolves, per synced ad, whether it's an Instant-Form or WhatsApp-destination ad (`approach`/`confidence`), refreshed on every sync. This is exactly the "campaign details" signal the follow-up bot needs to know what to reference.
- **`leads`** already carries everything needed to personalize a message: `phoneNumber`, `fullName`, `campaignName`/`adName` (Meta's own), `crmCampaignId` (the mapped CRM campaign), `leadApproach`, `pipelineStage`, `customFields` (industry-template fields like budget/location), `nextFollowUpAt`.
- **`lead_follow_ups`** is a *manual*, salesperson-logged history table (remarks/outcome/nextFollowUpAt) — not a conversation transcript store. It's the right place to surface a summary of what the bot heard, but not the right shape to hold a live conversation's state.
- **Durable-queue pattern already established and proven**, used identically by both existing lead pipelines: write a durable Postgres row *before* acknowledging any webhook, ack immediately, then publish to QStash for actual processing; QStash retries with backoff and a dead-letter callback on exhaustion; a 15-minute reconciliation sweep self-heals anything that fell through. Phase 2 should reuse this exact pattern for outbound sends, not invent a new one.
- **Entitlement gating** (`isLeadIngestionBlocked` in `src/application/billing.ts`) already blocks new lead ingestion once a tenant's trial/subscription lapses. Outbound bot messages are also a billable action and need the same gate.
- **Vercel Hobby's 12-serverless-function cap is fully consumed.** Every feature added since the initial build has folded into existing functions via a `?resource=`/`kind` discriminator rather than adding a new one. Phase 2 has to follow the same rule — no new Vercel Function.
- **Every migration since the `42701` incident uses idempotent, guarded SQL** (`IF NOT EXISTS` / `duplicate_object`/`duplicate_column` exception blocks / `ON CONFLICT DO NOTHING` seeds). Any new migration follows this.

## 2. What's genuinely missing for this feature

1. **No outbound WhatsApp send capability at all** — not the Graph API call, not template management, not a "send" queue.
2. **No conversation/session concept.** Today's WhatsApp tables model single inbound events, not a multi-turn back-and-forth with state (e.g. "follow-up sent, awaiting reply", "replied interested", "replied not now", "opted out").
3. **No trigger/scheduler for *when* to send a follow-up** after a lead is captured (immediately? after N hours? only for certain pipeline stages?).
4. **No reply-intent handling** — turning "yes I'm interested" / "not right now" / "stop messaging me" into a pipeline action.
5. **No compliance layer** — WhatsApp's own commerce policy requires opt-out handling, and outside a 24-hour window Meta requires a pre-approved message **template**, not free-form text (see §5).
6. **No concurrency/session-isolation guarantee** — this is the specific gap you flagged, and it needs to be a first-class part of the design, not an afterthought (see §6).

## 3. Meta's real constraints (verified against how the Cloud API actually works, not assumed)

- **The 24-hour customer service window.** Once a business has one, it can send free-form (non-template) messages to a user only within 24 hours of that user's *last inbound message*. Outside that window — which is exactly the case for the very first outbound follow-up, since the lead hasn't messaged the bot yet — Meta requires sending a **pre-approved WhatsApp Message Template** (structured, submitted to Meta for approval in advance, with defined variable slots). This means: the *first* "here's your campaign, are you interested?" message **must** be a template message, not a plain string built in our code. Free-form replies become possible only after the lead responds and the window opens.
- **Templates need Meta approval before use**, and are managed per-WABA (the same WhatsApp Business Account row already tracked in `meta_whatsapp_accounts`). This is a one-time-per-template setup step outside this app (Meta Business Manager, or the Graph API's own template management endpoints), not something built at runtime.
- **Opt-in requirement.** Meta's policy requires the recipient to have opted in to receive business-initiated messages. For a lead captured via a Click-to-WhatsApp ad or an Instant Form with a WhatsApp checkbox, that consent is generally implicit in how they arrived — but this needs a real compliance decision (see Open Decisions), not a default assumption.
- **Rate limits** scale with the phone number's messaging tier (starts around 250 unique conversations/day for a new number, expands based on quality rating) — worth knowing before mass-follow-up is turned on for a tenant with a large lead volume.

## 4. Data model additions

New tables, additive-only, same idempotent-migration convention as every migration since `0021`/`42701`:

- **`whatsapp_followup_sessions`** — one row per (tenantId, leadId), the actual conversation/state machine:
  - `id`, `tenantId`, `leadId` (FK → `leads`, cascade), `whatsappAccountId` (FK → `meta_whatsapp_accounts`), `phoneNumber` (denormalized, E.164)
  - `state`: `pending` → `template_sent` → `awaiting_reply` → `replied_interested` / `replied_not_interested` / `replied_other` / `opted_out` → `closed` (fixed catalog, application-enforced like every other status column in this schema — not a DB enum)
  - `campaignSnapshot` (jsonb) — the campaign/ad name, offer detail, etc. resolved *at send time* and frozen into the row, so a later campaign rename never rewrites what the lead was actually told
  - `templateName`, `templateLanguage`, `lastOutboundAt`, `lastInboundAt`, `windowExpiresAt` (computed: `lastInboundAt + 24h`, used to decide free-form vs. template on the *next* send)
  - `attemptCount`, `nextAttemptAt` (for a retry/re-engage cadence — see §7)
  - **`lockedUntil` / `lockedBy`** — the concurrency-control column, see §6
  - `createdAt`, `updatedAt`
  - Unique on `(tenantId, leadId)` — one active session per lead, same "durability row is the idempotency backstop" convention `whatsapp_message_events` already uses for inbound.
- **`whatsapp_followup_messages`** — append-only transcript, one row per message (both directions): `sessionId`, `direction` (`out`/`in`), `waMessageId` (nullable for an outbound send that hasn't confirmed delivery yet), `body`/`templatePayload`, `intentClassification` (nullable, see §8), `createdAt`. This is what gives a salesperson (and the bot itself) the full back-and-forth, distinct from `lead_follow_ups`' manual-remarks log.
- **`whatsapp_message_templates`** — mirrors what's actually approved in Meta, per tenant: `tenantId`, `name`, `language`, `variableSchema` (jsonb — which lead fields fill which template placeholder), `status` (`pending_approval`/`approved`/`rejected`), `isActiveForFollowup` (which one the bot currently uses to open a conversation). Keeps the *mapping* of "our campaign field → Meta template variable" out of code and in data, same spirit as this session's `platform_packages` work moving pricing out of hardcoded constants.
- **`leads`**: no new required column — `nextFollowUpAt` and `pipelineStage` are reused, not duplicated. A completed bot conversation writes a normal `lead_follow_ups` row (outcome-tagged) summarizing what happened, so it shows up in the existing Pipeline UI's follow-up history without any new UI concept.

## 5. Outbound sending capability (new, in `graphClient.ts`)

- `sendWhatsappTemplateMessage({ phoneNumberId, to, templateName, language, variables })` — `POST /{phone-number-id}/messages` with `type: "template"`, used for the opening message and any re-engagement after the 24h window has lapsed.
- `sendWhatsappTextMessage({ phoneNumberId, to, body })` — free-form `type: "text"`, only ever called when `windowExpiresAt` on the session is still in the future (enforced in application code, not left to the caller to remember).
- Both go through the same access-token/error-handling conventions already established in `graphClient.ts` for every other Graph call, and never log message bodies or tokens (same discipline as the rest of this codebase's Meta integration).

## 6. Concurrency & session isolation — the part you specifically flagged

Two distinct concurrency problems, both need explicit handling:

**A. Two different leads' conversations must never cross-contaminate.** Every piece of state (transcript, campaign snapshot, reply-intent classification) is scoped by `sessionId`/`leadId`, never by phone-number-string alone in memory or in a shared variable — each QStash job processes exactly one session row, identified by its id, and reads/writes only that row and its own `whatsapp_followup_messages`. Two sessions being worked at the same instant (different leads texting back at the same time, or two scheduled sends firing together) run as fully independent QStash deliveries with no shared mutable state between them — this falls out naturally from the existing "one durable row → one queue message → one handler invocation" pattern already used for inbound leads, as long as the handler never widens its query beyond the one `sessionId` it was given.

**B. The same lead's session must not be processed twice at once.** This is the real race: an inbound reply arrives via webhook *at the same moment* a scheduled follow-up send fires for that same lead (both are separate QStash deliveries that both want to touch the same session row) — without a lock, you could get an outbound template sent after the lead already replied, or two outbound sends racing each other. Fix: a **row-level lock on the session**, acquired via `SELECT ... FOR UPDATE SKIP LOCKED` (or the `lockedUntil`/`lockedBy` columns from §4 as a lighter-weight alternative if Postgres advisory locks are preferred) at the start of every handler that touches a session, released at the end. `SKIP LOCKED` means a second concurrent attempt on the *same* session doesn't block and pile up — it just re-queues itself for a moment later (mirroring QStash's own retry behavior) rather than holding a worker open waiting. Sessions for *different* leads never contend for the same lock, so this adds no cross-lead serialization at all — full parallelism across leads, strict serialization within one lead's session.

**C. Idempotency, same convention as the rest of this codebase.** Every inbound webhook delivery is deduped on `(tenantId, waMessageId)` exactly like `whatsapp_message_events` already does. Every outbound send is deduped by session id + a monotonic `attemptCount`, so a QStash retry of an outbound-send job can never double-send the same message — it checks the session's current state first and no-ops if that state already reflects the send having happened (the same "idempotent by construction" posture the migration scripts and the lead pipelines already rely on).

## 7. Trigger & scheduling logic

- A new lead lands (via either the existing Instant-Form or WhatsApp-inbound pipeline) → a `whatsapp_followup_sessions` row is created in `pending` state, `nextAttemptAt` set per a configurable delay (e.g. "5 minutes after capture" for a WhatsApp-approach lead who's already messaged, "next business hour" for an Instant-Form lead who hasn't).
- The existing 15-minute reconciliation sweep (already running for token refresh, unenqueued-event retries, and Phase 14's downgrade sweep) gains one more check: any session with `nextAttemptAt <= now()` and state `pending`/eligible-for-retry gets enqueued to QStash for sending — no new cron, no new Vercel Function, same posture as every other periodic job in this app.
- A configurable cadence (e.g. up to N re-engagement attempts, each requiring a fresh template send once the 24h window has lapsed with no reply) before a session auto-closes as `no_response` and logs a `lead_follow_ups` entry so a salesperson sees it needs a human touch.

## 8. Reply handling & intent classification

- An inbound WhatsApp message for a phone number with an open `whatsapp_followup_sessions` row routes through the *existing* `processWhatsAppMessageEvent.ts` path first (unchanged — it still creates/updates the `leads` row as it does today), then a new step checks for a matching open session and appends to `whatsapp_followup_messages`, refreshes `windowExpiresAt`, and classifies intent.
- **Recommended for MVP: fixed WhatsApp quick-reply buttons** ("Yes, interested" / "Not right now" / "Stop") on the template message rather than free-text NLU — this makes intent classification a deterministic button-id lookup, not a language-understanding problem, and keeps this phase's scope bounded. Free-text replies still get logged to the transcript and flagged for a human to read, but don't need to be auto-classified in v1. (A later phase can layer in actual language understanding once the button-based flow is proven — flagged as a deliberate scope boundary, not an oversight, matching how this project has scoped every other phase.)
- "Yes, interested" → advance `pipelineStage` (to whatever stage the company's industry template marks as its post-contact stage), assign/notify `ownerId` if already set. "Not right now" → log outcome, clear the session. "Stop" → hard opt-out (see §9). Every outcome writes one `lead_follow_ups` row so it's visible in the existing Pipeline UI with zero new UI surface required for that part.

## 9. Compliance: opt-out handling

- A `STOP`/`stop` reply (or the button) sets a durable, tenant-and-phone-scoped opt-out flag that every future scheduling check consults *before* enqueueing any send — this needs to be checked independently of any one session row, since the same phone number could theoretically generate a new lead later. Simplest correct model: a small `whatsapp_opt_outs` table (`tenantId`, `phoneNumber`, `optedOutAt`), consulted by the reconciliation sweep before it ever enqueues a send.
- This is a hard requirement, not a nice-to-have — WhatsApp Business Platform policy requires honoring opt-outs, and getting this wrong risks the tenant's WABA being restricted.

## 10. Admin/UI surface (kept minimal for Phase 2)

- A new section under `settings/integrations/meta-status.html` (or a new settings page) showing: which template is active for follow-ups, per-session status counts (sent/awaiting/replied/opted-out), and a manual "pause follow-ups for this campaign/company" toggle — reusing the existing settings-page conventions rather than inventing new ones.
- No new Vercel Function needed — folds into the existing `api/campaigns/handler.ts` or `api/system.ts` `?resource=` dispatch, same pattern as every prior feature.

## 11. Suggested build order (sub-phases within this Phase 2)

1. **2a — Outbound capability + data model.** `graphClient.ts` send functions, the three new tables, one guarded migration. No scheduling yet — a manual "send test follow-up" script only, verified against a disposable local Postgres exactly like every migration in this engagement.
2. **2b — Session lock + idempotent send/retry path.** The `SKIP LOCKED` concurrency mechanism from §6, wired through QStash with the same durable-row-before-ack pattern as the rest of the app. This is the part worth the most test investment given the concurrency requirement — plan for an explicit test that fires two concurrent handler invocations at the same session and asserts only one send happens.
3. **2c — Scheduling + reconciliation hook.** Trigger logic, the reconciliation-sweep addition, opt-out table and the check that gates every send on it.
4. **2d — Reply handling + pipeline integration.** Button-based intent classification, `lead_follow_ups` writes, pipeline-stage advancement.
5. **2e — Admin surface + entitlement gating.** Settings UI, wiring `isLeadIngestionBlocked` (or a sibling check) into the send path so a lapsed trial/subscription stops follow-ups the same way it already stops new lead ingestion.
6. **2f — End-to-end verification.** Same standard this engagement has held throughout: a disposable local Postgres, the full migration chain re-run and verified idempotent, the full `vitest` suite re-run with zero regressions, and a dedicated concurrency test for §6 before anything ships.

## 12. Open decisions needed before 2a starts

- **Template content & approval**: exact wording of the opening template message(s) per industry/campaign, and who submits them to Meta for approval (this app can't get a template approved on your behalf — that's a Meta Business Manager action).
- **Consent/opt-in basis**: whether every WhatsApp-approach lead is treated as pre-consented (arrived via a WhatsApp-destination ad) versus requiring an explicit additional opt-in step — this is a compliance call, not a technical one.
- **Cadence**: how many follow-up attempts, spaced how far apart, before a session auto-closes.
- **Scope of intent handling**: confirm the button-only MVP (§8) is acceptable for this phase, versus wanting free-text understanding from day one.
- **Per-tenant on/off**: whether this ships as always-on for every WhatsApp-connected tenant, or as an opt-in feature toggle per company (recommended, given it's a new automated outbound channel with real compliance exposure).

---

Nothing above has been built yet. Once these open decisions are answered, 2a can start the same way every prior feature in this project has: a guarded migration, verified locally against a disposable Postgres before ever touching UAT or production.
