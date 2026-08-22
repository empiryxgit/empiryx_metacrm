// Tenant-level Meta integration - the Phase 3 OAuth counterpart to the
// Phase 2 schema (crm.meta_connections / meta_pages / meta_ad_accounts).
// Mirrors the existing repositories/campaigns.ts conventions: secrets
// encrypted at rest via src/infrastructure/security/encryption.ts, masked
// views for anything an API response returns, decrypted values only ever
// returned from the "*Internal" functions Graph API calls actually need.

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../client";
import { metaAdAccounts, metaConnections, metaInstagramAccounts, metaPages } from "../schema";
import { firstOrThrow } from "../util";
import { decryptSecret, encryptSecret } from "../../security/encryption";

// ---- Connections ----------------------------------------------------------

export interface UpsertMetaConnectionInput {
  tenantId: string;
  metaUserId: string;
  metaUserName: string | null; // display name only, e.g. "John" (Phase 4 status screen)
  accessToken: string; // plaintext in, encrypted at rest
  tokenExpiresAt: Date | null;
}

/**
 * Step 11: store the connection. A tenant should normally have one ACTIVE
 * connection (enforced by the partial unique index from Phase 2) - so a
 * fresh OAuth grant for a tenant that already has an active connection
 * first demotes the old row to "revoked" (preserving it as history, per the
 * schema's own design intent) and only then inserts the new active row.
 * Never a single UPDATE-in-place: a different Meta user reconnecting should
 * read as a new connection event, not a silent edit of the old one.
 */
export async function upsertMetaConnection(input: UpsertMetaConnectionInput) {
  const db = await getDb();

  const [existingActive] = await db
    .select({ id: metaConnections.id })
    .from(metaConnections)
    .where(and(eq(metaConnections.tenantId, input.tenantId), eq(metaConnections.status, "active")))
    .limit(1);

  if (existingActive) {
    await db
      .update(metaConnections)
      .set({ status: "revoked", updatedAt: new Date() })
      .where(eq(metaConnections.id, existingActive.id));
  }

  const rows = await db
    .insert(metaConnections)
    .values({
      tenantId: input.tenantId,
      metaUserId: input.metaUserId,
      metaUserName: input.metaUserName,
      status: "active",
      accessTokenEncrypted: encryptSecret(input.accessToken),
      tokenExpiresAt: input.tokenExpiresAt,
      connectedAt: new Date(),
      lastSyncAt: new Date(), // Pages/ad accounts are always synced as part of this same connect flow
    })
    .returning();
  return firstOrThrow(rows);
}

/** Phase 3 connect-time failure only: a fresh OAuth grant that couldn't even
 * complete its initial Pages/ad-accounts sync IS an incomplete connection,
 * so this flips status away from "active" (the Settings screen then shows
 * it as needing attention rather than "Connected"). */
export async function markMetaConnectionError(connectionId: string, error: string) {
  const db = await getDb();
  await db
    .update(metaConnections)
    .set({ status: "error", lastError: error, updatedAt: new Date() })
    .where(eq(metaConnections.id, connectionId));
}

/**
 * Phase 6: records the outcome of a RE-sync (Settings -> Integrations ->
 * Meta's sync pipeline, run any time after the connection already exists)
 * without touching `status`. Deliberately distinct from
 * markMetaConnectionError above: a resync is best-effort per phase (Pages
 * OK but Forms failed, say) and must never make an otherwise-healthy,
 * already-active connection look "disconnected" on the status screen just
 * because one phase of one re-sync hit a transient error.
 */
export async function recordMetaConnectionSyncResult(connectionId: string, lastError: string | null) {
  const db = await getDb();
  await db
    .update(metaConnections)
    .set({ lastSyncAt: new Date(), lastError, updatedAt: new Date() })
    .where(eq(metaConnections.id, connectionId));
}

