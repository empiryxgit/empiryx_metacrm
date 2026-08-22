// MetaWebhookService (Phase 7) - "Once a Page is selected, the backend
// must automatically subscribe the Page to the appropriate Meta Lead Ads
// webhook event." Called synchronously right after Phase 5's page
// selection (see metaPageService.selectPage) and again by the "Retry"
// button (POST /api/integrations/meta/webhook/retry) - same function
// either way, so retry is never a different code path than the original
// automatic attempt.
//
// Two Graph API calls, both documented on graphClient.ts's
// ensureAppLeadgenSubscription/subscribePageToLeadgen: first make sure
// this deployment's one Meta App is still configured to receive
// page/leadgen events at all (idempotent, cheap to repeat), then opt this
// specific Page in. Every outcome - success or failure - is written to
// meta_pages' webhook_* columns; nothing is ever left unrecorded ("Do not
// silently fail").

import { ensureAppLeadgenSubscription, subscribePageToLeadgen, MetaApiError } from "../../infrastructure/meta/graphClient";
import { getAppId, getAppSecret } from "../metaOAuth";
import { getMetaPageInternal, markPageWebhookActive, markPageWebhookFailed } from "../../infrastructure/db/repositories/metaIntegration";
import { flagConnectionIfAuthError } from "./metaConnectionService";

export class MetaWebhookConfigError extends Error {}

/** Same PUBLIC_BASE_URL-based pattern metaOAuth.ts's getRedirectUri uses -
 * the App-level webhook subscription needs ONE fixed, stable callback URL
 * (this deployment's own leadgen event receiver). Deliberately a separate
 * fixed path from the legacy per-campaign `/api/webhooks/meta/:slug`
 * receiver - this one is app-wide, not per-campaign.
 *
 * Phase 11: registers the canonical /leadgen path (see
 * api/webhooks/meta/handler.ts's header comment) - the older
 * /page-events path this used to register is kept alive server-side
 * indefinitely as a compatibility alias, but every (re)subscribe from
 * here forward - a fresh "Select Page", or "Retry" - moves Meta's own
 * app-level subscription over to /leadgen. Since the app-level
 * subscription is one global setting per Meta App (not per tenant), the
 * very first tenant to select/retry after this ships switches Meta's
 * delivery target for every tenant at once - the same "one shared
 * app-level callback URL" behavior this always had, just pointed at a new
 * path. */
function getLeadgenWebhookCallbackUrl(): string {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new MetaWebhookConfigError("PUBLIC_BASE_URL is not set. See .env.example.");
  return `${base.replace(/\/$/, "")}/api/webhooks/meta/leadgen`;
}

function getWebhookVerifyToken(): string {
  const value = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!value) throw new MetaWebhookConfigError("META_WEBHOOK_VERIFY_TOKEN is not set. See .env.example.");
  return value;
}

export interface SubscribePageWebhookResult {
  ok: boolean;
  status: "active" | "failed";
  lastError: string | null;
}

/**
 * Ensures the App-level subscription exists, then subscribes this one
 * Page. `pageDbId` is OUR row id, already tenant-verified by the caller
 * (selectMetaPage's own tenant scoping, or the retry handler's "the
 * tenant's currently selected page" lookup) - this function itself does
 * one more tenant-scoped lookup (getMetaPageInternal) rather than trusting
 * a bare id, consistent with "ensure all records belong to the current
 * tenant" everywhere else in this integration.
 */
export async function subscribePageWebhook(tenantId: string, pageDbId: string): Promise<SubscribePageWebhookResult> {
  const page = await getMetaPageInternal(tenantId, pageDbId);
  if (!page) {
    // Should not happen in practice (caller just selected/looked up this
    // row for this same tenant) - defensive only, still recorded nowhere
    // since there's no row to record it on.
    return { ok: false, status: "failed", lastError: "Page not found for this tenant." };
  }

  try {
    const appId = getAppId();
    const appSecret = getAppSecret();
    await ensureAppLeadgenSubscription(appId, appSecret, getLeadgenWebhookCallbackUrl(), getWebhookVerifyToken());
  } catch (err) {
    const message = describeSubscribeError(err, "app");
    await markPageWebhookFailed(page.id, message);
    // Phase 16 - a missing-permission failure here (e.g. pages_manage_metadata
    // was revoked) means the connection itself needs reauth, not just this
    // one Page's webhook - flag it the same way the sync/ingestion paths do.
    await flagConnectionIfAuthError(tenantId, err, "Webhook subscribe (app-level)");
    return { ok: false, status: "failed", lastError: message };
  }

  try {
    await subscribePageToLeadgen(page.pageId, page.pageAccessToken);
  } catch (err) {
    const message = describeSubscribeError(err, "page");
    await markPageWebhookFailed(page.id, message);
    // Phase 16 - "Page access removed" (or any other classified auth
    // failure) surfacing here means the tenant needs to reconnect, not just
    // retry the subscribe - flag the connection, same as above.
    await flagConnectionIfAuthError(tenantId, err, "Webhook subscribe (page-level)");
    return { ok: false, status: "failed", lastError: message };
  }

  await markPageWebhookActive(page.id);
  return { ok: true, status: "active", lastError: null };
}

/** Maps a raw error into the short, human-readable reason the UI shows
 * ("Reason: Unable to subscribe this Page.") - the Phase 7 example's exact
 * wording for the common case, with the underlying detail appended where
 * it's likely to actually help (config problems), never leaking raw Graph
 * API JSON at a customer. */
function describeSubscribeError(err: unknown, stage: "app" | "page"): string {
  if (err instanceof MetaWebhookConfigError) {
    return `Meta integration is not fully configured on this server (${err.message})`;
  }
  const detail = err instanceof MetaApiError ? err.message : err instanceof Error ? err.message : String(err);
  return stage === "app" ? `Unable to configure the Meta webhook. ${detail}` : `Unable to subscribe this Page. ${detail}`;
}
