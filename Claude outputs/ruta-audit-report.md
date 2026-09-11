# RUTA LMS — Pre-Build Audit Report

Scope: existing WhatsApp functionality, onboarding, auth/users/roles, multi-tenant architecture, leads/campaigns/pipeline, Meta integration, database, session/conversation handling, and a dedicated multi-user + multi-tenant isolation check on the RUTA AI Assistant. Read-only — no code was changed while producing this report.

---

## 1. Existing WhatsApp functionality

Two fully separate pipelines share one Meta webhook endpoint, split by a single routing check made *before* any durability write:

- **Customer/lead-facing WhatsApp** (unaffected by any RUTA AI Assistant work): inbound message → `captureWhatsappEvents` → `whatsapp_message_events` row → QStash → `processWhatsAppMessageEvent.ts` → new/updated `leads` row. Still fully live, still the default outcome for any message from a number that isn't a linked teammate.
- **RUTA AI Assistant** (internal, mandatory, auto-provisioned): `isRutaAssistantMessage(tenantId, fromPhoneNumber)` checks only `userWhatsappLinks` — if the sender's phone is linked to an active user in that tenant, the message is diverted to `handleRutaAssistantMessages` and never touches the lead pipeline at all, not even as a durability record.

**Verified safe**: the split is identity-only (never content-based), tenant-scoped at every step, and structurally exclusive — a message can only ever go one way, never both, never neither.

**Cleanup needed — not yet done**: the previous "Link WhatsApp" implementation's two files are still physically present on your machine, just orphaned (nothing imports/links to them anymore):
- `src\application\metaSync\whatsappQueryBot.ts`
- `public\settings\whatsapp-bot.html`

I couldn't delete these — the device shell still hits `sandbox-helper: no Plan9 drive shares mounted`, the same issue from earlier. Please delete them manually.

---

## 2. Onboarding

Four distinct paths, all converging on `createCompany`/`createUser`:

| Path | Entry point | Role(s) seeded | Wizard? |
|---|---|---|---|
| Individual signup | `registerCompanyAndOwner`, `auth.ts:137` | single "Owner" (`ALL_PERMISSIONS`) | Yes — 6-step wizard |
| Agency signup | same function, `accountType="agency"` | `AGENCY_OWNER/ADMIN/MANAGER/USER` | No — straight to dashboard |
| Agency-invited client (self-service) | `completeAgencyOnboarding`, `agencyOnboarding.ts:226` | `CLIENT_OWNER/ADMIN/MANAGER/USER` | No |
| Admin-added teammate | `api/admin/users/handler.ts` POST | uses existing role | No — joins existing tenant |

