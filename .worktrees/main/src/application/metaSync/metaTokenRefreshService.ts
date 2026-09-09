// Proactive long-lived USER token refresh.
//
// Review finding (Meta integration architecture review): metaOAuth.ts
// exchanges the short-lived OAuth code for a long-lived token exactly ONCE,
// at connect/reconnect time (see completeMetaConnection) - nothing in the
// codebase ever re-exercises that exchange again afterward. Meta's
// long-lived user tokens last roughly 60 days and are NOT renewed
// automatically by Meta itself; the only way to extend one is to re-run
// the SAME `fb_exchange_token` grant using a token that is STILL VALID,
// before it expires. Without this, every tenant's Meta connection would
// silently die every ~60 days - discovered only reactively, the next time
// a Graph API call fails and gets classified as an auth error (see
// metaConnectionService.ts's flagConnectionIfAuthError), by which point
// leads may already have been missed until someone notices and
// reconnects.
//
// This closes that gap by re-exercising the exchange proactively, for any
// connection nearing its stored expiry, using its own CURRENT (still
// valid) token - never a new OAuth round trip, and never anything the
// tenant needs to do.
//
// Runs alongside the existing reconciliation sweep
// (src/application/reconcile.ts) rather than its own separate
// cron/schedule - reuses infrastructure already in place (QStash's
// 15-minute schedule, with the Vercel daily-cron GET as a fallback) instead
// of adding a new one.

import { exchangeForLongLivedToken, MetaApiError } from "../../infrastructure/meta/graphClient";
import {
  listActiveMetaConnectionsExpiringBefore,
  updateMetaConnectionToken,
} from "../../infrastructure/db/repositories/metaIntegration";
import { getAppId, getAppSecret } from "../metaOAuth";
import { flagConnectionIfAuthError } from "./metaConnectionService";

// How far ahead of actual expiry to start trying to refresh. Wide enough
// that a connection gets several chances (this runs on the same schedule
// as reconciliation - by default every 15 minutes via QStash, at minimum
// once a day via the Vercel cron fallback) before its token would actually
// expire, so one transient failure (a Meta 5xx, a network blip) is never
// the difference between "refreshed in time" and "needs reauth".
const REFRESH_WINDOW_DAYS = Number(process.env.META_TOKEN_REFRESH_WINDOW_DAYS ?? 10);

export interface RefreshExpiringTokensResult {
  checked: number;
  refreshed: number;
  failed: number;
}

export async function refreshExpiringMetaTokens(): Promise<RefreshExpiringTokensResult> {
  let appId: string;
  let appSecret: string;
  try {
    appId = getAppId();
    appSecret = getAppSecret();
  } catch (err) {
    // App not configured (missing META_APP_ID/META_APP_SECRET) - nothing
    // this sweep can do; every other Meta-facing code path is equally
    // unusable in that state, so just skip silently rather than erroring
    // the whole reconciliation run over it.
    console.warn("[meta-token-refresh] Meta app not configured, skipping this sweep:", err);
    return { checked: 0, refreshed: 0, failed: 0 };
  }

  const cutoff = new Date(Date.now() + REFRESH_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const expiring = await listActiveMetaConnectionsExpiringBefore(cutoff);

  let refreshed = 0;
  let failed = 0;

  for (const connection of expiring) {
    try {
      const result = await exchangeForLongLivedToken(connection.accessToken, appId, appSecret);
      const tokenExpiresAt = result.expiresInSeconds ? new Date(Date.now() + result.expiresInSeconds * 1000) : null;
      await updateMetaConnectionToken(connection.id, result.accessToken, tokenExpiresAt);
      refreshed++;
    } catch (err) {
      failed++;
      console.error(`[meta-token-refresh] Failed to refresh token for tenant ${connection.tenantId} (connection ${connection.id}):`, err);
      // A refresh failing because the token is ALREADY invalid (revoked,
      // expired before this sweep caught it) is exactly what
      // flagConnectionIfAuthError exists for - a no-op for any other kind
      // of failure (network blip, Meta 5xx), which just means "try again
      // on the next sweep" (this connection is still within its own
      // stored expiry until then, so nothing is lost by waiting).
      if (err instanceof MetaApiError) {
        await flagConnectionIfAuthError(connection.tenantId, err, "Proactive token refresh");
      }
    }
  }

  return { checked: expiring.length, refreshed, failed };
}
