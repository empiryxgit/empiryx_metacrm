// MetaWhatsappWebhookService - the WhatsApp counterpart to
// metaWebhookService.ts, and the fix for a real gap the original WhatsApp
// Lead Capture implementation left open: discovering a tenant's WhatsApp
// Business Account (whatsappDiscoveryService.ts) only ever READS Meta's
// data - it never told Meta to actually start delivering that WABA's
// inbound-message webhook events to this app. Without the two calls this
// file makes, a tenant can have a fully "connected" WhatsApp number and
// still never receive a single WhatsApp lead, because Meta simply never
// sends anything - not an error, just silence, which is why this gap went
// unnoticed until a real tenant reported "leads are not showing".
//
// Same two Graph API calls as the Page/leadgen pipeline
// (metaWebhookService.ts), documented on graphClient.ts's
// ensureAppWhatsappMessagesSubscription/subscribeWabaToApp: first make sure
// this deployment's one Meta App is still configured to receive
// whatsapp_business_account/messages events at all (idempotent, cheap to
// repeat - and shares the SAME callback URL and verify token as the
// leadgen subscription, since both object types deliver to one app-level
// webhook product), then opt this specific WABA in. Every outcome -
// success or failure - is written to meta_whatsapp_accounts' webhook_*
// columns, mirroring meta_pages exactly ("Do not silently fail").

import { getEnv } from "../../infrastructure/env";
import { ensureAppWhatsappMessagesSubscription, subscribeWabaToApp, MetaApiError } from "../../infrastructure/meta/graphClient";
import { getAppId, getAppSecret } from "../metaOAuth";
import {
  getMetaWhatsappAccountInternal,
  markWhatsappAccountWebhookActive,
  markWhatsappAccountWebhookFailed,
  selectMetaWhatsappAccount,
} from "../../infrastructure/db/repositories/whatsapp";
import { getActiveMetaConnectionInternal } from "../../infrastructure/db/repositories/metaIntegration";
import { flagConnectionIfAuthError } from "./metaConnectionService";
import { MetaWebhookConfigError, getWebhookVerifyToken } from "./metaWebhookService";

/** Same PUBLIC_BASE_URL-based pattern as metaWebhookService.ts's
 * getLeadgenWebhookCallbackUrl - deliberately the SAME path, not a
 * different one: Meta delivers every product an App subscribes to (Page
 * leadgen AND a WhatsApp Business Account's messages) to that App's one
 * registered Callback URL, and api/webhooks/meta/handler.ts's
 * handleMetaLeadgenWebhook already branches internally on the payload's
 * `object` field to route each. Registering a second, different callback
 * URL here would just mean Meta calls back to a URL this app also happens
 * to serve identically - there is no reason to, and every reason not to
 * (one fewer thing to keep in sync if PUBLIC_BASE_URL ever changes). */
function getWhatsappWebhookCallbackUrl(): string {
  const base = getEnv("PUBLIC_BASE_URL");
  if (!base) throw new MetaWebhookConfigError("PUBLIC_BASE_URL is not set. See .env.example.");
  return `${base.replace(/\/$/, "")}/api/webhooks/meta/leadgen`;
}

export interface SubscribeWhatsappWebhookResult {
  ok: boolean;
  status: "active" | "failed";
  lastError: string | null;
}

/**
 * Ensures the App-level `whatsapp_business_account`/`messages` subscription
 * exists, then subscribes this one WABA. `whatsappAccountDbId` is OUR row
 * id, already tenant-verified by the caller - this function itself does one
 * more tenant-scoped lookup (getMetaWhatsappAccountInternal) rather than
 * trusting a bare id, consistent with "ensure all records belong to the
 * current tenant" everywhere else in this integration.
 *
 * Called from two places, same function either way (never a different code
 * path for "first time" vs "retry"), mirroring subscribePageWebhook:
 *   1. whatsappDiscoveryService.ts - on EVERY discovery run, for whichever
 *      account ends up selected (just now, or already selected from a
 *      prior connect) - idempotent, so safe to re-confirm every time rather
 *      than only on the one moment a number is first auto-selected. This is
 *      what makes the fix self-healing for a tenant who selected a number
 *      before this subscribe step existed at all: their very next
 *      reconnect/resync (which already re-runs discovery) subscribes them
 *      retroactively, with no separate manual step required.
 *   2. api/webhooks/meta/handler.ts's handleSelectAsset - when a tenant
 *      with more than one discovered number manually picks one.
 */