/**
 * Phase 16 - "Implement proper handling for: Expired token / Revoked
 * authorization / Missing permission / Page access removed / Meta API
 * authentication failure." All five are detected the same way (a Graph API
 * call classified by graphClient.classifyMetaAuthError) and handled the
 * same way: the connection is demoted to a DEDICATED "needs_reauth" status,
 * distinct from both "active" (healthy) and "error" (a non-auth technical
 * failure - a 5xx, a network blip - that a retry might fix on its own,
 * where reconnecting isn't the actual remedy) and from "revoked" (reserved
 * for the tenant's OWN deliberate Disconnect button - see
 * disconnectActiveMetaConnection - never set by this function, so a
 * tenant who chose to disconnect keeps seeing "Not Connected", never
 * "Needs Reauthorization", which would misdescribe a deliberate action as
 * a problem).
 *
 * This ONLY ever changes `status`/`lastError` on the metaConnections row
 * itself - it has no relationship whatsoever to `leads` (no FK, no
 * cascade, nothing in this codebase ever deletes a lead - see
 * src/application/metaSync/metaConnectionService.ts's
 * flagConnectionIfAuthError for where this is called from). Existing CRM
 * leads are never touched, let alone deleted, because Meta authorization
 * fails.
 */
export async function markMetaConnectionNeedsReauth(connectionId: string, reason: string) {
  const db = await getDb();
  await db
    .update(metaConnections)
    .set({ status: "needs_reauth", lastError: reason, updatedAt: new Date() })
    .where(eq(metaConnections.id, connectionId));
}

/**
 * Phase 4 "Disconnect" button: revokes the tenant's current active
 * connection. Deliberately the same "demote to revoked, never delete"
 * treatment upsertMetaConnection already gives a superseded connection on
 * reconnect - preserves history, and a later reconnect just inserts a new
 * active row (untouched by this). No-op (returns false) if the tenant has
 * no active connection to disconnect.
 */
export async function disconnectActiveMetaConnection(tenantId: string): Promise<boolean> {
  const db = await getDb();
  const rows = await db
    .update(metaConnections)
    .set({ status: "revoked", updatedAt: new Date() })
    .where(and(eq(metaConnections.tenantId, tenantId), eq(metaConnections.status, "active")))
    .returning();
  return rows.length > 0;
}

export interface MetaConnectionStatusView {
  id: string;
  status: string;
  metaUserId: string;
  metaUserName: string | null;
  tokenExpiresAt: Date | null;
  connectedAt: Date;
  lastSyncAt: Date | null;
  lastError: string | null;
}

/** View for the Settings -> Integrations -> Meta status endpoint. Never
 * includes the access token in any form - not even masked (Phase 4: "Do
 * NOT show access tokens") - so this intentionally does not decrypt
 * accessTokenEncrypted at all. */
export async function getActiveMetaConnectionView(tenantId: string): Promise<MetaConnectionStatusView | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaConnections)
    .where(and(eq(metaConnections.tenantId, tenantId), eq(metaConnections.status, "active")))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    metaUserId: row.metaUserId,
    metaUserName: row.metaUserName,
    tokenExpiresAt: row.tokenExpiresAt,
    connectedAt: row.connectedAt,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
  };
}

/**
 * Phase 16 - what the Settings -> Integrations -> Meta status screen
 * actually needs to render correctly: the most recent connection row that
 * is still RELEVANT to show the tenant, which is NOT the same question as
 * getActiveMetaConnectionView's "is there an active one" above. Before this
 * phase, that endpoint only ever looked at status='active' rows - so the
 * instant a connection was demoted to 'error' (a connect-time failure) or
 * the new 'needs_reauth' (this phase), the status screen's `connection`
 * field went straight back to null and rendered "Not Connected", silently
 * losing the very information a "Connection Error" / "Needs
 * Reauthorization" card exists to show.
 *
 * Prefers an 'active' row if one exists (the common case); otherwise falls
 * back to the single most recently updated row among 'needs_reauth' /
 * 'error' (something IS wrong, and the tenant should see why + get a
 * Reconnect button). Deliberately EXCLUDES 'revoked' - a tenant who used
 * the Disconnect button made a deliberate choice and should see a plain
 * "Not Connected" screen, never a "needs attention" one describing their
 * own action as a problem.
 */
