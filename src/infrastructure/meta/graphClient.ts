// Thin wrapper over the Meta Graph API. Every call takes the access token
// explicitly rather than reading a single global env var, because each
// campaign has its own Meta app/page and therefore its own access token
// (see webhook_configs). Every call also goes through `fetchWithRetry`, so
// a transient 5xx/network error is retried a couple of times locally before
// bubbling up - anything that still fails is thrown as MetaApiError, which
// the caller (process-lead handler) turns into a non-2xx HTTP response so
// QStash's own retry/backoff takes over for the larger retry budget.

import type { MetaLeadDetails } from "../../domain/types";

const GRAPH_VERSION = "v19.0";
const LEAD_FIELDS = [
  "id",
  "form_id",
  "created_time",
  "field_data",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
].join(",");

// Phase 16 - "Implement proper handling for: Expired token / Revoked
// authorization / Missing permission / Page access removed / Meta API
// authentication failure." All five collapse into ONE user-facing outcome
// (the Settings screen's "Needs Reauthorization" card - see
// src/application/metaSync/metaConnectionService.ts's
// flagConnectionIfAuthError) but are worth distinguishing here, on the
// error itself, for logging/diagnostics and so a future caller can special-
// case one of them without re-parsing Meta's error JSON.
export type MetaAuthErrorKind = "expired_token" | "revoked" | "missing_permission" | "page_access_removed" | "auth_failed";

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    // Set only when this failure was classified as an AUTH problem
    // (classifyMetaAuthError below) - null/undefined for anything else
    // (rate limiting, a malformed request, a genuine 5xx), which callers
    // must keep treating as a plain retryable/non-retryable failure, never
    // as something reconnecting would fix.
    public readonly authErrorKind: MetaAuthErrorKind | null = null,
    public readonly graphErrorCode?: number,
    public readonly graphErrorSubcode?: number,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

interface ParsedGraphError {
  message: string;
  type?: string;
  code?: number;
  subcode?: number;
}

