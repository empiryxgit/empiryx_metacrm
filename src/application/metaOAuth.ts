// Orchestrates the tenant-level Meta OAuth connection flow end to end (see
// api/webhooks/meta/handler.ts for the two thin HTTP handlers that call
// into this). Application-layer glue only - raw Graph API calls live in
// src/infrastructure/meta/graphClient.ts, persistence in
// src/infrastructure/db/repositories/metaIntegration.ts, same layering the
// rest of this codebase already uses (see src/application/processLead.ts).

import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getAuthorizedMetaUser,
  getBaseUrl,
  getGrantedPermissions,
  getOAuthDialogBaseUrl,
  getUserAdAccounts,
} from "../infrastructure/meta/graphClient";
import { markMetaConnectionError, replaceMetaAdAccounts, upsertMetaConnection } from "../infrastructure/db/repositories/metaIntegration";
import { syncPagesAndInstagram, validateAndResubscribeSelectedPage } from "./metaSync/metaPageService";
import { syncCampaignsForSelectedAdAccount } from "./metaSync/metaCampaignService";
import { syncFormsForSelectedPage } from "./metaSync/metaFormService";

// Minimum scope set for what this integration actually does: list/read the
// tenant's Pages and their lead-retrieval data, list ad accounts, and read
// Instagram accounts linked to a Page. `email`/`public_profile` are the
// default Facebook Login scopes needed to identify the authorizing user
// (step 7). Not sourced from an env var - this is a fixed part of what the
// app requests, not per-deployment configuration.
const OAUTH_SCOPES = [
  "public_profile",
  "email",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "leads_retrieval",
  "ads_read",
  "business_management",
  "instagram_basic",
].join(",");

// Phase 16 - "Validate permissions" step of the reconnect pipeline: the
// subset of OAUTH_SCOPES above without which this integration genuinely
// cannot do its job (retrieve leads, read Pages/ad accounts). A tenant CAN
// decline an individual permission in Meta's dialog even after starting the
// flow - this catches that here, at connect/reconnect time, with a clear
// "here's exactly what's missing" error, rather than discovering it much
// later as a confusing Graph API failure on some unrelated sync step.
// Deliberately excludes: "public_profile"/"email" (Facebook Login's own
// baseline - Meta itself won't complete the exchange without these, so
// there's nothing to validate) and "instagram_basic" (Instagram linking is
// already optional throughout this integration - see the selection
// wizard's "You can continue without selecting one").
const REQUIRED_OAUTH_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_metadata", "leads_retrieval", "ads_read", "business_management"];

export class MetaOAuthConfigError extends Error {}

/** Thrown by validateGrantedPermissions below - carries exactly which
 * scopes are missing so the Settings screen (and its error banner) can say
 * so specifically, rather than a generic "connection failed". */
export class MetaPermissionError extends Error {
  constructor(public readonly missingScopes: string[]) {
    super(`Missing required Meta permissions: ${missingScopes.join(", ")}`);
  }
}

/**
 * "Validate permissions" - queries what Meta says this token was ACTUALLY
 * granted (via GET /me/permissions - see graphClient.getGrantedPermissions)
 * and checks it against REQUIRED_OAUTH_SCOPES. Throws MetaPermissionError
 * if anything required is missing or was explicitly declined - the caller
 * (completeMetaConnection below) runs this BEFORE writing/updating the
 * connection row, so a permission gap never leaves behind a connection
 * that looks superficially fine but can't actually retrieve leads.
 */
export async function validateGrantedPermissions(accessToken: string): Promise<void> {
  const granted = await getGrantedPermissions(accessToken);
  const grantedScopes = new Set(granted.filter((g) => g.status === "granted").map((g) => g.permission));
  const missing = REQUIRED_OAUTH_SCOPES.filter((scope) => !grantedScopes.has(scope));
  if (missing.length > 0) throw new MetaPermissionError(missing);
}

// Exported (Phase 7) so metaWebhookService.ts can build the same App-id
// `access_token=appId|appSecret` pair the App-level subscribe call needs,
// without duplicating these env lookups or their error messages.
export function getAppId(): string {
  const value = process.env.META_APP_ID;
  if (!value) throw new MetaOAuthConfigError("META_APP_ID is not set. See .env.example.");
  return value;
}