export async function getRelevantMetaConnectionView(tenantId: string): Promise<MetaConnectionStatusView | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaConnections)
    .where(and(eq(metaConnections.tenantId, tenantId), inArray(metaConnections.status, ["active", "needs_reauth", "error"])))
    .orderBy(sql`CASE WHEN ${metaConnections.status} = 'active' THEN 0 ELSE 1 END`, desc(metaConnections.updatedAt), desc(metaConnections.connectedAt))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    metaUserId: row.metaUserId,
    metaUserName: row.metaUserName,
    tokenExpiresAt: row.tokenExpiresAt,
    connectedAt: row.connectedAt,
    lastSyncAt: row.lastSyncAt,
    lastError: row.lastError,
  };
}

/** Internal lookup for actual Graph API calls (future ingestion phases) -
 * returns the decrypted token, never exposed over an API response. */
export async function getActiveMetaConnectionInternal(tenantId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaConnections)
    .where(and(eq(metaConnections.tenantId, tenantId), eq(metaConnections.status, "active")))
    .limit(1);
  if (!row) return null;
  return { ...row, accessToken: decryptSecret(row.accessTokenEncrypted) };
}

// ---- Pages ------------------------------------------------------------------

export interface ReplaceMetaPageInput {
  pageId: string;
  pageName: string;
  pageAccessToken: string; // plaintext in, encrypted at rest
  instagramBusinessAccountId?: string | null;
}

/**
 * Steps 8 + 10: upsert every Page (and, where present, its linked Instagram
 * account) the connection has access to, keyed on the (tenantId, pageId)
 * unique index from Phase 2 - re-running a sync (e.g. a future "refresh"
 * button) updates existing rows in place rather than duplicating them, and
 * never touches `isSelected`/`webhookSubscribed`/`webhookStatus`, which are
 * the tenant's own later choices, not something a sync should ever reset.
 */