async function parseGraphErrorBody(response: Response): Promise<ParsedGraphError | null> {
  try {
    const body = (await response.json()) as { error?: { message?: string; type?: string; code?: number; error_subcode?: number } };
    if (!body.error) return null;
    return {
      message: body.error.message || `Graph API returned ${response.status}`,
      type: body.error.type,
      code: body.error.code,
      subcode: body.error.error_subcode,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort classification against Meta's documented (but not always
 * perfectly consistent) Graph API error taxonomy. Every bucket below is
 * deliberately the SAFEST reasonable interpretation of an ambiguous or
 * unknown subcode, never a guess that risks masking a real auth problem as
 * something benign - a false positive here (flagging a connection that was
 * actually fine) just means an unnecessary "Reconnect Meta" prompt; a false
 * negative (missing a real auth failure) means leads silently stop flowing
 * with no visible explanation, which is the worse failure mode.
 *   - code 190 (OAuthException, invalid/expired token) - subcode 458
 *     ("user has not authorized this app" - i.e. they revoked it), 460
 *     ("password changed") and 461 ("session invalidated") all mean the
 *     grant itself is gone -> "revoked". Subcode 463 is Meta's explicit
 *     "token expired" -> "expired_token". Any OTHER/unrecognized subcode
 *     under 190 still means "this token no longer works" -> defaults to
 *     "expired_token", the most common real-world cause and the one a
 *     fresh token from reconnecting directly fixes either way.
 *   - code 10, or an OAuthException whose message mentions "permission" ->
 *     "missing_permission" (a scope the app needs was never granted or was
 *     since revoked - e.g. `leads_retrieval` or `ads_read`).
 *   - code 100 with subcode 33 - Meta's "this object doesn't exist, or you
 *     don't have permission to access it" - for a Page-scoped call
 *     (getPageLeadForms, subscribePageToLeadgen, getLeadDetails) this means
 *     the Page itself was unlinked/removed from this app's access ->
 *     "page_access_removed".
 *   - HTTP 401 with no code Meta actually recognized above -> "auth_failed"
 *     (still clearly an auth problem, just not one of the four specific
 *     kinds above). HTTP 403 -> "missing_permission" (Graph's other common
 *     way of signaling a permission gate).
 *   - everything else (5xx, rate limiting, malformed request, unrelated 4xx)
 *     -> null, NOT an auth problem - callers must not treat this as
 *     something reconnecting would fix.
 */
export function classifyMetaAuthError(input: { status?: number; code?: number; subcode?: number; type?: string; message?: string }): MetaAuthErrorKind | null {
  const { status, code, subcode, type, message } = input;
  const msg = (message ?? "").toLowerCase();

  if (code === 190) {
    if (subcode === 458 || subcode === 460 || subcode === 461) return "revoked";
    if (subcode === 463) return "expired_token";
    return "expired_token"; // safest default for any other/unknown subcode
  }
  if (code === 100 && subcode === 33) return "page_access_removed";
  if (code === 10 || (type === "OAuthException" && msg.includes("permission"))) return "missing_permission";
  if (status === 403) return "missing_permission";
  if (status === 401) return "auth_failed";
  return null;
}

/** Parses a failed Graph API response into a fully-classified MetaApiError -
 * the single place every call site below builds its thrown error, so
 * classification is applied uniformly rather than re-implemented per
 * function. `fallbackMessage` is used only if Meta's error body couldn't be
 * parsed at all (an empty body, HTML from a proxy/outage, etc). */
async function buildMetaApiError(response: Response, fallbackMessage: string): Promise<MetaApiError> {
  const parsed = await parseGraphErrorBody(response);
  const message = parsed?.message ?? `${fallbackMessage} (${response.status})`;
  const authErrorKind = classifyMetaAuthError({ status: response.status, code: parsed?.code, subcode: parsed?.subcode, type: parsed?.type, message: parsed?.message });
  return new MetaApiError(message, response.status, authErrorKind, parsed?.code, parsed?.subcode);
}

// Exported so the OAuth flow (src/application/metaOAuth.ts) builds its
// Authorization/token-exchange URLs against the exact same Graph API
// version/base host as every other Graph call in this project, rather than
// hard-coding or duplicating it.
export function getBaseUrl(): string {
  return process.env.META_GRAPH_BASE_URL ?? `https://graph.facebook.com/${GRAPH_VERSION}`;
}

// The OAuth dialog itself is served from facebook.com, not the Graph API
// host (graph.facebook.com) - a separate, fixed base, but versioned the
// same way (same GRAPH_VERSION) so the dialog and the token exchange that
// follows it are always talking about the same API version.
export function getOAuthDialogBaseUrl(): string {
  return `https://www.facebook.com/${GRAPH_VERSION}`;
}

// Phase 13 - "safe handling for API timeout": every single Graph API call
// gets an explicit, bounded deadline via AbortController rather than
// relying on the platform's own function-level maxDuration to eventually
// kill a hung request. Without this, a Graph API call that never responds
// (network partition, Meta-side hang) would hold the whole invocation open
// until Vercel force-kills it - an ungraceful, unclassified failure that
// looks identical to a crash to everything downstream (QStash still
// retries, but nothing here ever gets the chance to record WHY). With it,
// a hang fails fast, gets a clear "timed out" MetaApiError, and still goes
// through the exact same retry-then-throw path every other failure does.
const GRAPH_API_TIMEOUT_MS = Number(process.env.META_GRAPH_API_TIMEOUT_MS ?? 15000);

async function fetchWithRetry(url: string, attempts = 3, method: "GET" | "POST" = "GET"): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GRAPH_API_TIMEOUT_MS);
    try {
      // Every Graph API call in this file (GET or POST) passes its
      // parameters as query string, never a request body - POST here is
      // only "use POST semantics," matching Meta's own documented contract
      // for the subscribe endpoints below.
      const response = await fetch(url, { method, signal: controller.signal });
      if (response.ok) return response;
      if (response.status < 500) return response; // don't retry client errors
      lastError = new MetaApiError(`Graph API returned ${response.status}`, response.status);
    } catch (err) {
      lastError =
        err instanceof Error && err.name === "AbortError"
          ? new MetaApiError(`Graph API request timed out after ${GRAPH_API_TIMEOUT_MS}ms`)
          : err;
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((r) => setTimeout(r, 250 * 2 ** i)); // 250ms, 500ms, 1000ms
  }
  throw lastError instanceof Error ? lastError : new MetaApiError("Graph API request failed");
}