export function getAppSecret(): string {
  // Server-side only - never read, logged, or returned from any HTTP
  // handler; only ever passed straight into a Graph API call below.
  const value = process.env.META_APP_SECRET;
  if (!value) throw new MetaOAuthConfigError("META_APP_SECRET is not set. See .env.example.");
  return value;
}

/** The one fixed callback URL registered with the Meta App - built from
 * PUBLIC_BASE_URL (already a required env var for QStash - see
 * src/infrastructure/queue/qstash.ts) rather than a new one, since Meta
 * requires the exact same redirect_uri at both the authorize step and the
 * token-exchange step, and that URL cannot vary per-environment without
 * also updating the Meta App's own allow-list. */
export function getRedirectUri(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new MetaOAuthConfigError("PUBLIC_BASE_URL is not set. See .env.example.");
  return `${base.replace(/\/$/, "")}/api/integrations/meta/callback`;
}

/** Step 3: where to send the tenant's browser. `state` is the already-signed
 * token from src/infrastructure/auth/oauthState.ts - this function does not
 * generate it, just carries it through. */
export function buildAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: getAppId(),
    redirect_uri: getRedirectUri(),
    state,
    scope: OAUTH_SCOPES,
    response_type: "code",
  });
  return `${getOAuthDialogBaseUrl()}/dialog/oauth?${params.toString()}`;
}

export interface CompleteConnectionResult {
  connectionId: string;
  metaUserId: string;
  pagesConnected: number;
  adAccountsConnected: number;
  // Phase 16 - reconnect pipeline outcomes. Not surfaced in the OAuth
  // redirect today (the callback still just redirects with ?connected=1 -
  // the Settings status screen reflects the fresh state a moment later via
  // GET /status) but returned for logging/future use without needing to
  // touch this signature again.
  pageValidation: "not_applicable" | "still_accessible" | "access_removed";
  webhookResubscribed: "not_applicable" | "active" | "failed";
  assetsSynced: { adAccounts: number; campaigns: number; adSets: number; ads: number; forms: number };
}

/**
 * The full reconnect pipeline - used identically for a tenant's FIRST
 * connect and every later reconnect (Phase 16: same "one function either
 * way" precedent as the webhook Retry button already established):
 *
 *   OAuth -> Validate permissions -> Update connection -> Validate Page ->
 *   Re-subscribe webhook -> Sync assets
 *
 * `tenantId`/`connectingUserId` MUST already have come from a verified
 * OAuth state (see verifyOAuthState) - this function trusts them as given
 * and does no further authorization check itself, by design: this is the
 * one place in the codebase allowed to treat a tenantId as authoritative,
 * precisely because it was never accepted from the request directly.
 */
