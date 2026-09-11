// Meta HTTP surface - plus, as of the campaign-limit/Razorpay billing
// feature, a THIRD, entirely unrelated public webhook (see "3." below) -
// share this one file/Vercel Function purely because Vercel's Hobby plan
// caps a deployment at 12 Functions total and this was already the file
// for everything Meta touches over raw HTTP (same reasoning api/admin/
// users/handler.ts documents for folding in /api/branches/*):
//
//   1. The public per-campaign webhook receiver -
//      https://.../api/webhooks/meta/{slug} - unauthenticated, HMAC-verified
//      against that campaign's own app secret (see webhook_configs,
//      configured from the campaign's legacy "Add webhook" screen).
//        GET  -> the one-time subscription verification handshake.
//        POST -> the actual lead notification -> ingestWebhookPayload.
//
//   2. The TENANT-level Meta OAuth connection (Phase 3) -
//      /api/integrations/meta/connect|callback|status - vercel.json rewrites
//      these to this same file with ?resource= injected, dispatched on
//      below BEFORE the slug-based logic (these never carry a slug).
//        GET /connect  -> authenticated; redirects the browser to Meta's
//                          OAuth dialog with a signed, tenant-bound state.
//        GET /callback -> Meta redirects the browser back here with
//                          code+state; validates state, exchanges the code,
//                          stores the connection, redirects into the CRM.
//        GET /status   -> authenticated; view of the tenant's current
//                          connection (no token, masked or otherwise - see
//                          Phase 4) + synced Pages/Instagram accounts/ad
//                          accounts, for the Settings -> Integrations ->
//                          Meta screen (also backs Phase 5's selection
//                          wizard - same synced lists, rendered as radios).
//        POST /disconnect -> authenticated; revokes the tenant's active
//                          connection (Phase 4 "Disconnect" button).
//        POST /select  -> authenticated; Phase 5 - select which Page /
//                          Instagram account / ad account the CRM uses
//                          (single-select each, tenant-scoped).
//        POST /sync    -> authenticated; Phase 6 - runs the full asset
//                          sync pipeline (Pages/Instagram/Ad Accounts, then
//                          Campaigns+AdSets+Ads/Forms scoped to whatever is
//                          selected), publishing live progress to Redis.
//        GET /sync-status -> authenticated; polls the live progress a
//                          POST /sync currently in flight is publishing.
//        POST /webhook/retry -> authenticated; Phase 7 - re-attempts the
//                          automatic Page webhook subscription for
//                          whichever Page this tenant currently has
//                          selected ("Retry" button).
//
//      "Tenant" above is deliberately the EFFECTIVE company, not always the
//      caller's own real one: every handler in this group runs its auth
//      through withEffectiveCompanyContext (same call dashboard/pipeline/
//      leads/campaigns/forms already make) BEFORE touching any Meta table,
//      so an agency user "inside" a client (via the client switcher) reads
//      and writes THAT CLIENT's own Meta connection/Pages/ad accounts/forms,
//      never the agency's own. This is the CRITICAL requirement Meta
//      authentication belongs to the client organization: an agency may
//      assist a client through the connect flow (gated on its own
//      INTEGRATIONS_MANAGE permission, exactly as before), but the resulting
//      connection is always attributed to and stored under the CLIENT's
//      company id - each client authorizes its own Meta assets, and the
//      agency is never left holding one shared connection every client's
//      leads flow through. Outside any active client context (the agency's
//      own Settings screen, or any ordinary non-agency tenant), this is a
//      total no-op - withEffectiveCompanyContext returns the caller's own
//      auth unchanged, exactly like every other handler that calls it.
//
//   3. The APP-LEVEL Meta leadgen webhook receiver, THE CRM-native Meta
//      webhook endpoint (Phase 7, formalized/hardened in Phase 11) -
//      /api/webhooks/meta/leadgen - ONE fixed URL for the whole deployment
//      (every tenant authorizes the same Meta App - see metaOAuth.ts),
//      distinct from the per-campaign receiver in (1). This is what
//      metaWebhookService's callback-URL builder registers as the
//      callback_url going forward, and what Meta calls once a selected
//      Page's leadgen events start flowing. The legacy path
//      /api/webhooks/meta/page-events (Phase 7's original name) still
//      routes here too - kept alive indefinitely as a compatibility alias
//      for any subscription Meta already has registered against it; never
//      remove it without first re-registering every tenant's subscription
//      against /leadgen.
//        GET  -> the app-level subscription verification handshake,
//                checked against META_WEBHOOK_VERIFY_TOKEN.
//        POST -> the actual leadgen notification(s). Phase 11's exact
//                flow, in order:
//                  Validate request    - HMAC signature check against
//                                        META_APP_SECRET, below.
//                  Identify Page       -
//                  Identify Tenant     - resolved ONLY from the stored
//                  Extract leadgen_id  - Page/Meta-connection relationship
//                  Check duplicate     - (metaPages.webhookSubscribed) -
//                  Store raw event     - NEVER trusted from the payload,
//                                        which carries no tenant field at
//                                        all. See captureLeadgenEvents in
//                                        metaLeadEventService.ts for all
//                                        five of these steps.
//                  Return success quickly - res.json(...) is sent the
//                                        instant the durability write
//                                        above completes; nothing after
//                                        it can delay Meta's ack.
//                  Process lead asynchronously - enqueueCapturedLeadgenEvents,
//                                        called only AFTER the response is
//                                        sent (publishes to QStash, which
//                                        triggers processMetaLeadEvent.ts
//                                        in a separate invocation - THAT is
//                                        where the actual Graph API call
//                                        for the lead's full field_data
//                                        happens, never here). A publish
//                                        failure here is logged and
//                                        recovered later by reconcile.ts's
//                                        getUnenqueuedMetaLeadEvents sweep,
//                                        never retried inline and never
//                                        surfaced to Meta (the ack is long
//                                        gone by then).
//
//   4. THE RAZORPAY PAYMENT WEBHOOK - /api/webhooks/razorpay - nothing to
//      do with Meta at all; folded in here purely because this file is
//      already the one place in the deployment that (a) has bodyParser
//      disabled file-wide and (b) already has a raw-body HMAC-signature
//      verification helper to model a second one on (see
//      verifyRazorpaySignature usage below, built directly on
//      verifyMetaSignature's own pattern) - see this file's own top
//      comment for why folding unrelated concerns into an existing
//      Function, rather than creating a 13th, is this deployment's
//      standing answer to the Hobby-plan cap.
//        POST -> Razorpay calls this after a payment event (only
//                "payment.captured" is acted on - see
//                handleRazorpayWebhook below). Verified against
//                RAZORPAY_WEBHOOK_SECRET (a SEPARATE secret from
//                RAZORPAY_KEY_SECRET - configured in the Razorpay
//                Dashboard's own Webhooks screen, not derived from the API
//                keys), then handed to confirmOveragePaymentFromWebhook
//                (src/application/billing.ts) - the AUTHORITATIVE fallback
//                confirmation path for a purchase whose browser-side
//                /api/billing/verify call never completed (tab closed
//                mid-payment, a network blip, etc.). Idempotent by
//                razorpay_order_id - see billingOrders' own doc comment in
//                schema.ts for the full created->paid race this and the
//                browser path both participate in.
//
// bodyParser is disabled for the whole file (Vercel configures it per-file,
// not per-route) so the webhook receivers (Meta's, and now Razorpay's) can
// verify their own signature header against the exact raw bytes each sent -
// the OAuth/select/sync routes below read+parse their own (small,
// trusted-shape) JSON bodies via readJsonBody rather than relying on
// req.body.