export async function replaceMetaPages(tenantId: string, connectionId: string, pages: ReplaceMetaPageInput[]) {
  if (pages.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .insert(metaPages)
    .values(
      pages.map((p) => ({
        tenantId,
        metaConnectionId: connectionId,
        pageId: p.pageId,
        pageName: p.pageName,
        pageAccessTokenEncrypted: encryptSecret(p.pageAccessToken),
        instagramBusinessAccountId: p.instagramBusinessAccountId ?? null,
        lastSyncAt: new Date(),
      })),
    )
    // On conflict, refresh everything the sync itself owns (name/token/
    // Instagram link/lastSyncAt) via `excluded.*` - the just-attempted
    // insert's own values - but deliberately leave isSelected/
    // webhookSubscribed/webhookStatus out of this SET clause entirely so a
    // re-sync can never clobber the tenant's own later choices there.
    .onConflictDoUpdate({
      target: [metaPages.tenantId, metaPages.pageId],
      set: {
        pageName: sql`excluded.page_name`,
        pageAccessTokenEncrypted: sql`excluded.page_access_token_encrypted`,
        instagramBusinessAccountId: sql`excluded.instagram_business_account_id`,
        lastSyncAt: sql`excluded.last_sync_at`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows;
}

// ---- Ad accounts --------------------------------------------------------

export interface ReplaceMetaAdAccountInput {
  adAccountId: string;
  name: string;
}

/** Step 9: upsert every ad account the connection has access to, keyed on
 * the (tenantId, adAccountId) unique index from Phase 2. Same "never touch
 * isSelected on a re-sync" rule as replaceMetaPages above. */
export async function replaceMetaAdAccounts(tenantId: string, connectionId: string, accounts: ReplaceMetaAdAccountInput[]) {
  if (accounts.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .insert(metaAdAccounts)
    .values(
      accounts.map((a) => ({
        tenantId,
        metaConnectionId: connectionId,
        adAccountId: a.adAccountId,
        name: a.name,
      })),
    )
    // Same reasoning as replaceMetaPages above - refresh only what the sync
    // owns (name), leave isSelected as the tenant's own later choice.
    .onConflictDoUpdate({
      target: [metaAdAccounts.tenantId, metaAdAccounts.adAccountId],
      set: {
        name: sql`excluded.name`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows;
}

export async function listMetaPages(tenantId: string) {
  const db = await getDb();
  return db.select().from(metaPages).where(eq(metaPages.tenantId, tenantId));
}

export async function listMetaAdAccounts(tenantId: string) {
  const db = await getDb();
  return db.select().from(metaAdAccounts).where(eq(metaAdAccounts.tenantId, tenantId));
}

/** Internal lookup for the sync pipeline (Phase 6) - needs the decrypted
 * page-scoped token to call the Leadgen Forms API, never exposed over an
 * API response. */
export async function getMetaPageInternal(tenantId: string, pageDbId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaPages)
    .where(and(eq(metaPages.tenantId, tenantId), eq(metaPages.id, pageDbId)))
    .limit(1);
  if (!row) return null;
  return { ...row, pageAccessToken: decryptSecret(row.pageAccessTokenEncrypted) };
}

/** Same decrypted-token lookup as getMetaPageInternal above, but keyed by
 * Meta's OWN page id rather than our row id - what the tenant-level
 * leadgen webhook receiver actually has (see
 * src/application/metaSync/processMetaLeadEvent.ts), since the incoming
 * payload only ever carries Meta's identifiers. */
export async function getMetaPageInternalByPageId(tenantId: string, pageId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaPages)
    .where(and(eq(metaPages.tenantId, tenantId), eq(metaPages.pageId, pageId)))
    .limit(1);
  if (!row) return null;
  return { ...row, pageAccessToken: decryptSecret(row.pageAccessTokenEncrypted) };
}

export async function getSelectedMetaPage(tenantId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaPages)
    .where(and(eq(metaPages.tenantId, tenantId), eq(metaPages.isSelected, true)))
    .limit(1);
  return row ?? null;
}

/** Phase 7: subscribe attempt succeeded - webhookLastVerifiedAt is the
 * "last time this was actually confirmed working" timestamp, so a LATER
 * failed retry (markPageWebhookFailed below) deliberately does not erase
 * it. */
export async function markPageWebhookActive(pageDbId: string) {
  const db = await getDb();
  await db
    .update(metaPages)
    .set({ webhookSubscribed: true, webhookStatus: "active", webhookLastVerifiedAt: new Date(), webhookLastError: null, updatedAt: new Date() })
    .where(eq(metaPages.id, pageDbId));
}

/** Phase 7: subscribe attempt failed - "Do not silently fail" means this
 * is ALWAYS called (never swallowed) on any error from the subscribe
 * pipeline, with a human-readable reason. */
export async function markPageWebhookFailed(pageDbId: string, error: string) {
  const db = await getDb();
  await db
    .update(metaPages)
    .set({ webhookSubscribed: false, webhookStatus: "failed", webhookLastError: error, updatedAt: new Date() })
    .where(eq(metaPages.id, pageDbId));
}

export async function getSelectedMetaAdAccount(tenantId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaAdAccounts)
    .where(and(eq(metaAdAccounts.tenantId, tenantId), eq(metaAdAccounts.isSelected, true)))
    .limit(1);
  return row ?? null;
}

// ---- Instagram accounts ----------------------------------------------------

export interface ReplaceMetaInstagramAccountInput {
  pageId: string; // the linked Page's Meta id, for display/reference only
  instagramAccountId: string;
  username?: string | null;
}

/** Phase 6: upsert every Instagram business account discovered via the
 * tenant's connected Pages, keyed on (tenantId, instagramAccountId) - same
 * "never touch isSelected on a re-sync" rule as replaceMetaPages. */
export async function replaceMetaInstagramAccounts(
  tenantId: string,
  connectionId: string,
  accounts: ReplaceMetaInstagramAccountInput[],
) {
  if (accounts.length === 0) return [];
  const db = await getDb();
  const rows = await db
    .insert(metaInstagramAccounts)
    .values(
      accounts.map((a) => ({
        tenantId,
        metaConnectionId: connectionId,
        pageId: a.pageId,
        instagramAccountId: a.instagramAccountId,
        username: a.username ?? null,
        lastSyncAt: new Date(),
      })),
    )
    .onConflictDoUpdate({
      target: [metaInstagramAccounts.tenantId, metaInstagramAccounts.instagramAccountId],
      set: {
        pageId: sql`excluded.page_id`,
        username: sql`excluded.username`,
        lastSyncAt: sql`excluded.last_sync_at`,
        updatedAt: new Date(),
      },
    })
    .returning();
  return rows;
}

export async function listMetaInstagramAccounts(tenantId: string) {
  const db = await getDb();
  return db.select().from(metaInstagramAccounts).where(eq(metaInstagramAccounts.tenantId, tenantId));
}

export async function getSelectedMetaInstagramAccount(tenantId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaInstagramAccounts)
    .where(and(eq(metaInstagramAccounts.tenantId, tenantId), eq(metaInstagramAccounts.isSelected, true)))
    .limit(1);
  return row ?? null;
}

// ---- Phase 5: asset selection (single-select per resource, per tenant) ----
//
// Each of these: (1) verifies the target row actually belongs to this
// tenant - "Ensure all records belong to the current tenant" - returning
// null rather than trusting a bare id if it doesn't; (2) unselects every
// other row of that resource type for the tenant, THEN selects the chosen
// one, as two sequential statements rather than one interactive
// transaction (this codebase's neon-http production driver doesn't support
// interactive transactions - see getDb() - so every other write in this
// file already follows this same "sequential statements" convention, e.g.
// upsertMetaConnection's revoke-then-insert above). The partial unique
// "one selected per tenant" indexes from this same phase's migration are
// the real backstop against the narrow race window this leaves (two
// concurrent saves) - one of the two would fail the constraint rather than
// silently leaving two rows selected.

export async function selectMetaPage(tenantId: string, pageDbId: string) {
  const db = await getDb();
  const [target] = await db
    .select({ id: metaPages.id })
    .from(metaPages)
    .where(and(eq(metaPages.tenantId, tenantId), eq(metaPages.id, pageDbId)))
    .limit(1);
  if (!target) return null;

  await db.update(metaPages).set({ isSelected: false, updatedAt: new Date() }).where(eq(metaPages.tenantId, tenantId));
  const rows = await db
    .update(metaPages)
    .set({ isSelected: true, updatedAt: new Date() })
    .where(eq(metaPages.id, target.id))
    .returning();
  return firstOrThrow(rows);
}

export async function selectMetaAdAccount(tenantId: string, adAccountDbId: string) {
  const db = await getDb();
  const [target] = await db
    .select({ id: metaAdAccounts.id })
    .from(metaAdAccounts)
    .where(and(eq(metaAdAccounts.tenantId, tenantId), eq(metaAdAccounts.id, adAccountDbId)))
    .limit(1);
  if (!target) return null;

  await db
    .update(metaAdAccounts)
    .set({ isSelected: false, updatedAt: new Date() })
    .where(eq(metaAdAccounts.tenantId, tenantId));
  const rows = await db
    .update(metaAdAccounts)
    .set({ isSelected: true, updatedAt: new Date() })
    .where(eq(metaAdAccounts.id, target.id))
    .returning();
  return firstOrThrow(rows);
}

export async function selectMetaInstagramAccount(tenantId: string, instagramDbId: string) {
  const db = await getDb();
  const [target] = await db
    .select({ id: metaInstagramAccounts.id })
    .from(metaInstagramAccounts)
    .where(and(eq(metaInstagramAccounts.tenantId, tenantId), eq(metaInstagramAccounts.id, instagramDbId)))
    .limit(1);
  if (!target) return null;

  await db
    .update(metaInstagramAccounts)
    .set({ isSelected: false, updatedAt: new Date() })
    .where(eq(metaInstagramAccounts.tenantId, tenantId));
  const rows = await db
    .update(metaInstagramAccounts)
    .set({ isSelected: true, updatedAt: new Date() })
    .where(eq(metaInstagramAccounts.id, target.id))
    .returning();
  return firstOrThrow(rows);
}