Phone number is now required on every path (individual/agency signup already required it; admin-added teammate now requires it too, per this session's RUTA AI Assistant work).

---

## 3. Auth / users / roles

- **Session model**: signed JWT access token (60 min) + opaque refresh token (30 days "remember me" / 24h otherwise), refresh rotates on every use, reuse of a revoked refresh token triggers full session-family revocation. Solid, tested (`refreshTokenReuse.test.ts`).
- **Roles**: fixed, uneditable system roles per account type (Owner; Agency 4-tier; Client 4-tier) plus fully custom per-company roles. Permissions are a flat string-array catalog (`permissions.ts`).
- **"Full access" auto-heal**: Owner/AGENCY_OWNER/CLIENT_OWNER don't trust their stored permissions snapshot — it's recomputed live from the fixed-role catalog at token-issue time, so new permissions added later apply retroactively without a data migration. This mechanism is *why* Finding A below happened (see below).

---

## 4. Multi-tenant architecture

Tenant identity (`companyId`) is derived server-side at login/refresh from the authenticated user row — never client-supplied. Every repository function that matters takes `companyId` as an explicit parameter. Two lower-level lookups (`getUserById`, `getCompanyById`) are deliberately *not* self-scoped ("repository trusts its caller") — every current call site does check company ownership afterward, but it's a pattern risk for future code, not a current gap.

Background sweeps (token refresh, lead reconciliation) fetch globally across tenants by necessity but re-scope every write to that iteration's own tenant — no cross-tenant write risk found.

---

## 5. Leads / campaigns / pipeline

- Lead isolation is enforced at the query layer: every read/write is `WHERE company_id = ? [AND branch_id condition]`, folded directly into the same statement as the mutation (no read-then-write race).
- Pipeline stages are industry-template-driven (`industryTemplates.ts`), not a fixed enum — confirmed current. The old `PIPELINE_STAGES` constant in `permissions.ts` is self-marked `@deprecated` and has zero remaining call sites — dead code, safe to delete.
- **Two parallel Meta-lead mechanisms still coexist**: the legacy per-campaign `webhookConfigs` system (still fully live — `handleWebhook` in `api/campaigns/handler.ts` is a real, callable endpoint) and the newer tenant-level OAuth integration. `legacyMigration.ts` is a read-only advisor bridging the two; it's an ongoing feature, not a stale one-time script — don't delete it.

**Orphaned tables found**: `platformPackages` and `platformBillingCycleDiscounts` (schema.ts) have zero code references anywhere; their own comments say `src/application/pricing.ts` is meant to read them, but that file doesn't exist in the codebase. Migrated into the DB (migration 0034) but never wired up.

---

## 6. Meta integration

Full surface mapped: OAuth connect → asset discovery (Pages/Instagram/Ad Accounts/WhatsApp) → webhook subscription → two payload pipelines (Leadgen, WhatsApp), both landing on `api/webhooks/meta/handler.ts` and branching on the payload's `object` field. Tenant resolution never trusts the payload — always via a stored relationship (`getSubscribedMetaPagesByPageId` / `getTenantsBySelectedWhatsappPhoneNumberId`). No cross-tenant risk found in this layer; every exported function has a live call site (no dead code here).

---

## 7. Database

**Migration/snapshot gap — confirmed directly, worth fixing before the next `drizzle-kit generate`:**

```
drizzle/*.sql              → 36 files present, 0000 through 0035
drizzle/meta/*_snapshot.json → present for 0000–0026 and 0028 only
                              MISSING for 0027 and 0029–0035
```

`_journal.json` itself is complete and internally consistent (all 36 entries, tags match filenames) — only the snapshot cache is behind. Practical risk: running `drizzle-kit generate` next would diff against the stale 0026 snapshot and likely try to re-`CREATE TABLE` everything added since (WhatsApp lead capture, trial/subscription, platform admin, platform packages, the RUTA assistant tables), colliding with a database where those already exist. **Fix before your next schema change**: regenerate the missing snapshots from the live DB state, or use `drizzle-kit introspect`/a manual snapshot rebuild, before trusting `generate` again. I have not attempted this — it needs the actual database connection.

---

## 8. Multi-user + multi-tenant session isolation — dedicated check

| # | Area | Verdict | Severity |
|---|---|---|---|
| 1 | Cross-tenant isolation (assistant routing, `getUserWhatsappLinkByPhone`) | **Safe** | — |
| 2a | `RUTA_AI_ASSISTANT_BROAD_QUERY` auto-granted to every Owner/Admin role | **Risk — confirmed** | **High** |
| 2b | Teammate-name search in "update on X" is ungated | **Risk** | Medium |
| 2c | Numbered-pick resolve for a *lead* skips re-authorization | **Risk** | Low–Medium |
| 3 | Zero-verification phone linking (typo / reassigned number) | **Risk (accepted by design)** | Medium |
| 4 | `pendingQueryContext` per-user conversation state scoping | **Safe** | — |
| 5 | Disabled-user WhatsApp teardown isn't atomic / no error handling | **Risk** | Medium |
| 6 | Azure OpenAI request/response boundary | **Safe** | — |

### The one finding that matters most: 2a

I independently re-verified this myself, not just from the sub-audit:

```
fixedRoles.ts:35   BASE_ALL_PERMISSIONS = ALL_PERMISSIONS.filter(p => p !== AGENCY_CLIENTS_VIEW_ALL)
tenancy.ts:299-312 createOwnerRole() -> permissions: ALL_PERMISSIONS   (literal, not filtered at all)
```

`RUTA_AI_ASSISTANT_BROAD_QUERY` is **not** excluded the way `AGENCY_CLIENTS_VIEW_ALL` is. Every single-company "Owner" role — the default, most common role in the system — is seeded with `ALL_PERMISSIONS` outright, and every Agency/Client Owner/Admin tier inherits it through `BASE_ALL_PERMISSIONS`. This directly contradicts `permissions.ts`'s own documented intent ("deliberately off by default for every role, including Owner... opt-in, never inherited"). Worse: these are all `isSystem: true` roles, which `api/admin/roles/handler.ts` hard-blocks from being edited — **there is currently no way for a company admin to turn this off**, short of a direct DB fix.

This isn't something introduced by the RUTA AI Assistant work — it's a pre-existing gap in role-seeding — but it directly defeats the one permission gate that work's whole "own-data-only unless granted" design relies on. Recommended fix (not yet applied, per your instruction): exclude `RUTA_AI_ASSISTANT_BROAD_QUERY` from `BASE_ALL_PERMISSIONS` the same way `AGENCY_CLIENTS_VIEW_ALL` already is, plus a one-time cleanup pass to strip it from any already-seeded system roles in the live database (can't be done via the app UI since system roles are locked).

### Also worth fixing, lower priority

- **2b**: `handleUpdateOnX`'s teammate search always searches every active user company-wide, regardless of `hasBroadGrant` — only the *lead* search is scope-gated. A user without the broad grant can still enumerate teammate names (not their data) via the multi-match disambiguation list.
- **2c**: the numbered-pick resolve path re-checks the broad grant for a *teammate* pick but not for a *lead* pick — an asymmetry worth closing.
- **5**: `api/admin/users/handler.ts`'s disable-user branch calls `updateUser` then `deleteUserWhatsappLink` with no transaction and no try/catch — if the second call throws, the user is disabled in the database but keeps WhatsApp assistant access until someone notices.
- **3**: the zero-verification activation model (your explicit choice) means a typo'd or later-reassigned phone number gets real CRM access with no confirmation step and no automatic expiry. Not a bug — a tradeoff you already made deliberately — flagging again here since it compounds with 2a (a mistyped number for an Owner-tier account currently gets company-wide access, not just that person's own data).

---

## Summary: what's safe to build on vs. what needs a decision first

**Solid, reusable as-is**: auth/session model, tenant isolation at the query layer, industry-template pipeline stages, Meta webhook routing (both leadgen and WhatsApp), the RUTA Assistant's tenant-boundary and Azure OpenAI boundary.

**Needs a decision before more RUTA AI Assistant work**: Finding 2a. Any further feature work on the assistant (more intents, more data exposed) inherits this gap until it's fixed, since "own data only by default" isn't actually true today for the majority of real accounts.

**Safe cleanup, no functional risk**: delete the two orphaned WhatsApp files (device shell permitting), delete the dead `PIPELINE_STAGES`/`PIPELINE_STAGE_KEYS` export, decide whether to finish or remove `platformPackages`/`platformBillingCycleDiscounts`.

**Needs attention before your next migration**: regenerate the missing drizzle snapshots (0027, 0029–0035).

I haven't made any code changes. Let me know which of these you want tackled first — my recommendation would be 2a before anything else, since it's the one that actively undermines a security boundary already in production.