// (Phase 7's extractGraphErrorMessage lived here - superseded by Phase 16's
// buildMetaApiError below, which parses the same error body and adds auth
// classification on top; every call site that used it now uses that instead.)

interface GraphFieldData {
  name: string;
  values: string[];
}

interface GraphLeadResponse {
  id: string;
  form_id: string;
  created_time: string;
  field_data?: GraphFieldData[];
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
}

function mapLead(raw: GraphLeadResponse): MetaLeadDetails {
  return {
    id: raw.id,
    formId: raw.form_id,
    createdTime: raw.created_time,
    adId: raw.ad_id,
    adName: raw.ad_name,
    adSetId: raw.adset_id,
    adSetName: raw.adset_name,
    campaignId: raw.campaign_id,
    campaignName: raw.campaign_name,
    fieldData: (raw.field_data ?? []).map((f) => ({ name: f.name, values: f.values })),
  };
}

export async function getLeadDetails(leadgenId: string, accessToken: string): Promise<MetaLeadDetails> {
  const url = `${getBaseUrl()}/${leadgenId}?fields=${LEAD_FIELDS}&access_token=${accessToken}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw await buildMetaApiError(response, `Failed to fetch lead ${leadgenId}`);
  }
  const raw = (await response.json()) as GraphLeadResponse;
  return mapLead(raw);
}

// ---------------------------------------------------------------------
// OAuth - tenant-level Meta connection (see src/application/metaOAuth.ts
// for the orchestration that calls these; this file stays limited to raw
// Graph API HTTP calls, same division of responsibility as the rest of it).
// ---------------------------------------------------------------------

export interface MetaTokenExchange {
  accessToken: string;
  expiresInSeconds?: number;
}

interface GraphTokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
}

/** Step 6 of the OAuth flow: swap the short-lived `code` Meta just redirected
 * back with for a user access token. Must use the exact same redirectUri
 * that was sent to the authorization dialog in step 3 - Meta rejects the
 * exchange otherwise. */
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  appId: string,
  appSecret: string,
): Promise<MetaTokenExchange> {
  const url =
    `${getBaseUrl()}/oauth/access_token?client_id=${encodeURIComponent(appId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw await buildMetaApiError(response, "Failed to exchange authorization code");
  }
  const json = (await response.json()) as GraphTokenResponse;
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in };
}

/** Short-lived user tokens from the initial exchange are valid for only a
 * couple of hours - this trades one in for a long-lived (~60 day) token,
 * standard practice for a Meta integration meant to keep working without
 * asking the tenant to reconnect every session. */
export async function exchangeForLongLivedToken(
  shortLivedToken: string,
  appId: string,
  appSecret: string,
): Promise<MetaTokenExchange> {
  const url =
    `${getBaseUrl()}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw await buildMetaApiError(response, "Failed to exchange for a long-lived token");
  }
  const json = (await response.json()) as GraphTokenResponse;
  return { accessToken: json.access_token, expiresInSeconds: json.expires_in };
}

export interface AuthorizedMetaUser {
  id: string;
  name: string;
  email?: string;
}

/** Step 7: who actually authorized this connection. */
export async function getAuthorizedMetaUser(accessToken: string): Promise<AuthorizedMetaUser> {
  const url = `${getBaseUrl()}/me?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw await buildMetaApiError(response, "Failed to fetch the authorized Meta user");
  }
  return (await response.json()) as AuthorizedMetaUser;
}

export interface GrantedPermission {
  permission: string;
  status: "granted" | "declined";
}

interface GraphPermissionNode {
  permission: string;
  status: string;
}