import { getEnv } from "../../../src/infrastructure/env";
import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyMetaSignature } from "../../../src/infrastructure/meta/verifySignature";
import { ingestWebhookPayload } from "../../../src/application/ingestWebhook";
import { getWebhookConfigBySlug, markWebhookVerified } from "../../../src/infrastructure/db/repositories/campaigns";
import { getAuthContext, hasPermission, requireAuth, requirePermission } from "../../../src/infrastructure/auth/context";
import { PERMISSIONS } from "../../../src/domain/permissions";
import { withEffectiveCompanyContext } from "../../../src/application/agencyClientContext";
import { createOAuthState, verifyOAuthState } from "../../../src/infrastructure/auth/oauthState";
import { buildAuthorizationUrl, completeMetaConnection, getAppSecret, MetaOAuthConfigError, MetaPermissionError } from "../../../src/application/metaOAuth";
import {
  disconnectActiveMetaConnection,
  getRelevantMetaConnectionView,
  getSelectedMetaPage,
  listMetaAdAccounts,
  listMetaInstagramAccounts,
  listMetaPages,
} from "../../../src/infrastructure/db/repositories/metaIntegration";
import { selectPage, selectInstagramAccount, retryPageWebhook } from "../../../src/application/metaSync/metaPageService";
import { selectWhatsappAccount } from "../../../src/application/metaSync/metaWhatsappWebhookService";
import { selectAdAccount } from "../../../src/application/metaSync/metaAdAccountService";
import { runMetaSync } from "../../../src/application/metaSync/runMetaSync";
import { getMetaSyncProgress } from "../../../src/infrastructure/cache/redis";
import { captureLeadgenEvents, enqueueCapturedLeadgenEvents } from "../../../src/application/metaSync/metaLeadEventService";
import { captureWhatsappEvents, enqueueCapturedWhatsappEvents } from "../../../src/application/metaSync/metaWhatsappEventService";
import { handleRutaAssistantMessages } from "../../../src/application/metaSync/rutaAiAssistant";
import { getUserWhatsappLinkByUserId } from "../../../src/infrastructure/db/repositories/whatsapp";
import {
  getMetaFormById,
  listFieldMappingsForForm,
  listMetaFormsWithMappingCountsForPage,
  saveFieldMappings,
  type SaveFieldMappingInput,
} from "../../../src/infrastructure/db/repositories/metaFormMappings";
import { listMetaCampaignsWithMappingForAdAccount } from "../../../src/infrastructure/db/repositories/metaSync";
import { getLastMetaLeadReceivedAt } from "../../../src/infrastructure/db/repositories";
import { countMetaLeadRoutesByApproach, listMetaWhatsappAccounts } from "../../../src/infrastructure/db/repositories/whatsapp";
import { LEAD_APPROACHES } from "../../../src/domain/leadApproach";
import { verifyRazorpayWebhookSignature } from "../../../src/infrastructure/razorpay/client";
import { confirmOveragePaymentFromWebhook } from "../../../src/application/billing";

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** bodyParser is off for this whole file (see the header comment) - the
 * OAuth/select routes below have small, known-shape JSON bodies, so this
 * just reads the raw bytes and parses them, returning {} for an empty or
 * malformed body rather than throwing (callers validate the fields they
 * actually need). */
async function readJsonBody(req: VercelRequest): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function getQueryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------
// Tenant-level Meta OAuth (Phase 3)
// ---------------------------------------------------------------------

// Where the browser lands after /connect and /callback either way (success
// or failure) - the Settings -> Integrations -> Meta screen reads
// ?connected=1 / ?error=... off this URL to show the right banner. A
// relative path, not an absolute PUBLIC_BASE_URL-built one - the browser
// resolves a redirect's Location header against the current origin either
// way, and this keeps it correct on any preview/staging domain automatically.
// Phase 16: points at the clean status screen (meta-status.html, Phase
// 15's primary entry point for this integration) rather than the full
// configuration screen (meta.html) - reconnecting is exactly the flow that
// screen exists for (its own Reconnect Meta / Needs Reauthorization card),
// and the full wizard/mapping screen stays one click away from there.
const SETTINGS_META_PAGE = "/settings/integrations/meta-status.html";

