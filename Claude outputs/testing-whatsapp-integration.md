# Testing the WhatsApp integration end to end

This app has **two independent WhatsApp flows sharing one webhook endpoint**
(`/api/webhooks/meta/leadgen`, GET for Meta's verification handshake, POST for
real events). Meta delivers every subscribed product for your App to that one
Callback URL; the handler branches on the payload's own `object` field and,
for `whatsapp_business_account`, further branches per-message on whether the
sender's phone number is a linked RUTA user:

```
Inbound WhatsApp message
        │
        ▼
Is fromPhoneNumber a row in crm.user_whatsapp_links for this tenant?
        │
   ┌────┴────┐
  YES         NO
   │           │
   ▼           ▼
RUTA AI      WhatsApp Lead Capture
Assistant    (creates/updates a Lead,
(query bot,  lead_approach = "whatsapp")
never touches
leads table)
```

Test both flows. They're easy to tell apart by which phone number you send
from: a number set as a *user's* `phoneNumber` in Settings → Users always hits
the RUTA Assistant branch; any other number always hits Lead Capture.

---

## 0. Prerequisites checklist

Confirm these before testing — a failure in any of them looks like "nothing
happened" with no obvious error on the WhatsApp side:

- [ ] `META_APP_ID` / `META_APP_SECRET` / `META_WEBHOOK_VERIFY_TOKEN` set (Vercel env vars).
- [ ] Meta App Dashboard → your App → Webhooks: Callback URL is
      `https://<your-domain>/api/webhooks/meta/leadgen`, Verify Token matches
      `META_WEBHOOK_VERIFY_TOKEN`, subscribed to both `leadgen` and `messages`
      fields (or the WhatsApp product's fields) — check the Subscriptions column
      isn't empty.
- [ ] A tenant has completed **Settings → Integrations → Meta** and connected
      a Page/Ad Account, and (separately) a WhatsApp Business Account was
      discovered under **Settings → Integrations → Meta Status** — the "WhatsApp
      (ad destination)" row shows a number and, ideally, a healthy webhook
      status (see `webhookSubscribed`/`webhookStatus` there — this is a
      different, asset-level subscribe step from the App-level one above; both
      are required).
- [ ] Migrations `0027` through `0039` (WhatsApp lead capture, webhook
      subscription, RUTA conversation context, insights, observability) have
      actually run against the database you're testing against — spot-check
      with `psql "$DATABASE_URL" -c "\d crm.user_whatsapp_links"` and
      `\d crm.ruta_insights`. A missing table/column here means a migration
      never applied, not a bug in the flow you're about to test.
- [ ] At least one Admin/Owner user exists to create test users from.
- [ ] Optional, for the free-text (non-pattern-matched) fallback and the
      "compose a natural reply" step: `AZURE_OPENAI_ENDPOINT` /
      `AZURE_OPENAI_API_KEY` / `AZURE_OPENAI_DEPLOYMENT_NAME` set. Without
      these, RUTA still answers every command below via pattern matching and
      its deterministic fallback text — you're only skipping the NLU-fallback
      and AI-phrased-reply tests (12 and, partly, 4).
- [ ] `CRON_SECRET` set, if you want to trigger the insight scan on demand
      (§ Part B) instead of waiting for its schedule.

---

## Part A — RUTA WhatsApp Assistant (internal query bot)

### A1. Activate a test user's RUTA Assistant

There is **no self-serve LINK code** in the current build — a user's RUTA
Assistant activates automatically the moment their profile has a phone
number, and that phone number must **exactly match** the digit string
WhatsApp's Cloud API sends as the message's `from` field: full international
format, digits only, no `+`, no spaces or dashes (e.g. India: `919876543210`,
not `+91 98765 43210`). There's no normalization on either side, so a
mismatched format silently means "the bot never replies," not an error.

1. Log in as an Admin/Owner → **Settings → Users → Add User**.
2. Fill in name/email/role and the **phone number** field exactly as above.
   (`phoneNumber` is a required field precisely because RUTA Assistant is
   mandatory and auto-provisions from it — see the field's own inline note.)
3. Save. This immediately upserts a `crm.user_whatsapp_links` row — no
   separate "link" action, and nothing to do on the WhatsApp side yet.
4. Repeat with a second test user and a second real phone you can send from,
   for the isolation tests in A8/A11.

If you need to test with an *existing* user instead: **Settings → Users →
Edit → phone number field**, same exact-format rule.

### A2. Confirm the webhook handshake (one-time infra check)

```bash
curl -i "https://<your-domain>/api/webhooks/meta/leadgen?hub.mode=subscribe&hub.verify_token=<META_WEBHOOK_VERIFY_TOKEN>&hub.challenge=12345"
```

Expect `200` with the body `12345` echoed back verbatim. A `403` means
`META_WEBHOOK_VERIFY_TOKEN` doesn't match what you passed, or isn't set.

### A3. Basic command — HELP

From the phone you set in A1, send:

```
HELP
```

Expect the fixed capability list (leads/campaigns/follow-ups/pipeline
commands, "why?" for alerts, mute/unmute). This is a pure pattern match
(`/^help$/i`) — it works even with zero AI configured.

### A4. Core CRM query commands

Send each of these from the linked number and confirm a real, current number
comes back (cross-check against the Pipeline/Dashboard pages, not just that
*a* reply arrived):

| You send | Expect |
|---|---|
| `how many leads today` | Today's count, company timezone |
| `my leads today` | Leads assigned to/created for *you* only |
| `pending follow-ups` | Your own overdue/due-today follow-ups |
| `follow-ups today` | Count of follow-ups *you* logged today |
| `update on <a real lead's name>` | That lead's stage/next-follow-up/last note |
| `pipeline summary` | Stage-by-stage breakdown |
| `campaign performance` | Per-campaign lead volume + conversion rate |
| `leads by source` | Source breakdown |

### A5. Multi-turn follow-up (conversation context, Phase F)

Send three messages in sequence, a few seconds apart:

```
How many leads today?
Which campaign gave the most?
What about yesterday?
```

The third message should re-run the *first* question's shape (lead count)
for yesterday, not the campaign breakdown — this is the "anchor" mechanism:
the drill-down (#2) doesn't overwrite the anchor (#1), so a bare date
follow-up returns to it.

### A6. Analytics / explain commands (Phase D)

```
what's the lead trend this week
compare campaigns this week vs last
overall conversion rate this month
team performance this week
any unusual days this month
why did leads decrease this week
```

Each of these is computed entirely in `analyticsTools.ts` — pure TypeScript
arithmetic over real rows — and the AI (if configured) only phrases the
explanation; a wrong or missing number here is a backend bug, never "the AI
got it wrong."

### A7. Disambiguation

Pick (or create) two leads with the same first name, or one lead and one
teammate sharing a name, then send:

```
update on <that shared name>
```

Expect a numbered list ("1. ... 2. ... — reply with a number"), then reply
with just `1` or `2` and confirm it resolves to the right one.

### A8. Authorization scoping (broad-query permission)

1. As a regular (non-broad-grant) user, send `update on <a teammate's name>`
   (not a lead). Expect a plain "you don't have access to other users'
   activity" reply — not an error, not their real data.
2. Grant that role/user the `RUTA_AI_ASSISTANT_BROAD_QUERY` permission
   (Settings → Roles) and resend the same message — now expect the
   teammate's real follow-up activity.
3. Also try `leads by teammate` before/after the grant for the same effect
   on `userLeadCounts`.

### A9. Scope guardrail — "not a general chatbot"

```
what's the weather today
```

Expect the fixed out-of-scope reply ("RUTA AI Assistant only answers
questions about your CRM data..."), never a generic AI answer, never silence.
This works with zero AI configured — it's a code branch, not a model
decision.

### A10. Data-unavailable / no-hallucination guard

Ask about something genuinely absent (a lead/name that doesn't exist, or a
metric this tenant has zero data for):

```
update on Nobody Real
```

Expect either "No lead or teammate found matching '...'" (deterministic) or,
for an AI-composed reply with truly no matching data, the exact string
`I don't have enough RUTA data to answer that yet.` — never a fabricated
number or name. If you have Azure OpenAI configured, this is also where the
grounding/id-leak guards live (Phase G) — a composed reply containing a
number not present in the underlying structured result, or containing any
UUID-shaped token, is discarded and the deterministic fallback is used
instead. There's no user-facing way to force that from WhatsApp alone; it's
covered by `rutaReplyComposer.test.ts` if you want to see it directly.

### A11. Duplicate-delivery / idempotency

Meta redelivers webhooks on a slow/failed ack. To simulate: use the Meta App
Dashboard's Webhooks tab "Test" button twice in a row for the same event, or
send one real message and, if you have access to Meta's webhook delivery
log, trigger a manual redelivery. Expect **exactly one** WhatsApp reply either
way — the second delivery should log `duplicate_message_skipped` server-side
and do nothing.

### A12. Free-text fallback (only if Azure OpenAI is configured)

Send something that matches none of the patterns in A4–A9, phrased in plain
words:

```
hey how many people reached out to us today
```

Expect the classifier to still map this to `leadCount` and answer correctly.
If it doesn't confidently match any of the fixed intents, expect the
out-of-scope reply (A9), never a guess. Check your logs for an `ai_request`
line with `stage: "classify"` to confirm the AI path actually ran (see Part
E).

### A13. Alert controls

```
mute alerts
```
Expect confirmation + no further proactive alerts land (see Part B). Then:
```
unmute alerts
alert settings
```
Confirm settings shows current mute state and quiet-hours window (default
10pm–8am company-local until changed).

---

## Part B — RUTA proactive insight/alert notifications (Phase E)

These fire on a schedule (QStash + a daily Vercel Cron fallback), so for
testing, trigger the scan manually instead of waiting:

```bash
curl -i "https://<your-domain>/api/internal/insights-scan" \
  -H "Authorization: Bearer $CRON_SECRET"
```

Expect `200` with a JSON summary (tenants scanned, insights created, errors).

1. **Set up a condition that should fire** — e.g. leave several leads
   uncontacted, or let a follow-up go overdue for a linked test user — then
   run the curl above.
2. Check `crm.ruta_insights` for a new row (`psql` or a DB tool) — confirm
   `dedupeKey` looks sane and the condition matches something real.
3. Check `crm.ruta_notification_queue` for a row tied to that insight, and
   that the linked recipient (WhatsApp-linked + holding the broad-query
   grant) is who you expect.
4. Confirm the WhatsApp alert actually lands on that recipient's phone —
   format should match `insightRules.ts`'s `buildXMessage` templates (a
   `⚠️ RUTA Alert` line + specifics).
5. **Re-run the same scan immediately** and confirm no duplicate alert is
   sent for the same still-true condition (the `(tenantId, dedupeKey)` unique
   index should make the second `recordInsight` a no-op).
6. **Quiet hours**: mute nothing, but set your recipient's alert-settings
   quiet window (via `alert settings`, or directly in
   `crm.ruta_notification_preferences`) to cover right now, then re-trigger a
   fresh condition — expect the notification queue row's `notBefore` to be
   set to outside the quiet window rather than the alert being skipped
   outright (delayed, not dropped).
7. **Mute**: send `mute alerts` from that user, trigger a fresh condition,
   confirm no delivery and the row records a muted/skipped terminal status
   rather than being retried.
8. **24-hour window gate**: if the recipient hasn't messaged RUTA in the last
   23 hours, a proactive alert is a fresh conversation, not a reply — WhatsApp
   requires a pre-approved message template for that (see the project's own
   "open prerequisite" note). Until a template is provisioned, expect the row
   to fail cleanly with `failure_reason: 'outside_24h_window_no_template_configured'`
   rather than attempting (and losing) the send. Message RUTA once from that
   number first (any command) to reopen the 24h window, then re-test delivery.
9. **"Why?" follow-up**: right after receiving a real alert on WhatsApp,
   reply:
   ```
   Why?
   ```
   Expect the underlying metrics behind that specific alert, via the same
   Structured Result → LLM (or deterministic) reply path as any other query.

---

## Part C — WhatsApp Lead Capture (ad-click / organic inbound leads)

This is the *other* branch — messages from a number that is **not** a linked
RUTA user become Leads, never a bot reply.

1. Confirm **Settings → Integrations → Meta Status** shows a discovered
   WhatsApp number with a healthy webhook status.
2. From a phone number that is **not** set as any user's `phoneNumber`,
   message the tenant's connected WhatsApp Business number (a plain "Hi,
   interested" is enough).
3. Confirm a new row appears in **Pipeline**, with **Lead approach =
   WhatsApp**, and that the phone number/name/message text landed on the
   lead correctly. No reply is ever sent back to this sender — this pipeline
   has no chatbot/auto-reply by design.
4. **Attribution**: click an actual Click-to-WhatsApp ad you have running
   (one whose ad set has `destination_type = WHATSAPP` and has been synced at
   least once) and send the resulting pre-filled message. Confirm the new
   lead shows real Ad/Ad Set/Campaign attribution instead of "Unknown /
   Organic WhatsApp." No referral (a plain, non-ad-originated message, like
   step 2 above) should always show "Unknown / Organic WhatsApp" — never a
   guessed campaign.
5. **Duplicate delivery**: same idempotency expectation as A11 — resend/redeliver
   the same `wamid` and confirm no second lead is created
   (`whatsapp_message_events`'s unique `(tenant_id, wa_message_id)` index).
6. **Idempotency across the two branches**: confirm a message from a linked
   RUTA number *never* creates a lead, even by accident — `leads` should show
   no new row after any of Part A's tests.

---

## Part D — Webhook-level smoke test (curl, no real phone needed)

Useful for CI or a quick sanity check without sending real WhatsApp traffic.
Requires a real, already-synced `phone_number_id` for the tenant you're
testing (from `crm.meta_whatsapp_accounts`, the row with `isSelected = true`)
— a made-up id won't route to any tenant and the event is silently dropped,
which is correct behavior, not a bug.

```bash
BODY='{"object":"whatsapp_business_account","entry":[{"id":"WABA_ID","changes":[{"value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"<real phone_number_id>"},"contacts":[{"profile":{"name":"Test User"},"wa_id":"<a phone NOT linked to any user>"}],"messages":[{"from":"<same phone as wa_id>","id":"wamid.SMOKE_TEST_'"$(date +%s)"'","timestamp":"'"$(date +%s)"'","text":{"body":"Hi, interested"},"type":"text"}]},"field":"messages"}]}]}'

SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | sed 's/^.* //')

curl -i "https://<your-domain>/api/webhooks/meta/leadgen" \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$BODY"
```

Expect `200 {"received":true,"captured":1}`. Change `from`/`wa_id` to a
number that **is** a linked RUTA user's `phoneNumber` and `text.body` to a
real command (e.g. `"HELP"`) to smoke-test the Assistant branch instead —
expect the same `200` ack, and (with `WHATSAPP_ACCESS_TOKEN` etc. configured
for real sends) a real reply sent back via the Cloud API.

A `401 Invalid signature` means the HMAC above doesn't match — double-check
`META_APP_SECRET` is the same one Vercel has configured, and that `$BODY` is
byte-identical between the signature computation and the request body (no
extra newline from a shell variable).

---

## Part E — Observability check (Phase H)

While running any test above, tail your logs (`vercel logs <deployment>
--follow`, or plain console output in local dev) and confirm you see
structured JSON lines like:

```
{"ts":"...","event":"ai_request","request_id":"...","tenant_id":"...","user_id":"...","conversation_id":"...","tool":"leadCount","stage":"classify","latency_ms":842,"status":"ok","tokens":{...}}
{"ts":"...","event":"tool_call","tool":"leadCount","latency_ms":37,"status":"ok"}
{"ts":"...","event":"metric","name":"db.latency","value":12,"unit":"ms","tags":{"driver":"neon-http"}}
```

Confirm none of these ever contain the raw WhatsApp message text, a phone
number, or query bind params — only ids, tool names, timings, and (on
failure) a short technical error string. A WhatsApp send failure should
produce a `whatsapp_delivery_failure` metric/log with `stage` set to either
`"reply"` (Part A) or `"proactive_notification"` (Part B), and a queue
publish failure (force one by temporarily breaking `QSTASH_TOKEN`, then
trigger Part B) should log a `queue_publish_failure`.

---

## Part F — Automated regression suite (run this first)

Before any manual WhatsApp testing, let the existing automated suite catch
regressions for free — it's faster and covers isolation/concurrency/dedupe
cases that are awkward to reproduce by hand:

```bash
npx tsc --noEmit
npx vitest run
```

Needs a real Postgres reachable via `DATABASE_URL` (a disposable local one is
fine — see `scripts/truncate-tenant-tables.ts` if you need to reset it
between runs) and `ENCRYPTION_KEY` set; `*.flow.test.ts` files skip
automatically if `DATABASE_URL` is unset. Relevant files if a manual test
above fails and you want the equivalent automated case:
`rutaAiAssistant.flow.test.ts` (isolation/concurrency/dedupe/scope-guardrail),
`whatsapp.flow.test.ts` (lead capture + attribution + subscription),
`rutaConversationContext.test.ts` (multi-turn/anchor behavior),
`notificationQueue.test.ts` / `notificationDelivery.test.ts` (quiet
hours/mute/cap/24h-window), `provider.test.ts` / `telemetry.test.ts`
(observability).

---

## Common gotchas

- **Phone number format mismatch** is the #1 cause of "the bot never
  replies" — no normalization happens anywhere; the stored `phoneNumber` and
  WhatsApp's `from` field must be byte-identical digit strings.
- **Two separate webhook subscriptions** are required for WhatsApp to work
  at all: the App-level one (Meta Dashboard → Webhooks, checked in A2) and
  the asset-level one (per WhatsApp Business Account, auto-attempted on every
  Meta discovery/resync — check `webhookStatus` on Settings → Integrations →
  Meta Status if messages never arrive server-side at all).
- **Migrations not applied** looks identical to "the feature is broken" —
  always confirm against the environment you're actually testing (local vs.
  UAT vs. production each need their own migration run; see the project
  status doc's several past incidents on this exact point).
- **Proactive alerts silently not sending** is very often the 24h-window
  gate (B8), not a bug — message RUTA once from that number to reopen the
  window before re-testing delivery.