export async function completeMetaConnection(
  code: string,
  tenantId: string,
  connectingUserId: string,
): Promise<CompleteConnectionResult> {
  void connectingUserId; // not persisted today - available for an audit-log field later without changing this signature

  const appId = getAppId();
  const appSecret = getAppSecret();

  // ---- OAuth ----------------------------------------------------------
  // Step 6: exchange the authorization code for a (short-lived) user token.
  const shortLived = await exchangeCodeForToken(code, getRedirectUri(), appId, appSecret);

  // Immediately trade it for a long-lived (~60 day) token - see
  // exchangeForLongLivedToken's own comment for why. Best-effort: if this
  // particular call fails, the short-lived token still works for the rest
  // of this same request, it just expires sooner - not worth failing the
  // whole connection over.
  let accessToken = shortLived.accessToken;
  let expiresInSeconds = shortLived.expiresInSeconds;
  try {
    const longLived = await exchangeForLongLivedToken(shortLived.accessToken, appId, appSecret);
    accessToken = longLived.accessToken;
    expiresInSeconds = longLived.expiresInSeconds;
  } catch (err) {
    console.warn("[meta-oauth] Failed to exchange for a long-lived token, continuing with the short-lived one:", err);
  }

  // ---- Validate permissions ---------------------------------------------
  // Runs BEFORE anything is written. A missing required scope means this
  // connection cannot do its actual job (retrieve leads) at all - failing
  // fast here, with nothing written yet, is simpler and more honest than
  // writing a connection row and immediately having to mark it broken.
  await validateGrantedPermissions(accessToken);

  // Step 7.
  const metaUser = await getAuthorizedMetaUser(accessToken);

  // ---- Update connection -------------------------------------------------
  // Step 11 - everything below references this row's id. upsertMetaConnection
  // demotes any prior ACTIVE row to "revoked" and inserts a fresh "active"
  // one. On a RECONNECT (the prior row was "needs_reauth" or "error", not
  // "active"), THIS is what actually clears the broken state: the old row
  // is simply superseded, and the status screen's query
  // (getRelevantMetaConnectionView) always prefers an "active" row when one
  // exists - so a successful reconnect reads as "Connected" again the
  // instant this write completes, with no separate "un-flag" step needed.
  const tokenExpiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null;
  const connection = await upsertMetaConnection({
    tenantId,
    metaUserId: metaUser.id,
    metaUserName: metaUser.name ?? null,
    accessToken,
    tokenExpiresAt,
  });

  // From here on the connection row is durably written - a failure in
  // Pages/ad-accounts sync below is recorded ON that row (status="error",
  // lastError set) rather than left silently unexplained, so the Settings
  // screen can show what went wrong instead of just "not connected". The
  // connection is still real (the tenant did authorize it); what's
  // incomplete is which assets got synced.
  try {
    // ---- Validate Page + Re-subscribe webhook --------------------------
    // Steps 8 + 10 (Pages + linked Instagram) - needed as the fresh list
    // "Validate Page" checks a previously-selected Page against, and
    // everything else below builds on it too.
    const pagesResult = await syncPagesAndInstagram(tenantId, connection.id, accessToken);
    const pageValidation = await validateAndResubscribeSelectedPage(tenantId, pagesResult.pages);

    // ---- Sync assets ----------------------------------------------------
    // Step 9 (ad accounts), then Campaigns/ad sets/ads (scoped to whichever
    // ad account is selected) and Forms (scoped to whichever Page is
    // selected). Campaigns/Forms are independent and best-effort here - the
    // same "one phase's failure doesn't stop the others" philosophy
    // runMetaSync.ts already uses for an ordinary re-sync; a fresh
    // reconnect deserves the same resilience rather than an all-or-nothing
    // outcome over one slow/flaky step. Forms is skipped outright if
    // Validate Page just found the selected Page's access was removed -
    // that same page-scoped call would only fail again for the identical
    // reason.
    const adAccounts = await getUserAdAccounts(accessToken);
    await replaceMetaAdAccounts(
      tenantId,
      connection.id,
      adAccounts.map((a) => ({ adAccountId: a.id, name: a.name })),
    );

    let campaignsResult: Awaited<ReturnType<typeof syncCampaignsForSelectedAdAccount>> | null = null;
    try {
      campaignsResult = await syncCampaignsForSelectedAdAccount(tenantId, accessToken);
    } catch (err) {
      console.error(`[meta-oauth] Reconnect: campaigns sync failed for tenant ${tenantId}:`, err);
    }

    let formsResult: Awaited<ReturnType<typeof syncFormsForSelectedPage>> | null = null;
    if (pageValidation.pageStillAccessible !== false) {
      try {
        formsResult = await syncFormsForSelectedPage(tenantId);
      } catch (err) {
        console.error(`[meta-oauth] Reconnect: forms sync failed for tenant ${tenantId}:`, err);
      }
    }

    return {
      connectionId: connection.id,
      metaUserId: metaUser.id,
      pagesConnected: pagesResult.pagesCount,
      adAccountsConnected: adAccounts.length,
      pageValidation: !pageValidation.hadSelectedPage ? "not_applicable" : pageValidation.pageStillAccessible ? "still_accessible" : "access_removed",
      webhookResubscribed: !pageValidation.webhook ? "not_applicable" : pageValidation.webhook.ok ? "active" : "failed",
      assetsSynced: {
        adAccounts: adAccounts.length,
        campaigns: campaignsResult && !campaignsResult.skipped ? campaignsResult.campaignsCount : 0,
        adSets: campaignsResult && !campaignsResult.skipped ? campaignsResult.adSetsCount : 0,
        ads: campaignsResult && !campaignsResult.skipped ? campaignsResult.adsCount : 0,
        forms: formsResult && !formsResult.skipped ? formsResult.formsCount : 0,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markMetaConnectionError(connection.id, message);
    throw err;
  }
}
