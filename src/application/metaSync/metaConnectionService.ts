// MetaConnectionService (Phase 6 naming) - owns the "Connecting Meta" step
// of the sync pipeline: confirming the tenant has an active Meta connection
// and handing back its decrypted user access token for every other service
// in this folder to use. Deliberately thin - the actual OAuth handshake
// that CREATES a connection is src/application/metaOAuth.ts (Phase 3);
// this only reads an already-established one.
//
// Architecture note (Phase 6 asked for "MetaConnectionService" etc. and to
// "reuse existing service architecture if available"): this codebase's
// existing architecture is function-exporting modules per concern
// (src/application/*.ts orchestrating, src/infrastructure/db/repositories/*.ts
// persisting - see metaOAuth.ts/processLead.ts for the established shape),
// not class-based services. These modules ARE that architecture, named to
// match what Phase 6 asked for, rather than introducing a new OOP pattern
// this codebase doesn't otherwise use.

import { getActiveMetaConnectionInternal, markMetaConnectionNeedsReauth } from "../../infrastructure/db/repositories/metaIntegration";
import { MetaApiError, type MetaAuthErrorKind } from "../../infrastructure/meta/graphClient";

export class MetaSyncNotConnectedError extends Error {
  constructor() {
    super("This tenant has no active Meta connection.");
  }
}

/** Decrypted connection + user access token for the sync pipeline to use.
 * Throws MetaSyncNotConnectedError if the tenant isn't connected - the
 * orchestrator (runMetaSync.ts) treats that as "connecting" itself
 * failing, with every other step marked skipped. */
export async function getConnectionForSync(tenantId: string) {
  const connection = await getActiveMetaConnectionInternal(tenantId);
  if (!connection) throw new MetaSyncNotConnectedError();
  return connection;
}

/** Human-readable line for whichever of the five auth failures Phase 16
 * asked for - shown as the specific "Reason:" detail underneath the status
 * screen's fixed "Your Meta connection needs to be renewed." copy (see
 * public/settings/integrations/meta-status.html). Deliberately never
 * includes Meta's raw error JSON - that goes in server logs (see the
 * call sites below), not in front of the tenant. */
function describeAuthErrorKind(kind: MetaAuthErrorKind): string {
  switch (kind) {
    case "expired_token":
      return "Your Meta access token has expired.";
    case "revoked":
      return "Meta authorization was revoked for this connection.";
    case "missing_permission":
      return "This connection is missing a permission Meta requires for lead capture.";
    case "page_access_removed":
      return "Access to a connected Meta Page was removed.";
    case "auth_failed":
    default:
      return "Meta rejected this connection's authentication.";
  }
}

/**
 * Phase 16 - THE single place every Meta-API-calling code path (the sync
 * pipeline in runMetaSync.ts, lead ingestion in processMetaLeadEvent.ts)
 * reports a caught error through, so "was this an auth failure, and if so
 * flag the connection" is decided and acted on identically everywhere
 * rather than re-implemented per caller. A no-op for anything that isn't a
 * classified MetaApiError (network errors, DB errors, MetaApiErrors with no
 * authErrorKind - i.e. NOT one of the five conditions this phase covers) -
 * those are left exactly as their caller was already handling them
 * (retried, logged, whatever), never escalated to "needs reauth".
 *
 * ONLY ever touches the metaConnections row (status + lastError) - never
 * leads, never any other table. "Existing CRM leads must NEVER be deleted
 * because Meta authorization fails" holds structurally here: this function
 * has no access to a lead id or the leads table at all.
 */
export async function flagConnectionIfAuthError(tenantId: string, err: unknown, context: string): Promise<void> {
  if (!(err instanceof MetaApiError) || !err.authErrorKind) return;

  const connection = await getActiveMetaConnectionInternal(tenantId);
  if (!connection) return; // already not-active (e.g. a concurrent flag/disconnect just beat this one) - nothing to demote

  console.error(`[meta-auth] ${context} for tenant ${tenantId}: ${err.authErrorKind} - ${err.message}`);
  await markMetaConnectionNeedsReauth(connection.id, describeAuthErrorKind(err.authErrorKind));
}