/** Step 1-3: generate secure state bound to the CALLER'S OWN verified
 * session (never a client-supplied tenantId), then send the browser to
 * Meta. Gated on integrations.manage, same permission the status endpoint
 * and the Settings page itself require.
 *
 * Deliberately does NOT use requirePermission() here like every other
 * handler in this file - this endpoint is reached via a raw top-level
 * browser navigation (`window.location.href = "/api/integrations/meta/
 * connect"` from meta-status.html/meta.html), never through app.js's
 * apiJson() fetch wrapper. requirePermission's usual 401/403 JSON body
 * would just render as raw text in the browser instead of going anywhere -
 * especially easy to hit here specifically, since a real Meta OAuth consent
 * screen (plus any Business Verification/2FA prompts) can run long enough
 * for the access token to have expired by the time this endpoint is even
 * reached. Redirecting to /login.html?next=... instead means the tenant
 * lands back on this exact endpoint (auto-resuming straight into the Meta
 * redirect) right after logging back in, rather than dead-ending. */
async function handleOAuthConnect(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authCtx = await getAuthContext(req);
  if (!authCtx) {
    res.redirect(302, `/login.html?next=${encodeURIComponent("/api/integrations/meta/connect")}`);
    return;
  }
  // Permission check stays against the caller's own real permissions
  // (never swapped by client context - see withEffectiveCompanyContext's
  // own comment) so this is gated on INTEGRATIONS_MANAGE exactly as before,
  // whether the caller is an ordinary tenant or an agency user assisting a
  // client. Only WHICH company the resulting connection belongs to changes.
  if (!hasPermission(authCtx, PERMISSIONS.INTEGRATIONS_MANAGE)) {
    res.redirect(302, `${SETTINGS_META_PAGE}?error=no_permission`);
    return;
  }
  // If an agency user currently has a client "open" (client switcher), the
  // OAuth state below binds tenantId to THAT CLIENT's company id, not the
  // agency's own - so the connection this flow produces is attributed to,
  // and forever scoped to, the client, matching "each client must
  // authorize its own Meta assets."
  const auth = await withEffectiveCompanyContext(req, authCtx);

  try {
    const state = await createOAuthState({ tenantId: auth.companyId, userId: auth.userId });
    res.redirect(302, buildAuthorizationUrl(state));
  } catch (err) {
    // Most likely META_APP_ID/META_APP_SECRET/PUBLIC_BASE_URL missing -
    // a config problem, not something retrying the request fixes.
    console.error("[meta-oauth] Failed to start the connect flow:", err);
    const message = err instanceof MetaOAuthConfigError ? "not_configured" : "connect_failed";
    res.redirect(302, `${SETTINGS_META_PAGE}?error=${message}`);
  }
}

/** Steps 4-12: Meta redirects the browser back here with `code`+`state` (or
 * `error` if the tenant declined the dialog). Tenant identity for
 * everything that follows comes ONLY from the verified state - never from
 * a query param, never from whatever session cookie (if any) happens to be
 * attached to this request. */
async function handleOAuthCallback(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Meta's own decline/error path - e.g. the user clicked "Cancel" on the
  // dialog. Nothing to validate here since no code/state we'd trust was
  // ever issued for this attempt to be replayed.
  const metaError = getQueryString(req, "error");
  if (metaError) {
    res.redirect(302, `${SETTINGS_META_PAGE}?error=${encodeURIComponent(metaError)}`);
    return;
  }

  const code = getQueryString(req, "code");
  const stateToken = getQueryString(req, "state");
  if (!code || !stateToken) {
    res.redirect(302, `${SETTINGS_META_PAGE}?error=missing_params`);
    return;
  }

  // Step 5: validate state - signature, expiry, purpose, and single-use, all
  // inside verifyOAuthState. Any failure here means the whole attempt is
  // invalid; there is nothing left to safely act on.
  const state = await verifyOAuthState(stateToken);
  if (!state) {
    res.redirect(302, `${SETTINGS_META_PAGE}?error=invalid_state`);
    return;
  }

  try {
    // OAuth -> Validate permissions -> Update connection -> Validate Page
    // -> Re-subscribe webhook -> Sync assets (Phase 16) - see
    // completeMetaConnection's own comment for the full pipeline.
    await completeMetaConnection(code, state.tenantId, state.userId);
    // Step 12.
    res.redirect(302, `${SETTINGS_META_PAGE}?connected=1`);
  } catch (err) {
    console.error(`[meta-oauth] Failed to complete connection for tenant ${state.tenantId}:`, err);
    if (err instanceof MetaPermissionError) {
      // Phase 16 - "Validate permissions" failed: name exactly which
      // scopes are missing so the Settings screen's error banner can say
      // so specifically, rather than a generic "connection failed".
      res.redirect(302, `${SETTINGS_META_PAGE}?error=missing_permission&scopes=${encodeURIComponent(err.missingScopes.join(","))}`);
      return;
    }
    const message = err instanceof MetaOAuthConfigError ? "not_configured" : "connect_failed";
    res.redirect(302, `${SETTINGS_META_PAGE}?error=${message}`);
  }
}

/** Status for the Settings -> Integrations -> Meta screen (both the full
 * configuration screen and Phase 15's clean at-a-glance status screen).
 * Never includes the access token in the response, in any form (Phase 4:
 * "Do NOT show access tokens") - getRelevantMetaConnectionView doesn't
 * even decrypt it. Phase 16: uses getRelevantMetaConnectionView (not
 * getActiveMetaConnectionView) so a "needs_reauth" or "error" connection is
 * still returned here instead of silently looking "Not Connected" - see
 * that function's own comment for why this distinction matters. */
