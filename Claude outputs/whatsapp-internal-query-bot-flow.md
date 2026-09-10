> **Status:** design locked (2026-09-10) — one real prerequisite before full build. This replaces the earlier "outbound follow-up bot to leads" direction (see `claude/whatsapp-followup-bot-phase2-plan.md`, now marked superseded). Confirmed: each linked user gets their own isolated session, resolved fresh per message, never merged with another user's (§5). Logistics questions are locked to their stated defaults (§7). "Update on X" auto-detects whether X is a lead or a RUTA teammate (§3). Free text beyond the suggested phrasing is now handled via a pattern-match-first, Azure-OpenAI-fallback classifier (§3a) — **the one open item is provisioning that Azure OpenAI resource**, which isn't done yet (§3a); everything else can be built in parallel.

# Internal RUTA WhatsApp Query Bot — Flow for Review

**What this is:** a WhatsApp bot for RUTA's *own* users (salespeople, branch admins, owners) to ask the CRM questions from their phone — "how many follow-ups today", "what's the update on lead X" — and get an answer back on WhatsApp. **Not** customer/lead-facing. No message is ever sent to a lead as part of this feature.

This is meaningfully simpler than the outbound-to-leads design it replaces, for one structural reason worth calling out up front: **every conversation is started by the RUTA user texting the bot.** That means every reply the bot sends is always inside the 24-hour free-form messaging window (it's a direct reply to a message that just arrived), so — unlike the lead-outreach design — **no pre-approved Meta message template is required anywhere in this flow.** That removes the biggest piece of external dependency (Meta template approval) from the picture entirely.

---

## 1. Identity: linking a WhatsApp number to a RUTA user

This is the part that has to be right before anything else works, because it's the only thing standing between "a salesperson checks their own numbers" and "a stranger who texts the tenant's WhatsApp number gets CRM data read back to them."

I checked `users.phoneNumber` in the schema — it exists, but it's free-text, unvalidated, and populated today only for an agency's registration "Contact Person" field. It is **not** trustworthy as-is for identity binding (no format guarantee, easily stale, was never meant for this). So this needs its own explicit, verified link step rather than trusting that column:

1. A user goes to **Settings → "Link WhatsApp"** (new, small UI addition) and taps "Generate linking code." The system creates a short-lived (e.g. 10-minute) one-time code tied to their `userId`.
2. They send that code as a message (e.g. `LINK 4F2K9`) from their own WhatsApp to the tenant's connected WhatsApp Business number — the *same* number already connected for lead capture (see §2 for why reusing it is fine).
3. The inbound-message router (§2) recognizes a `LINK <code>` message, matches the code to a pending request, and on success binds `fromPhoneNumber → userId` in a new `user_whatsapp_links` table (unique on `(tenantId, phoneNumber)` — one CRM identity per number, and one linked number per user by default). The bot replies confirming the link.
4. Unlinking works the same way in reverse (Settings → "Unlink," or texting `UNLINK`).

This gives a real, verified, revocable binding — never an assumption based on a loosely-populated field.

## 2. Message routing: one WhatsApp number, two very different behaviors

The tenant's WhatsApp Business number is already receiving inbound messages for lead capture (`processWhatsAppMessageEvent.ts`). This feature adds a branch **at the very top** of that inbound path, before anything else happens:

- **Is the sending number a verified entry in `user_whatsapp_links` for this tenant?**
  - **Yes** → this is an internal query/command. Route to the new query-bot handler. **Do not** run it through the existing lead-capture logic — it must never create or touch a `leads` row.
  - **No** → completely unchanged. Falls through to the existing lead-capture pipeline exactly as it works today.

This avoids needing a second WhatsApp number or any change to how leads text in. The only real risk is a genuine edge case — a RUTA user's own phone number happens to also be the number a lead uses to message the business — which is rare but not impossible (e.g. staff testing the funnel). Flagging this as an open question in §7 rather than quietly picking a resolution.

## 3. Command / intent set for the first version

Two concrete examples you gave, plus the natural adjacent ones — kept small and reviewable rather than trying to cover everything at once:

| # | User asks (example phrasing) | What the bot returns |
|---|---|---|
| 1 | "How many follow-ups today?" / "follow ups today" | Count of `lead_follow_ups` rows the **asking user** logged today (`createdBy = userId`, `createdAt` = today in the company's timezone) |
| 2 | "Update on Rohan Shah" / a name or phone number | **Auto-detected** (confirmed): checks both a lead match and a RUTA-teammate match for that name/number (see below) and answers accordingly |
| 3 | "My leads today" | Count/list of leads newly assigned to or created for this user today |
| 4 | "Pending follow-ups" | Leads with `nextFollowUpAt` due today or overdue, scoped the same way as #2's lead branch |
| 5 | `HELP` | Short list of what the bot understands |

**#2, confirmed as "both, auto-detected":** when the asked-about name/number doesn't obviously say "lead" or "person on my team," the bot checks both:

- **Lead match** — against leads the asking user is allowed to see (their own `ownerId`, or branch/company-wide only if §4's opt-in grant applies). Returns that lead's `pipelineStage`, `nextFollowUpAt`, and the most recent `lead_follow_ups` remark.
- **RUTA-teammate match** — against `users` in the same company (e.g. "what has Priya done today"). Returns that teammate's `lead_follow_ups` logged today (count + short list) — **only reachable if the asking user has §4's broad-query grant**; a regular salesperson asking about someone else's activity gets a plain "you don't have access to other users' activity" rather than a silent empty result, so they don't mistake "no access" for "empty."

Resolution when matching name/phone against either pool:
- **No match in either pool** → "No lead or teammate found matching '<query>'."
- **Match in exactly one pool** → answer directly from that pool.
- **Match in both pools** (e.g. a name that's both a lead and a teammate) → numbered disambiguation: "1. Rohan Shah — lead, 98xxx1234 · 2. Rohan Shah — teammate — reply with a number."
- **Multiple matches within one pool** (e.g. two leads named "Rohan") → same numbered-list pattern as before: "1. Rohan Shah — 98xxx1234, 2. Rohan Mehta — 97xxx5678 — reply with a number."

All of these disambiguation prompts use the same per-user `pending_query_context` session state from §5.

## 3a. Free-text understanding — beyond the suggested phrasing

You asked for this explicitly: a teammate shouldn't be limited to the exact suggested phrasings — they should be able to type a question in their own words and still get answered. Two-tier design, cheapest path first:

1. **Fast pattern match (no cost, no external call).** Covers `HELP`, `LINK`/`UNLINK`, and the obvious phrasings/synonyms of the five commands in §3 ("follow ups today", "how many today", "my leads", "pending stuff", etc). This is what most messages hit, and it costs nothing.
2. **Model fallback for anything that doesn't match.** A single classification call maps the free text into the **exact same fixed intent set** from §3 (plus extracting a name/phone entity when the intent needs one) — it does not grant the bot any new capability, it only gets better at recognizing requests already in scope. If the model isn't confident the text maps to a known intent, the bot replies plainly — *"Didn't catch that — try HELP for what I understand"* — rather than guessing or fabricating an answer.

Because the response space is identical regardless of which tier matched, this doesn't loosen §4's authorization or §5's session isolation at all — the classifier's only job is picking one of five known intents (plus an entity), never constructing or running a query itself.

### Where the answer actually comes from — the model never touches the database

This is worth stating precisely, since it's the whole point of keeping the answer trustworthy: **the model has no path to your database, and it never composes the answer.** It only classifies.

```mermaid
sequenceDiagram
    participant U as RUTA user (WhatsApp)
    participant App as App webhook handler
    participant AI as Azure OpenAI deployment
    participant DB as Neon Postgres (Drizzle)

    U->>App: Free-text message
    App->>AI: Send only this message's raw text
    Note right of AI: No DB credentials, no network<br/>path to Neon, no tools that reach it
    AI-->>App: One of 5 fixed function calls<br/>+ extracted name/phone, or "none"
    App->>App: Validate the call is one of the<br/>5 known functions; treat entity<br/>as a plain search string only
    App->>DB: Run the matching hard-coded,<br/>parameterized query,<br/>scoped by tenantId + userId
    DB-->>App: Real rows
    App->>App: Build the reply text from<br/>those rows only - never from<br/>the model's own knowledge
    App-->>U: Reply on WhatsApp
```

- **What leaves your system:** only the single inbound message's text, sent to Azure OpenAI for classification.
- **What comes back:** a label naming one of the five known query types, plus a plain search string (a name or phone number) — never data, never prose, never an answer.
- **Function calling, not free generation:** the Azure OpenAI call uses structured function calling against a fixed schema of exactly five functions (`followUpsToday`, `updateOnX`, `myLeadsToday`, `pendingFollowUps`, `help`). The model can only pick one of these (or none, triggering the "didn't catch that" reply) — it cannot invent a sixth function, emit SQL, or return free-form text as the answer.
- **The actual answer is always assembled by your own app code** from the real rows a normal Drizzle query returns — the same query path a pattern-matched message would hit. If a query returns zero rows, the reply says so; the model is never asked to "answer the question" from its own knowledge, so there is no path for it to guess or hallucinate a follow-up count or a pipeline stage.

**Model/provider — confirmed as Azure OpenAI Service**, calling a model deployment on your own Azure OpenAI resource (not the public multi-tenant OpenAI API). Chosen for data residency — the classifier sees real names and phone numbers from queries — and to sit inside your existing Azure footprint if you have one.

**Open prerequisite — not yet provisioned.** You don't have an Azure OpenAI resource yet. Before this specific piece can go live, it needs:
- An Azure OpenAI resource created in a suitable region (an India region, if data residency matters for this data).
- A model deployment on that resource — a small, fast chat model (e.g. `gpt-4o-mini`) is enough for a five-way classification task; no need for a large/expensive model.
- Three new secrets, following this codebase's existing `getEnv()`/UAT-prefix convention (the same pattern `QSTASH_TOKEN` already uses): `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT_NAME` — added to Vercel's env vars and to the UAT GitHub Actions secrets.

**This doesn't block starting the build.** Pattern-matching alone already covers HELP/LINK/UNLINK and the five example commands as given. Until the Azure resource exists, the fallback tier degrades gracefully to *"Didn't catch that — try HELP"* for anything outside the fixed phrasings, and lights up automatically the moment the three env vars are set — no code change needed at that point.

## 4. Authorization — scoped tighter than the web app, on purpose

WhatsApp is a much weaker identity channel than an authenticated browser session (no password, no MFA, just possession of a phone number), so this bot is deliberately **more conservative** than what the same user could see logged into the CRM directly:

- **Default scope: "your own," always.** A regular salesperson's queries only ever return their own leads/follow-ups (`ownerId = userId` / `createdBy = userId`) — never company-wide or branch-wide data, regardless of what their actual RBAC role would technically permit inside the web app.
- **Company-wide/branch-wide answers are opt-in per role**, not default — even for an Owner or Admin. If you want managers to be able to ask "how many follow-ups did the team log today," that's a deliberate, explicitly-flagged capability (e.g. gated on the same permission catalog `src/domain/permissions.ts` already uses, with a distinct "WhatsApp broad query" grant) rather than something that falls out automatically from their existing web-app role. Recommending this as opt-in and off by default until you confirm you want it.
- Every query still resolves through the existing `companyId` tenant-isolation convention this codebase enforces everywhere else — a linked number can only ever see its own tenant's data, full stop.

## 5. Session model — one isolated session per linked user (confirmed)

Per your steer ("bot will answer each and everyone's answer as per the session maintained") — this is exactly how §5 was already designed, now confirmed as the locked-in model rather than a proposal:

- Every linked user (`userId`) has their own lightweight **conversation session**, keyed strictly by `(tenantId, userId)` and resolved fresh from `user_whatsapp_links` on each inbound message. Two different users' messages arriving at the same instant are two fully independent, isolated executions by construction — there is no shared/global state and no session object that could be reused or merged between them.
- Each inbound message is processed **synchronously within the webhook response** where possible (a `COUNT`/`SELECT` against already-indexed columns is fast; no external side effects to worry about, unlike sending a lead a message) — no queue needed for the common case, a deliberate simplification versus the outbound-to-leads design that did need durable queuing.
- A session carries a small amount of short-lived context so a user's own follow-up messages resolve naturally within their own thread — right now that's just the numbered-list **disambiguation** case (§3, "reply with a number"): a `pending_query_context` scoped strictly to that `userId`, expiring after a couple of minutes. A fresh new question from the same user simply overwrites/clears their own pending state. Nothing about one user's session is ever visible to, or mergeable with, another's — same "one lock, one identity, no cross-contamination" principle the concurrency requirement called for on the last design, just applied to a much lighter piece of state here since there's no outbound send to serialize.
- If a query ever needs to do something slower (e.g. a broad company-wide report once §4's opt-in capability exists), that's the case worth queuing through QStash rather than holding the webhook open — same durable-row pattern as the rest of this app, deferred until that capability is actually requested.

## 6. Flow diagram

```mermaid
flowchart TD
    A[Inbound WhatsApp message arrives] --> B{From number is in\nuser_whatsapp_links\nfor this tenant?}
    B -- No --> C[Existing lead-capture pipeline\n(unchanged, processWhatsAppMessageEvent.ts)]
    B -- Yes --> D{Message is a\nLINK/UNLINK command?}
    D -- Yes --> E[Verify/clear code,\nupdate user_whatsapp_links,\nreply with confirmation]
    D -- No --> F{Matches a pending\nclarification for this user?}
    F -- Yes --> G[Resolve using the numbered\nreply, clear pending state]
    F -- No --> P{Matches a known\npattern/synonym?}
    P -- Yes --> H[Map to fixed intent]
    P -- No --> AI[Classify via Azure OpenAI\ndeployment - same fixed\nintent set + entity extraction]
    AI --> C2{Confident match?}
    C2 -- No --> C3[Reply: didn't catch that,\ntry HELP]
    C2 -- Yes --> H
    G --> I
    H --> I{Ambiguous match\n(multiple leads)?}
    I -- Yes --> J[Store pending_query_context\nfor this userId,\nreply with numbered options]
    I -- No --> K[Run scoped query:\ncompanyId + userId always,\nbroader scope only if\nexplicitly granted]
    K --> L[Reply on WhatsApp\nwith the answer]
    J --> M[Wait for user's next message]
    M --> F
```

## 7. Decisions

1. **"Update on X" meaning** (§3): auto-detected — checks both lead and RUTA-teammate matches, disambiguates if both hit, and gates teammate-activity answers behind §4's broad-query grant.
2. **WhatsApp number**: reuse the existing tenant number (§2) rather than a second, dedicated one.
3. **Company/branch-wide queries**: off by default for everyone, including Owner/Admin (§4) — nobody gets broad-scope answers until this is explicitly turned on later.
4. **A RUTA user's number also being a lead's number** (§2 edge case): accepted as a known rare edge case, no special handling for now.
5. **Linking**: self-serve only (Settings → Link WhatsApp, §1) — no admin-assisted linking on someone else's behalf for now.
6. **Timezone** for "today" in follow-up counts: the company's existing timezone setting (already collected at onboarding), not server UTC or device time.
7. **Free-text beyond the suggested phrasing** (§3a): pattern-match first, Azure OpenAI model-deployment fallback for anything else, both constrained to the same fixed intent set.

**One open prerequisite, not a design question:** the Azure OpenAI resource + model deployment for §3a doesn't exist yet — needs to be provisioned (resource, region, deployment, three env vars) before the free-text fallback can go live. Nothing else here is blocked by it.

This is otherwise a normal build: one small migration (`user_whatsapp_links` + the lightweight pending-clarification/session state), a routing branch added to the existing webhook handler, the pattern-match + classifier-fallback intent parser, and the query handlers themselves — no new Vercel Function needed, folding into the existing webhook dispatch the same way every other WhatsApp-adjacent feature in this codebase has.