/** Phase 16 - "Validate permissions" step of the reconnect pipeline: what
 * Meta says this token was ACTUALLY granted, as opposed to what the OAuth
 * dialog was asked for (a user can decline individual permissions in
 * Meta's dialog even after starting the flow). See
 * src/application/metaOAuth.ts's validateGrantedPermissions for the
 * required-scope check built on top of this. */
export async function getGrantedPermissions(accessToken: string): Promise<GrantedPermission[]> {
  const url = `${getBaseUrl()}/me/permissions?access_token=${encodeURIComponent(accessToken)}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw await buildMetaApiError(response, "Failed to read granted Meta permissions");
  }
  const page = (await response.json()) as { data: GraphPermissionNode[] };
  return page.data.map((d) => ({ permission: d.permission, status: d.status === "granted" ? "granted" : "declined" }));
}

export interface MetaPageSummary {
  id: string;
  name: string;
  accessToken: string; // page-scoped token, distinct from the user token
  instagramBusinessAccountId?: string;
  instagramUsername?: string; // Phase 6: the linked IG account's "@handle" (without the "@")
}

interface GraphPageNode {
  id: string;
  name: string;
  access_token: string;
  instagram_business_account?: { id: string; username?: string };
}

interface GraphPagedResponse<T> {
  data: T[];
  paging?: { cursors?: { after?: string }; next?: string };
}

/** Steps 8 + 10 in one call: every Page the authorizing user manages, each
 * with its own page-scoped access token (needed for lead retrieval - the
 * user token alone cannot read a Page's leads) and, where the Page has one
 * linked, its Instagram professional account id via field expansion. */
export async function getUserPages(userAccessToken: string): Promise<MetaPageSummary[]> {
  const results: MetaPageSummary[] = [];
  let url =
    `${getBaseUrl()}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}` +
    `&limit=100&access_token=${encodeURIComponent(userAccessToken)}`;

  while (url) {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw await buildMetaApiError(response, "Failed to list Pages");
    }
    const page = (await response.json()) as GraphPagedResponse<GraphPageNode>;
    for (const node of page.data) {
      results.push({
        id: node.id,
        name: node.name,
        accessToken: node.access_token,
        instagramBusinessAccountId: node.instagram_business_account?.id,
        instagramUsername: node.instagram_business_account?.username,
      });
    }
    url = page.paging?.next ?? "";
  }
  return results;
}

export interface MetaAdAccountSummary {
  id: string; // Graph API's own id, e.g. "act_1234567890"
  name: string;
}

interface GraphAdAccountNode {
  id: string;
  name: string;
}

/** Step 9: every ad account the authorizing user has at least read access
 * to. */
export async function getUserAdAccounts(userAccessToken: string): Promise<MetaAdAccountSummary[]> {
  const results: MetaAdAccountSummary[] = [];
  let url = `${getBaseUrl()}/me/adaccounts?fields=id,name&limit=100&access_token=${encodeURIComponent(userAccessToken)}`;

  while (url) {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw await buildMetaApiError(response, "Failed to list ad accounts");
    }
    const page = (await response.json()) as GraphPagedResponse<GraphAdAccountNode>;
    for (const node of page.data) {
      results.push({ id: node.id, name: node.name });
    }
    url = page.paging?.next ?? "";
  }
  return results;
}

/** Used by reconciliation to page through a form's recent leads independent of the webhook. */
export async function* getRecentLeadsForForm(
  formId: string,
  sinceUnixSeconds: number,
  accessToken: string,
): AsyncGenerator<MetaLeadDetails> {
  let after: string | undefined;

  do {
    const filtering = encodeURIComponent(
      JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceUnixSeconds }]),
    );
    const url =
      `${getBaseUrl()}/${formId}/leads?fields=${LEAD_FIELDS}&filtering=${filtering}` +
      `&limit=100&access_token=${accessToken}` +
      (after ? `&after=${after}` : "");

    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw await buildMetaApiError(response, `Failed to list leads for form ${formId}`);
    }
    const page = (await response.json()) as {
      data: GraphLeadResponse[];
      paging?: { cursors?: { after?: string } };
    };

    for (const raw of page.data) {
      yield mapLead(raw);
    }

    after = page.paging?.cursors?.after;
  } while (after);
}

// ---------------------------------------------------------------------
// Phase 6: automatic Meta asset synchronization - Campaigns/Ad Sets/Ads
// under the tenant's SELECTED ad account, and Lead Forms under the
// tenant's SELECTED Page. Same fetchWithRetry + cursor-pagination pattern
// as getUserPages/getUserAdAccounts above; deliberately minimal `fields`
// (only what src/infrastructure/db/schema.ts actually has columns for).
// ---------------------------------------------------------------------

export interface MetaCampaignSummary {
  id: string;
  name: string;
  status: string; // Meta's own status string, e.g. "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED"
}

interface GraphCampaignNode {
  id: string;
  name: string;
  status: string;
}

/** Every ad campaign under one ad account (e.g. "act_1234567890" - the id
 * as stored in meta_ad_accounts.adAccountId, prefix included). Uses the
 * connection's user token, same as getUserAdAccounts (ads_read scope). */
export async function getAdAccountCampaigns(adAccountId: string, userAccessToken: string): Promise<MetaCampaignSummary[]> {
  const results: MetaCampaignSummary[] = [];
  let url = `${getBaseUrl()}/${adAccountId}/campaigns?fields=id,name,status&limit=100&access_token=${encodeURIComponent(userAccessToken)}`;

  while (url) {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw await buildMetaApiError(response, `Failed to list campaigns for ${adAccountId}`);
    }
    const page = (await response.json()) as GraphPagedResponse<GraphCampaignNode>;
    for (const node of page.data) {
      results.push({ id: node.id, name: node.name, status: node.status });
    }
    url = page.paging?.next ?? "";
  }
  return results;
}

export interface MetaAdSetSummary {
  id: string;
  name: string;
  status: string;
}

interface GraphAdSetNode {
  id: string;
  name: string;
  status: string;
}

/** Every ad set under one campaign. */
export async function getCampaignAdSets(campaignId: string, userAccessToken: string): Promise<MetaAdSetSummary[]> {
  const results: MetaAdSetSummary[] = [];
  let url = `${getBaseUrl()}/${campaignId}/adsets?fields=id,name,status&limit=100&access_token=${encodeURIComponent(userAccessToken)}`;

  while (url) {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw await buildMetaApiError(response, `Failed to list ad sets for campaign ${campaignId}`);
    }
    const page = (await response.json()) as GraphPagedResponse<GraphAdSetNode>;
    for (const node of page.data) {
      results.push({ id: node.id, name: node.name, status: node.status });
    }
    url = page.paging?.next ?? "";
  }
  return results;
}

export interface MetaAdSummary {
  id: string;
  name: string;
  status: string;
}

interface GraphAdNode {
  id: string;
  name: string;
  status: string;
}

/** Every ad under one ad set. */
export async function getAdSetAds(adSetId: string, userAccessToken: string): Promise<MetaAdSummary[]> {
  const results: MetaAdSummary[] = [];
  let url = `${getBaseUrl()}/${adSetId}/ads?fields=id,name,status&limit=100&access_token=${encodeURIComponent(userAccessToken)}`;

  while (url) {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw await buildMetaApiError(response, `Failed to list ads for ad set ${adSetId}`);
    }
    const page = (await response.json()) as GraphPagedResponse<GraphAdNode>;
    for (const node of page.data) {
      results.push({ id: node.id, name: node.name, status: node.status });
    }
    url = page.paging?.next ?? "";
  }
  return results;
}

// ---------------------------------------------------------------------
// Phase 7: automatic Page webhook subscription - two DISTINCT Meta
// concepts, both needed for a Page's leadgen events to actually reach this
// app, neither ever exposed to a customer as something they configure:
//
//   1. APP-level: which object/fields THIS Meta App's webhook product is
//      subscribed to at all, and where events for it get delivered
//      (callback_url). One Meta App for the whole deployment (see
//      .env.example) - so this is effectively a one-time, idempotent
//      "make sure it's still configured correctly" call, safe to repeat.
//   2. PAGE-level: whether one specific Page has opted this App in to
//      receive its events at all. This is the part that's genuinely
//      per-tenant/per-Page and runs every time a Page is selected.
// ---------------------------------------------------------------------

/** Ensures the App's webhook product is subscribed to `page`/`leadgen`
 * events at the given callback URL - idempotent (Meta upserts the
 * subscription config on every call), so safe to call before every Page
 * subscribe rather than tracking "did we already do this once" ourselves.
 * Meta calls back to `callbackUrl` synchronously during this request to
 * verify it (GET with hub.challenge, expecting `verifyToken` echoed back)
 * - callbackUrl must be a real, reachable HTTPS URL for this to succeed. */
export async function ensureAppLeadgenSubscription(
  appId: string,
  appSecret: string,
  callbackUrl: string,
  verifyToken: string,
): Promise<void> {
  const url =
    `${getBaseUrl()}/${appId}/subscriptions?object=page&fields=leadgen` +
    `&callback_url=${encodeURIComponent(callbackUrl)}&verify_token=${encodeURIComponent(verifyToken)}` +
    `&access_token=${encodeURIComponent(`${appId}|${appSecret}`)}`;
  const response = await fetchWithRetry(url, 3, "POST");
  if (!response.ok) {
    throw await buildMetaApiError(response, "Failed to configure the app's leadgen webhook");
  }
}

/** Step "subscribe": opts one Page in to sending its leadgen events to
 * whatever this App's webhook is configured for (see
 * ensureAppLeadgenSubscription above). Uses the PAGE's own access token,
 * not the connection's user token - same auth model as getPageLeadForms. */
export async function subscribePageToLeadgen(pageId: string, pageAccessToken: string): Promise<void> {
  const url = `${getBaseUrl()}/${pageId}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(pageAccessToken)}`;
  const response = await fetchWithRetry(url, 3, "POST");
  if (!response.ok) {
    throw await buildMetaApiError(response, `Failed to subscribe page ${pageId}`);
  }
}

export interface MetaLeadFormQuestion {
  key: string;
  label: string;
  type: string;
}

export interface MetaLeadFormSummary {
  id: string;
  name: string;
  status: string;
  // Phase 10 - THIS form's own questions, exactly as Meta returns them.
  // Every Meta form can ask different questions (the whole point of
  // dynamic field mapping) - this is what src/application/metaSync/
  // metaFormService.ts persists onto metaForms.questions and seeds
  // meta_form_field_mappings from, so nothing about a form's field list is
  // ever hard-coded in application code.
  questions: MetaLeadFormQuestion[];
}

interface GraphLeadFormQuestionNode {
  key: string;
  label: string;
  type: string;
}

interface GraphLeadFormNode {
  id: string;
  name: string;
  status: string;
  questions?: GraphLeadFormQuestionNode[];
}

/** Every lead-gen form under one Page, WITH each form's own question list
 * (field expansion - Meta returns `questions` as a plain array on the form
 * node, no separate paginated call needed). Requires the PAGE's own access
 * token (leads_retrieval scope on the page token -
 * meta_pages.pageAccessTokenEncrypted), not the connection's user token -
 * same auth model Meta's Leadgen Forms API already requires for reading a
 * Page's own leads. */
export async function getPageLeadForms(pageId: string, pageAccessToken: string): Promise<MetaLeadFormSummary[]> {
  const results: MetaLeadFormSummary[] = [];
  let url =
    `${getBaseUrl()}/${pageId}/leadgen_forms?fields=id,name,status,questions{key,label,type}` +
    `&limit=100&access_token=${encodeURIComponent(pageAccessToken)}`;

  while (url) {
    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw await buildMetaApiError(response, `Failed to list lead forms for page ${pageId}`);
    }
    const page = (await response.json()) as GraphPagedResponse<GraphLeadFormNode>;
    for (const node of page.data) {
      results.push({
        id: node.id,
        name: node.name,
        status: node.status,
        questions: (node.questions ?? []).map((q) => ({ key: q.key, label: q.label, type: q.type })),
      });
    }
    url = page.paging?.next ?? "";
  }
  return results;
}