async function handleOAuthStatus(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  try {
    // Phase 15 - three extra fields for the clean status screen
    // (campaignsCount, leadFormsCount, lastLeadAt), fetched alongside the
    // existing connection/pages/instagramAccounts/adAccounts in the same
    // Promise.all rather than a second request - this endpoint already
    // backs the full config screen's main card, and the status screen is
    // just a leaner rendering of the same underlying state.
    const [connection, pages, instagramAccounts, adAccounts, lastLeadAt, whatsappAccounts, leadApproachCounts] = await Promise.all([
      getRelevantMetaConnectionView(auth.companyId),
      listMetaPages(auth.companyId),
      listMetaInstagramAccounts(auth.companyId),
      listMetaAdAccounts(auth.companyId),
      getLastMetaLeadReceivedAt(auth.companyId),
      // WhatsApp Lead Capture feature (Phase 19/20) - discovered WhatsApp
      // numbers (Phase 5's picker, only ever shown when more than one was
      // found - see whatsappDiscoveryService.ts's auto-select) and the
      // "Lead approaches detected" breakdown ("12 Instant Form ads, 5
      // WhatsApp ads") the Settings screen surfaces. Both empty/zero for a
      // tenant that never granted whatsapp_business_management - same
      // best-effort, additive-only posture as everything else this feature
      // touches.
      listMetaWhatsappAccounts(auth.companyId),
      countMetaLeadRoutesByApproach(auth.companyId),
    ]);
    // campaignsCount/leadFormsCount are scoped to the CURRENTLY SELECTED ad
    // account / Page only (found from the adAccounts/pages lists already
    // fetched above, no extra query needed) - review finding, same fix as
    // the Campaigns screen's "Meta Campaigns" table (see
    // listMetaCampaignsWithMappingForAdAccount's own comment). Without
    // this, reconnecting Meta with a different ad account or Page would
    // keep this status screen's counts inflated with the previous
    // account's/Page's campaigns/forms even after the Campaigns page and
    // the field-mapping screen themselves stopped showing them.
    const selectedAdAccount = adAccounts.find((a) => a.isSelected) ?? null;
    const campaigns = selectedAdAccount
      ? await listMetaCampaignsWithMappingForAdAccount(auth.companyId, selectedAdAccount.id)
      : [];
    const selectedPage = pages.find((p) => p.isSelected) ?? null;
    const forms = selectedPage ? await listMetaFormsWithMappingCountsForPage(auth.companyId, selectedPage.pageId) : [];
    res.status(200).json({
      connection,
      pages: pages.map((p) => ({
        id: p.id,
        pageId: p.pageId,
        pageName: p.pageName,
        instagramBusinessAccountId: p.instagramBusinessAccountId,
        isSelected: p.isSelected,
        webhookSubscribed: p.webhookSubscribed,
        webhookStatus: p.webhookStatus,
        // Phase 7: lets the "Meta Lead Capture" status card distinguish
        // "never worked" from "worked before, now failing" (see
        // markPageWebhookActive/Failed's own comments), and show the
        // failure reason without a separate request.
        webhookLastVerifiedAt: p.webhookLastVerifiedAt,
        webhookLastError: p.webhookLastError,
      })),
      // Phase 6: independent of Pages (see meta_instagram_accounts' schema
      // comment) - Phase 5's "Select Instagram Account" step lists these.
      instagramAccounts: instagramAccounts.map((i) => ({
        id: i.id,
        instagramAccountId: i.instagramAccountId,
        username: i.username,
        pageId: i.pageId,
        isSelected: i.isSelected,
      })),
      adAccounts: adAccounts.map((a) => ({ id: a.id, adAccountId: a.adAccountId, name: a.name, isSelected: a.isSelected })),
      // Phase 15 - counts and the most recent lead timestamp for the clean
      // status screen's "Campaigns" / "Lead Forms" / "Last Lead" rows.
      // Unpaginated counts (both underlying queries already return every
      // row for the tenant with no LIMIT) - correct for any realistic
      // tenant size, and simpler than adding dedicated COUNT(*) queries.
      campaignsCount: campaigns.length,
      leadFormsCount: forms.length,
      lastLeadAt,
      // WhatsApp Lead Capture feature (Phase 19/20). No access token, no
      // webhook URL, no phone-number-id ever exposed here beyond what
      // discovery itself surfaces (Meta's own display_phone_number) -
      // consistent with this endpoint's existing pages/adAccounts shape,
      // which likewise never returns a token.
      whatsappAccounts: whatsappAccounts.map((w) => ({
        id: w.id,
        wabaName: w.wabaName,
        displayPhoneNumber: w.displayPhoneNumber,
        verifiedName: w.verifiedName,
        isSelected: w.isSelected,
        // Same "make the webhook-subscribe step visible, never silent" the
        // Page pipeline already gives meta_pages.webhookSubscribed - see
        // metaWhatsappWebhookService.ts's own comment on why this step is
        // easy to miss and genuinely necessary for inbound messages to
        // ever arrive at all.
        webhookSubscribed: w.webhookSubscribed,
        webhookStatus: w.webhookStatus,
        webhookLastError: w.webhookLastError,
      })),
      // "Action required" surfacing (Phase 14/19): the Settings screen can
      // render this straight into "12 Instant Form ads, 5 WhatsApp ads, 2
      // unknown - action required" without a second request. Always
      // includes every catalog key (even 0-count ones) rather than only
      // whatever rows exist, so the frontend never has to special-case a
      // missing key.
      leadApproachCounts: Object.fromEntries(
        LEAD_APPROACHES.map((a) => [a.key, leadApproachCounts.find((c) => c.approach === a.key)?.count ?? 0]),
      ),
    });
  } catch (err) {
    console.error(`[meta-oauth] Failed to load status for tenant ${auth.companyId}:`, err);
    res.status(500).json({ error: "Failed to load Meta integration status" });
  }
}

/** Phase 4 "Disconnect" button. Revokes the tenant's active connection
 * (never a hard delete - same "keep history" treatment a reconnect already
 * gives a superseded connection); does not touch synced Pages/ad account
 * rows, which is fine - the not-connected screen doesn't render them, and a
 * future reconnect naturally re-syncs (upserts) them by (tenantId, pageId). */