export async function subscribeWhatsappWebhook(
  tenantId: string,
  whatsappAccountDbId: string,
  userAccessToken: string,
): Promise<SubscribeWhatsappWebhookResult> {
  const account = await getMetaWhatsappAccountInternal(tenantId, whatsappAccountDbId);
  if (!account) {
    // Should not happen in practice (caller just selected/looked up this
    // row for this same tenant) - defensive only, still recorded nowhere
    // since there's no row to record it on.
    return { ok: false, status: "failed", lastError: "WhatsApp account not found for this tenant." };
  }

  try {
    const appId = getAppId();
    const appSecret = getAppSecret();
    await ensureAppWhatsappMessagesSubscription(appId, appSecret, getWhatsappWebhookCallbackUrl(), getWebhookVerifyToken());
  } catch (err) {
    const message = describeSubscribeError(err, "app");
    await markWhatsappAccountWebhookFailed(account.id, message);
    // A missing-permission failure here (e.g. whatsapp_business_management
    // was revoked after connect) means the connection itself needs reauth,
    // not just this one WABA's webhook - flag it the same way the Page
    // pipeline's subscribe/sync/ingestion paths already do.
    await flagConnectionIfAuthError(tenantId, err, "WhatsApp webhook subscribe (app-level)");
    return { ok: false, status: "failed", lastError: message };
  }

  try {
    await subscribeWabaToApp(account.wabaId, userAccessToken);
  } catch (err) {
    const message = describeSubscribeError(err, "waba");
    await markWhatsappAccountWebhookFailed(account.id, message);
    await flagConnectionIfAuthError(tenantId, err, "WhatsApp webhook subscribe (WABA-level)");
    return { ok: false, status: "failed", lastError: message };
  }

  await markWhatsappAccountWebhookActive(account.id);
  return { ok: true, status: "active", lastError: null };
}

export interface SelectWhatsappAccountResult {
  account: Awaited<ReturnType<typeof selectMetaWhatsappAccount>>;
  webhook: SubscribeWhatsappWebhookResult | null; // null only if account itself is null (nothing was selected)
}

/**
 * "Select WhatsApp Number" - the manual-picker counterpart to
 * whatsappDiscoveryService.ts's auto-select branch, used when a tenant has
 * more than one discovered number (api/webhooks/meta/handler.ts's
 * handleSelectAsset, type: "whatsapp"). Tenant-scoped (verified by
 * selectMetaWhatsappAccount itself), single-select - mirrors selectPage
 * (metaPageService.ts) exactly: the automatic webhook subscribe happens
 * synchronously, right here, so the selection response itself already
 * reflects whether the subscription succeeded, never a silent, separate
 * step the caller has to remember to trigger.
 *
 * Needs the connection's own (decrypted) user access token for the WABA
 * subscribe call - fetched here via getActiveMetaConnectionInternal, the
 * same internal-only, never-exposed-over-an-API-response lookup the sync
 * pipeline already uses.
 */
export async function selectWhatsappAccount(tenantId: string, whatsappAccountDbId: string): Promise<SelectWhatsappAccountResult> {
  const account = await selectMetaWhatsappAccount(tenantId, whatsappAccountDbId);
  if (!account) return { account: null, webhook: null };

  const connection = await getActiveMetaConnectionInternal(tenantId);
  if (!connection) {
    // Should not happen in practice (selecting a discovered WhatsApp
    // account requires an active connection to have discovered it) -
    // defensive only.
    const message = "No active Meta connection for this tenant.";
    await markWhatsappAccountWebhookFailed(account.id, message);
    return { account, webhook: { ok: false, status: "failed", lastError: message } };
  }

  const webhook = await subscribeWhatsappWebhook(tenantId, account.id, connection.accessToken);
  return { account, webhook };
}

/** Maps a raw error into the short, human-readable reason the UI shows -
 * mirrors describeSubscribeError in metaWebhookService.ts exactly, never
 * leaking raw Graph API JSON at a customer. */
function describeSubscribeError(err: unknown, stage: "app" | "waba"): string {
  if (err instanceof MetaWebhookConfigError) {
    return `Meta integration is not fully configured on this server (${err.message})`;
  }
  const detail = err instanceof MetaApiError ? err.message : err instanceof Error ? err.message : String(err);
  return stage === "app" ? `Unable to configure the WhatsApp webhook. ${detail}` : `Unable to subscribe this WhatsApp number. ${detail}`;
}
