// MetaPageService (Phase 6 naming) - owns the "Loading Pages" and "Loading
// Instagram" sync steps (Instagram business accounts are discovered as
// part of the same Graph API call as Pages - see graphClient.getUserPages -
// so both are synced together here, just reported as two separate UI
// steps), plus Phase 5's Page/Instagram-account selection.

import { getUserPages, type MetaPageSummary } from "../../infrastructure/meta/graphClient";
import {
  getSelectedMetaPage,
  markPageWebhookFailed,
  replaceMetaInstagramAccounts,
  replaceMetaPages,
  selectMetaInstagramAccount,
  selectMetaPage,
} from "../../infrastructure/db/repositories/metaIntegration";
import { subscribePageWebhook, type SubscribePageWebhookResult } from "./metaWebhookService";

export interface SyncPagesResult {
  pagesCount: number;
  instagramCount: number;
  // Phase 16 - the raw list Meta just returned, alongside the counts above.
  // Exposed so the reconnect pipeline (metaOAuth.ts's completeMetaConnection)
  // can run "Validate Page" against the SAME fetch this function already
  // made, rather than calling getUserPages a second time.
  pages: MetaPageSummary[];
}

/** Fetches every Page the connection can see and upserts both meta_pages
 * and meta_instagram_accounts (for whichever of those Pages have an IG
 * business account linked) - tenant-scoped, safe to re-run. */
export async function syncPagesAndInstagram(
  tenantId: string,
  connectionId: string,
  userAccessToken: string,
): Promise<SyncPagesResult> {
  const pages = await getUserPages(userAccessToken);

  await replaceMetaPages(
    tenantId,
    connectionId,
    pages.map((p) => ({
      pageId: p.id,
      pageName: p.name,
      pageAccessToken: p.accessToken,
      instagramBusinessAccountId: p.instagramBusinessAccountId ?? null,
    })),
  );

  const instagramInputs: { pageId: string; instagramAccountId: string; username: string | null }[] = [];
  for (const p of pages) {
    if (p.instagramBusinessAccountId) {
      instagramInputs.push({
        pageId: p.id,
        instagramAccountId: p.instagramBusinessAccountId,
        username: p.instagramUsername ?? null,
      });
    }
  }
  await replaceMetaInstagramAccounts(tenantId, connectionId, instagramInputs);

  return { pagesCount: pages.length, instagramCount: instagramInputs.length, pages };
}

export interface SelectPageResult {
  page: Awaited<ReturnType<typeof selectMetaPage>>;
  webhook: SubscribePageWebhookResult | null; // null only if page itself is null (nothing was selected)
}

/**
 * Phase 5: "Select Facebook Page" - tenant-scoped (verified by
 * selectMetaPage itself), single-select. Returns { page: null, webhook:
 * null } if pageDbId doesn't belong to this tenant.
 *
 * Phase 7: "Once a Page is selected, the backend must automatically
 * subscribe the Page" - done right here, synchronously, so the selection
 * response itself already reflects whether the subscription succeeded
 * (never a silent, separate step the caller has to remember to trigger).
 */
export async function selectPage(tenantId: string, pageDbId: string): Promise<SelectPageResult> {
  const page = await selectMetaPage(tenantId, pageDbId);
  if (!page) return { page: null, webhook: null };

  const webhook = await subscribePageWebhook(tenantId, page.id);
  return { page, webhook };
}

/** Phase 5: "Select Instagram Account" - independent of which Page was
 * selected above (see the schema comment on meta_instagram_accounts for
 * why these are two separate choices). */
export async function selectInstagramAccount(tenantId: string, instagramDbId: string) {
  return selectMetaInstagramAccount(tenantId, instagramDbId);
}

/**
 * Phase 7 "Retry" button - re-runs the exact same subscribe pipeline for
 * whichever Page this tenant currently has selected (never a page id from
 * the request - "ensure all records belong to the current tenant" the
 * simplest possible way here: there's nothing to trust from the caller at
 * all). Returns null if the tenant has no Page selected to retry.
 */
export async function retryPageWebhook(tenantId: string): Promise<SubscribePageWebhookResult | null> {
  const page = await getSelectedMetaPage(tenantId);
  if (!page) return null;
  return subscribePageWebhook(tenantId, page.id);
}

export interface ValidateAndResubscribeResult {
  hadSelectedPage: boolean; // false: nothing to validate (no Page was ever selected) - both fields below are meaningless/null in that case
  pageStillAccessible: boolean | null;
  webhook: SubscribePageWebhookResult | null; // null when hadSelectedPage is false, OR the Page's access was removed (see below - resubscribing would just fail the same way)
}

/**
 * Phase 16 - "Validate Page" + "Re-subscribe webhook", the two reconnect-
 * pipeline steps that only matter when the tenant already had a Page
 * selected before this (re)connect. `freshPages` is Meta's CURRENT answer
 * to "what Pages can this token see" - the caller (metaOAuth.ts's
 * completeMetaConnection) already fetched it as part of the Pages sync
 * step, passed straight through here rather than fetched a second time.
 *
 * "Page access removed": if the tenant's previously-selected Page is not
 * in that fresh list, Meta itself no longer grants this app/token access
 * to it (the Page was unlinked from the app, or a Business admin revoked
 * it) - this is recorded clearly on the Page's own webhook status (never
 * silently dropped - same "do not silently fail" rule Phase 7 already
 * established for a subscribe failure) rather than left to surface later
 * as a confusing lead-ingestion error. The (now-guaranteed-to-fail)
 * subscribe attempt is skipped entirely in this case - there's nothing to
 * gain from calling Meta just to get the exact same rejection back.
 *
 * Otherwise, the Page is still accessible, so its webhook subscription is
 * actively re-established: Meta drops an App's page-level subscription
 * once the authorization it depended on breaks, so a reconnect must
 * explicitly resubscribe rather than assume the old subscription is still
 * live.
 */
export async function validateAndResubscribeSelectedPage(tenantId: string, freshPages: MetaPageSummary[]): Promise<ValidateAndResubscribeResult> {
  const selectedPage = await getSelectedMetaPage(tenantId);
  if (!selectedPage) return { hadSelectedPage: false, pageStillAccessible: null, webhook: null };

  const stillAccessible = freshPages.some((p) => p.id === selectedPage.pageId);
  if (!stillAccessible) {
    await markPageWebhookFailed(
      selectedPage.id,
      "Access to this Page was removed by Meta. Select a different Page, or ask your Meta Business admin to restore access, then reconnect.",
    );
    return { hadSelectedPage: true, pageStillAccessible: false, webhook: null };
  }

  const webhook = await subscribePageWebhook(tenantId, selectedPage.id);
  return { hadSelectedPage: true, pageStillAccessible: true, webhook };
}