async function handleOAuthDisconnect(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  try {
    const disconnected = await disconnectActiveMetaConnection(auth.companyId);
    res.status(200).json({ disconnected });
  } catch (err) {
    console.error(`[meta-oauth] Failed to disconnect tenant ${auth.companyId}:`, err);
    res.status(500).json({ error: "Failed to disconnect Meta integration" });
  }
}

// ---------------------------------------------------------------------
// Phase 5: asset selection wizard
// ---------------------------------------------------------------------

const SELECTABLE_TYPES = new Set(["page", "instagram", "ad_account", "whatsapp"]);

/** Body: { type: "page" | "instagram" | "ad_account", id: string } - `id`
 * is always OUR OWN row id (returned by GET /status's pages/instagramAccounts/
 * adAccounts lists), never a raw Meta id typed or supplied by anything else -
 * "Ensure all records belong to the current tenant" is enforced inside each
 * select* call below (it looks the row up scoped to auth.companyId and
 * returns null if it doesn't belong to this tenant, rather than trusting id
 * blindly). Single-select per type - selecting one unselects any other of
 * the same type this tenant had selected before (see the schema's partial
 * unique "one selected per tenant" indexes for the DB-level backstop). */
async function handleSelectAsset(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const body = await readJsonBody(req);
  const type = typeof body.type === "string" ? body.type : "";
  const id = typeof body.id === "string" ? body.id : "";
  if (!SELECTABLE_TYPES.has(type) || !id) {
    res.status(400).json({ error: 'Expected { type: "page" | "instagram" | "ad_account" | "whatsapp", id: string }' });
    return;
  }

  try {
    if (type === "page") {
      // Phase 7: selecting a Page also (synchronously) attempts the
      // automatic webhook subscribe - the response reflects both outcomes
      // so the wizard can show a subscribe failure immediately rather than
      // only finding out on the next status poll.
      const result = await selectPage(auth.companyId, id);
      if (!result.page) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(200).json({
        selected: true,
        id: result.page.id,
        webhookStatus: result.webhook?.status ?? "failed",
        webhookLastError: result.webhook?.lastError ?? null,
      });
      return;
    }

    if (type === "whatsapp") {
      // Same treatment as "page" above - selecting a WhatsApp number also
      // (synchronously) attempts the automatic webhook subscribe, so the
      // response reflects both outcomes immediately. See
      // metaWhatsappWebhookService.ts's selectWhatsappAccount for why this
      // step exists at all: without it, a "connected" number never
      // actually receives any inbound messages.
      const result = await selectWhatsappAccount(auth.companyId, id);
      if (!result.account) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      res.status(200).json({
        selected: true,
        id: result.account.id,
        webhookStatus: result.webhook?.status ?? "failed",
        webhookLastError: result.webhook?.lastError ?? null,
      });
      return;
    }

    let selected;
    if (type === "instagram") selected = await selectInstagramAccount(auth.companyId, id);
    else selected = await selectAdAccount(auth.companyId, id);
    if (!selected) {
      // Either the id doesn't exist, or it belongs to a different tenant -
      // same 404 either way, so this never confirms/denies which.
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.status(200).json({ selected: true, id: selected.id });
  } catch (err) {
    console.error(`[meta-select] Failed to select ${type} for tenant ${auth.companyId}:`, err);
    res.status(500).json({ error: "Failed to save selection" });
  }
}

// ---------------------------------------------------------------------
// Phase 6: automatic Meta asset synchronization
// ---------------------------------------------------------------------

/** Runs the full sync pipeline synchronously and returns its final result -
 * see src/application/metaSync/runMetaSync.ts. Safe to call multiple times
 * (every write inside is an upsert). While this request is in flight, the
 * frontend polls GET /sync-status for live per-step progress; this
 * response is the authoritative final state regardless of whether polling
 * kept up. */
async function handleSync(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  try {
    const result = await runMetaSync(auth.companyId);
    res.status(200).json(result);
  } catch (err) {
    // runMetaSync itself catches everything it can attribute to a specific
    // step - reaching here means something outside that (e.g. Redis/DB
    // unreachable for the very first progress publish) went wrong.
    console.error(`[meta-sync] Sync failed unexpectedly for tenant ${auth.companyId}:`, err);
    res.status(500).json({ error: "Meta sync failed unexpectedly" });
  }
}

/** Polled by the frontend while a POST /sync is in flight - see
 * src/infrastructure/cache/redis.ts's setMetaSyncProgress/getMetaSyncProgress.
 * Returns { progress: null } (200, not 404) if nothing is in progress /
 * nothing has run yet / Redis is unavailable - the frontend treats that as
 * "no live update available" and falls back to just waiting on POST
 * /sync's own response, never as an error. */
async function handleSyncStatus(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const progress = await getMetaSyncProgress(auth.companyId);
  res.status(200).json({ progress });
}

// ---------------------------------------------------------------------
// Phase 7: automatic Page webhook subscription
// ---------------------------------------------------------------------

/** "Retry" button on the Meta Lead Capture status card - re-attempts the
 * exact same subscribe pipeline Phase 5's Page selection already ran
 * automatically (see metaPageService.retryPageWebhook), for whichever
 * Page this tenant currently has selected. Never takes a page id from the
 * request body - there is nothing to trust from the caller here, only
 * "the tenant's own currently-selected Page". 404 if nothing is selected
 * (nothing to retry), never a silent no-op 200. */
async function handleWebhookRetry(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  try {
    const result = await retryPageWebhook(auth.companyId);
    if (!result) {
      res.status(404).json({ error: "No Page is selected to retry" });
      return;
    }
    res.status(200).json({ webhookStatus: result.status, webhookLastError: result.lastError });
  } catch (err) {
    console.error(`[meta-webhook] Retry failed for tenant ${auth.companyId}:`, err);
    res.status(500).json({ error: "Failed to retry the webhook subscription" });
  }
}

/** THE CRM-native Meta leadgen webhook receiver (Phase 7, hardened in
 * Phase 11) - see the header comment's section 3 for the full step-by-step
 * flow. Unauthenticated by design (Meta calls this, not a logged-in
 * browser), so trust comes entirely from the verify token (GET) / HMAC
 * signature (POST), never from anything else in the request - and never,
 * ever from a tenant/company id, which this payload shape doesn't even
 * carry.
 *
 * WhatsApp Lead Capture feature (Phase 6): this is ALSO the receiver for
 * WhatsApp Cloud API webhook events. Meta delivers every product an App
 * subscribes to (Page leadgen AND a WhatsApp Business Account's messages)
 * to that App's ONE registered Callback URL - there is no separate URL to
 * register per product - and the Vercel Hobby plan's 12-Function cap is
 * already fully consumed (see the Phase 0 audit), so this handler branches
 * internally on the payload's top-level `object` field
 * ("page" -> the existing Instant Form flow below; "whatsapp_business_account"
 * -> captureWhatsappEvents/enqueueCapturedWhatsappEvents) rather than a new
 * endpoint being added. The verify token (GET) and HMAC signature (POST)
 * checks are identical either way - both products are subscribed under the
 * SAME Meta App, so both are verified against the same
 * META_WEBHOOK_VERIFY_TOKEN / META_APP_SECRET. */
async function handleMetaLeadgenWebhook(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") {
    // Meta's one-time app-level subscription verification handshake -
    // same shape as the legacy per-campaign handshake below, but checked
    // against this deployment's own fixed META_WEBHOOK_VERIFY_TOKEN
    // rather than a per-campaign one.
    const mode = getQueryString(req, "hub.mode");
    const token = getQueryString(req, "hub.verify_token");
    const challenge = getQueryString(req, "hub.challenge");
    const expected = getEnv("META_WEBHOOK_VERIFY_TOKEN");

    if (mode === "subscribe" && expected && token === expected) {
      res.status(200).send(challenge ?? "");
      return;
    }
    res.status(403).json({ error: "Verification token mismatch" });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Validate request.
  const rawBody = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"];
  const signatureHeader = (Array.isArray(signature) ? signature[0] : signature) ?? null;

  let appSecret: string;
  try {
    appSecret = getAppSecret();
  } catch (err) {
    // Config problem, not something retrying the request fixes - but this
    // is Meta calling us, not a browser, so there's no user-facing screen
    // to redirect; just log and fail loudly ("do not silently fail").
    console.error("[meta-leadgen] META_APP_SECRET is not configured:", err);
    res.status(500).json({ error: "Not configured" });
    return;
  }

  if (!verifyMetaSignature(rawBody, signatureHeader, appSecret)) {
    // Same "never persist an unverified payload" rule as the legacy
    // receiver below - reject BEFORE the durability write, the one case
    // where we do not want to be fast, because we cannot trust the body
    // came from Meta at all.
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  // WhatsApp Lead Capture feature (Phase 6) - branch on the payload's own
  // top-level `object` field BEFORE doing any page-specific parsing. Cheap
  // and safe to parse twice (captureLeadgenEvents/captureWhatsappEvents each
  // re-parse rawBody themselves - this only peeks at one field to route),
  // and keeps each capture function's payload shape/parsing fully separate
  // rather than threading an object-type flag through one shared parser.
  let objectType: string | null = null;
  try {
    objectType = (JSON.parse(rawBody) as { object?: string }).object ?? null;
  } catch {
    // Malformed JSON - captureLeadgenEvents' own JSON.parse below will hit
    // the same error and return zero counts; nothing to route on here.
  }

  if (objectType === "whatsapp_business_account") {
    let waResult;
    try {
      waResult = await captureWhatsappEvents(rawBody);
    } catch (err) {
      console.error("[whatsapp-webhook] Failed to persist incoming event:", err);
      res.status(500).json({ error: "Failed to persist event" });
      return;
    }
    // Return success quickly - same "ack the instant storage is durable"
    // contract as the leadgen path below.
    res.status(200).json({ received: true, captured: waResult.captured });
    // Process asynchronously - hands each newly-captured message to QStash
    // so processWhatsAppMessageEvent.ts (a separate invocation) can create
    // the Lead. Never awaited by anything Meta is waiting on; a publish
    // failure is logged and recovered later by reconcile.ts's own
    // unenqueued-WhatsApp-event sweep.
    await enqueueCapturedWhatsappEvents(waResult.toEnqueue);
    // RUTA AI Assistant - same post-ack timing as the lead pipeline above;
    // these messages never touched whatsapp_message_events (see
    // captureWhatsappEvents' own branch) so there is nothing to enqueue
    // through QStash for them, just the reply to send.
    await handleRutaAssistantMessages(waResult.toHandleAsAssistant);
    return;
  }

  // Identify Page -> Identify Tenant -> Extract leadgen_id -> Check
  // duplicate (tenant_id + leadgen_id, "safely ignore/reprocess") -> Store
  // raw event - all inside captureLeadgenEvents, all Postgres-only (no
  // queue call, no Meta API call yet).
  let result;
  try {
    result = await captureLeadgenEvents(rawBody);
  } catch (err) {
    console.error("[meta-leadgen] Failed to persist incoming event:", err);
    res.status(500).json({ error: "Failed to persist event" });
    return;
  }

  // Return success quickly - Meta has its ack the moment storage is
  // durable. Everything below runs AFTER this, in the same invocation,
  // but can never delay or fail the response above.
  res.status(200).json({ received: true, captured: result.captured, reprocessed: result.reprocessed });

  // Process lead asynchronously - hands each newly-captured event to
  // QStash so processMetaLeadEvent.ts (a separate invocation) can fetch
  // the lead's full details from Meta's Graph API and write it into the
  // CRM. Never awaited by anything Meta is waiting on; a failure here is
  // logged and recovered later by reconcile.ts's unenqueued-event sweep.
  await enqueueCapturedLeadgenEvents(result.toEnqueue);
}

// ---------------------------------------------------------------------
// Phase 10 - Meta Forms + Field Mapping. Every Meta lead form can ask
// different questions (see src/infrastructure/db/schema.ts's
// metaFormFieldMappings doc comment) - this is the admin-facing surface
// for the auto-seeded mapping metaFormService.ts creates on every sync:
//   GET  /api/integrations/meta/forms                     -> list, with
//        each form's question/mapped counts (Settings -> Integrations ->
//        Meta's new "Lead Forms" section).
//   GET  /api/integrations/meta/forms/{metaFormId}         -> one form's
//        full question list, each merged with its current mapping (the
//        Field Mapping screen's own data).
//   PUT  /api/integrations/meta/forms/{metaFormId}/mapping -> Save Mapping.
// ---------------------------------------------------------------------
async function handleMetaForms(req: VercelRequest, res: VercelResponse) {
  const metaFormId = getQueryString(req, "metaFormId");
  const subresource = getQueryString(req, "sub");

  if (!metaFormId) return handleMetaFormsCollection(req, res);
  if (subresource === "mapping") return handleMetaFormMapping(req, res, metaFormId);
  if (!subresource) return handleGetOneMetaForm(req, res, metaFormId);

  res.status(404).json({ error: "Not found" });
}

async function handleMetaFormsCollection(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  // Scoped to the tenant's CURRENTLY SELECTED Page only - review finding,
  // same fix as the Campaigns screen's ad-account scoping: reconnecting
  // Meta with a different Page must not keep showing the previous Page's
  // forms here (see listMetaFormsWithMappingCountsForPage's own comment).
  const selectedPage = await getSelectedMetaPage(auth.companyId);
  const forms = selectedPage ? await listMetaFormsWithMappingCountsForPage(auth.companyId, selectedPage.pageId) : [];
  res.status(200).json({
    forms: forms.map((f) => ({
      id: f.id,
      formId: f.formId,
      formName: f.formName,
      status: f.status,
      lastSyncedAt: f.lastSyncedAt,
      questionCount: f.questionCount,
      mappedCount: f.mappedCount,
    })),
  });
}

// Merges a form's own current question list with its persisted mappings -
// every question the form asks TODAY is represented exactly once, even one
// synced so recently ensureDefaultFieldMappings hasn't run for it yet
// (falls back to an unsaved "custom, key-as-typed" suggestion so the admin
// screen never shows a blank row).
async function handleGetOneMetaForm(req: VercelRequest, res: VercelResponse, metaFormId: string) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const form = await getMetaFormById(auth.companyId, metaFormId);
  if (!form) {
    res.status(404).json({ error: "Meta form not found." });
    return;
  }

  const mappings = await listFieldMappingsForForm(auth.companyId, metaFormId);
  const mappingByKey = new Map(mappings.map((m) => [m.metaFieldKey, m]));
  const questions = (form.questions as { key: string; label: string; type: string }[]) ?? [];

  res.status(200).json({
    metaForm: {
      id: form.id,
      formId: form.formId,
      formName: form.formName,
      status: form.status,
      lastSyncedAt: form.lastSyncedAt,
    },
    // One entry per question this form currently asks, each carrying its
    // mapping row id (null if that mapping hasn't been seeded yet) so the
    // client can PUT back exactly the ids it was given.
    fields: questions.map((q) => {
      const key = q.key.trim().toLowerCase();
      const mapping = mappingByKey.get(key);
      return {
        mappingId: mapping?.id ?? null,
        metaFieldKey: key,
        metaFieldLabel: mapping?.metaFieldLabel ?? q.label ?? q.key,
        metaFieldType: q.type,
        mappingType: mapping?.mappingType ?? "custom",
        systemField: mapping?.systemField ?? null,
        customFieldKey: mapping?.customFieldKey ?? key,
        customFieldLabel: mapping?.customFieldLabel ?? mapping?.metaFieldLabel ?? q.label ?? q.key,
      };
    }),
  });
}

const META_MAPPING_SYSTEM_FIELDS = new Set(["fullName", "phoneNumber", "email"]);

async function handleMetaFormMapping(req: VercelRequest, res: VercelResponse, metaFormId: string) {
  if (req.method !== "PUT") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  let auth = await requirePermission(req, res, PERMISSIONS.INTEGRATIONS_MANAGE);
  if (!auth) return;
  auth = await withEffectiveCompanyContext(req, auth);

  const form = await getMetaFormById(auth.companyId, metaFormId);
  if (!form) {
    res.status(404).json({ error: "Meta form not found." });
    return;
  }

  const { mappings } = (req.body ?? {}) as { mappings?: unknown };
  if (!Array.isArray(mappings)) {
    res.status(400).json({ error: "mappings must be an array." });
    return;
  }

  // customFieldKey is deliberately NOT accepted from the client at all -
  // see saveFieldMappings' own comment for why the underlying
  // leads.customFields key must never be settable by a rename.
  const updates: SaveFieldMappingInput[] = [];
  for (const raw of mappings) {
    const m = raw as {
      mappingId?: unknown;
      mappingType?: unknown;
      systemField?: unknown;
      customFieldLabel?: unknown;
    };
    if (typeof m.mappingId !== "string") {
      res.status(400).json({ error: "Each mapping requires a mappingId." });
      return;
    }
    if (m.mappingType !== "system" && m.mappingType !== "custom") {
      res.status(400).json({ error: "mappingType must be 'system' or 'custom'." });
      return;
    }
    if (m.mappingType === "system") {
      if (typeof m.systemField !== "string" || !META_MAPPING_SYSTEM_FIELDS.has(m.systemField)) {
        res.status(400).json({ error: "systemField must be one of fullName, phoneNumber, email." });
        return;
      }
      updates.push({ id: m.mappingId, mappingType: "system", systemField: m.systemField as "fullName" | "phoneNumber" | "email" });
    } else {
      const customFieldLabel = typeof m.customFieldLabel === "string" ? m.customFieldLabel.trim() : "";
      if (!customFieldLabel) {
        res.status(400).json({ error: "customFieldLabel is required for a custom mapping." });
        return;
      }
      updates.push({ id: m.mappingId, mappingType: "custom", customFieldLabel });
    }
  }

  const updatedIds = await saveFieldMappings(auth.companyId, metaFormId, updates);
  res.status(200).json({ saved: true, updatedCount: updatedIds.length });
}

/**
 * Internal WhatsApp Query Bot - Settings -> Link WhatsApp (self-serve only,
 * per claude/whatsapp-internal-query-bot-flow.md §7 decision 5). Scoped to
 * the caller's own REAL company (auth.companyId), deliberately NOT run
 * through withEffectiveCompanyContext - same reasoning handleOAuthConnect
 * documents above: a linked number is this person's own identity, not
 * whichever client an agency user happens to be "inside" right now. GET
 * returns current link status; POST generates a fresh one-time code.
 */
/** Read-only - RUTA AI Assistant is mandatory and admin-provisioned (see
 * api/admin/users/handler.ts's phoneNumber handling), so there is no
 * self-service link/unlink action here anymore, just status for the
 * logged-in user to see which number it's active on. */
async function handleRutaAssistantStatus(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const link = await getUserWhatsappLinkByUserId(auth.companyId, auth.userId);
  res.status(200).json({
    active: !!link,
    phoneNumber: link ? `••••${link.phoneNumber.slice(-4)}` : null,
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const resource = getQueryString(req, "resource");
  if (resource === "oauth-connect") return handleOAuthConnect(req, res);
  if (resource === "oauth-callback") return handleOAuthCallback(req, res);
  if (resource === "oauth-status") return handleOAuthStatus(req, res);
  if (resource === "oauth-disconnect") return handleOAuthDisconnect(req, res);
  if (resource === "select") return handleSelectAsset(req, res);
  if (resource === "sync") return handleSync(req, res);
  if (resource === "sync-status") return handleSyncStatus(req, res);
  if (resource === "webhook-retry") return handleWebhookRetry(req, res);
  if (resource === "ruta-ai-status") return handleRutaAssistantStatus(req, res);
  // "leadgen" is the Phase 11 canonical name; "page-events" is Phase 7's
  // original name, kept as a permanent alias to the same handler so any
  // subscription Meta already has registered against it keeps working.
  if (resource === "leadgen" || resource === "page-events") return handleMetaLeadgenWebhook(req, res);
  if (resource === "meta-forms") return handleMetaForms(req, res);
  if (resource === "razorpay-webhook") return handleRazorpayWebhook(req, res);

  const slug = req.query.slug as string;
  const webhookConfig = await getWebhookConfigBySlug(slug);

  if (!webhookConfig) {
    // Deliberately generic - do not reveal whether a slug is "close" to a
    // real one.
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (req.method === "GET") {
    // Meta's webhook verification handshake, checked against THIS
    // campaign's own verify token.
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === webhookConfig.verifyToken) {
      await markWebhookVerified(webhookConfig.id);
      res.status(200).send(String(challenge ?? ""));
      return;
    }
    res.status(403).json({ error: "Verification token mismatch" });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"];
  const signatureHeader = (Array.isArray(signature) ? signature[0] : signature) ?? null;

  if (!verifyMetaSignature(rawBody, signatureHeader, webhookConfig.appSecret)) {
    // Do NOT persist unverified payloads - this is the one case where we
    // reject before the durability write, because we cannot trust the body
    // came from Meta at all.
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  try {
    const result = await ingestWebhookPayload(rawBody, signatureHeader, {
      companyId: webhookConfig.companyId,
      campaignId: webhookConfig.campaignId,
    });
    // Always 200 once the durability write succeeded, even if the enqueue
    // step failed - Meta should not retry-storm us for a problem that is
    // already safely recorded and will self-heal via reconciliation.
    res.status(200).json({ received: result.persisted, enqueued: result.enqueued });
  } catch (err) {
    // Only a genuine failure to persist reaches here - tell Meta to retry.
    console.error("[webhook] Failed to persist incoming event:", err);
    res.status(500).json({ error: "Failed to persist event" });
  }
}

// ---------------------------------------------------------------------------
// Razorpay payment webhook - see this file's own header comment (item 4)
// for why this unrelated concern lives here. Public, unauthenticated (a
// real webhook can't carry our session cookie), trust comes entirely from
// the X-Razorpay-Signature HMAC check below - never from anything else in
// the request.
// ---------------------------------------------------------------------------
async function handleRazorpayWebhook(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-razorpay-signature"];
  const signatureHeader = (Array.isArray(signature) ? signature[0] : signature) ?? null;

  if (!verifyRazorpayWebhookSignature(rawBody, signatureHeader)) {
    // Same posture as the Meta receiver above - do not even parse an
    // unverified body, let alone act on it.
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  // Razorpay fires several event types (order.paid, payment.authorized,
  // payment.captured, ...) - only payment.captured is Razorpay's own
  // documented "funds actually captured" signal; every other event is
  // acknowledged (200, so Razorpay stops retrying it) but otherwise
  // ignored.
  if (payload.event !== "payment.captured") {
    res.status(200).json({ received: true, ignored: true });
    return;
  }

  try {
    const paymentEntity = (payload.payload as any)?.payment?.entity as { id?: string; order_id?: string } | undefined;
    const razorpayOrderId = paymentEntity?.order_id;
    const razorpayPaymentId = paymentEntity?.id;
    if (!razorpayOrderId || !razorpayPaymentId) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }
    await confirmOveragePaymentFromWebhook({ razorpayOrderId, razorpayPaymentId });
    res.status(200).json({ received: true });
  } catch (err) {
    console.error("[razorpay-webhook] Failed to process payment.captured:", err);
    res.status(500).json({ error: "Failed to process webhook" });
  }
}
