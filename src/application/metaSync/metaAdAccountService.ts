// MetaAdAccountService (Phase 6 naming) - owns the "Loading Ad Accounts"
// sync step, plus Phase 5's ad account selection.

import { getUserAdAccounts } from "../../infrastructure/meta/graphClient";
import { replaceMetaAdAccounts, selectMetaAdAccount } from "../../infrastructure/db/repositories/metaIntegration";

export async function syncAdAccounts(tenantId: string, connectionId: string, userAccessToken: string): Promise<number> {
  const adAccounts = await getUserAdAccounts(userAccessToken);
  await replaceMetaAdAccounts(
    tenantId,
    connectionId,
    adAccounts.map((a) => ({ adAccountId: a.id, name: a.name })),
  );
  return adAccounts.length;
}

/** Phase 5: "Select Ad Account" - tenant-scoped (verified by
 * selectMetaAdAccount itself), single-select. Returns null if
 * adAccountDbId doesn't belong to this tenant. */
export async function selectAdAccount(tenantId: string, adAccountDbId: string) {
  return selectMetaAdAccount(tenantId, adAccountDbId);
}
