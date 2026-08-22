// Phase 6 orchestrator: POST /api/integrations/meta/sync's actual work.
// Drives MetaConnectionService -> MetaPageService -> MetaAdAccountService ->
// MetaCampaignService -> MetaFormService in the fixed order the Phase 6 UI
// example shows, publishing progress to Redis after every step (see
// src/infrastructure/cache/redis.ts's setMetaSyncProgress) so
// GET /api/integrations/meta/sync-status can render it live while this
// request is still in flight.
//
// Each phase after "connecting" is independent and best-effort: one
// phase's failure is recorded on that phase alone (status "error") and
// does NOT stop the others from running - Pages failing shouldn't prevent
// Ad Accounts from at least trying, for instance. Campaigns/Forms are the
// exception in the other direction - they depend on a selected ad
// account/Page existing at all, and are marked "skipped" (not "error")
// when neither is selected yet, since that's an expected, normal state
// (Phase 5 hasn't happened yet), not a failure.
//
// Safe to run multiple times: every underlying write is an upsert keyed on
// a tenant-scoped unique index (see metaIntegration.ts / metaSync.ts) -
// re-running this never creates duplicate rows.

import { getConnectionForSync, flagConnectionIfAuthError } from "./metaConnectionService";
import { syncPagesAndInstagram } from "./metaPageService";
import { syncAdAccounts } from "./metaAdAccountService";
import { syncCampaignsForSelectedAdAccount } from "./metaCampaignService";
import { syncFormsForSelectedPage } from "./metaFormService";
import { recordMetaConnectionSyncResult } from "../../infrastructure/db/repositories/metaIntegration";
import { setMetaSyncProgress, type MetaSyncStep, type MetaSyncStepStatus } from "../../infrastructure/cache/redis";
import { MetaApiError } from "../../infrastructure/meta/graphClient";

/** Phase 16 - distinguishes "this one step failed" (the pre-existing
 * best-effort behavior below - keep trying the rest) from "the connection
 * itself is broken" (expired/revoked token, missing permission, removed
 * Page access - every remaining step uses the SAME user token, so they'd
 * all fail the exact same way; there's no point burning Graph API calls to
 * discover that four more times). */
function isAuthError(err: unknown): boolean {
  return err instanceof MetaApiError && !!err.authErrorKind;
}

const STEP_DEFS: Array<{ key: string; label: string }> = [
  { key: "connecting", label: "Connecting Meta" },
  { key: "pages", label: "Loading Pages" },
  { key: "instagram", label: "Loading Instagram" },
  { key: "ad_accounts", label: "Loading Ad Accounts" },
  { key: "campaigns", label: "Loading Campaigns" },
  { key: "forms", label: "Loading Forms" },
  { key: "completed", label: "Completed" },
];

export interface MetaSyncResult {
  ok: boolean; // false if any non-"connecting" step recorded an "error" (skips are expected/fine)
  steps: MetaSyncStep[];
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export async function runMetaSync(tenantId: string): Promise<MetaSyncResult> {
  let steps: MetaSyncStep[] = STEP_DEFS.map((d) => ({ key: d.key, label: d.label, status: "pending" }));

  const publish = async () => {
    await setMetaSyncProgress(tenantId, { steps, updatedAt: new Date().toISOString() });
  };
  const setStep = (key: string, status: MetaSyncStepStatus, detail?: string) => {
    steps = steps.map((s) => (s.key === key ? { ...s, status, detail } : s));
  };
  const skipRemaining = (reason: string) => {
    steps = steps.map((s) =>
      s.key !== "connecting" && s.key !== "completed" && s.status === "pending" ? { ...s, status: "skipped", detail: reason } : s,
    );
  };

  setStep("connecting", "running");
  await publish();

  let connection;
  try {
    connection = await getConnectionForSync(tenantId);
    setStep("connecting", "done", connection.metaUserName ?? connection.metaUserId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStep("connecting", "error", message);
    skipRemaining("Meta is not connected.");
    setStep("completed", "error", "Not connected.");
    await publish();
    return { ok: false, steps };
  }
  await publish();

  let anyError = false;
  // Phase 16 - set the instant any step's failure is classified as an auth
  // problem (see isAuthError above). Once set, every remaining step is
  // skipped rather than attempted - they all share the same now-broken
  // user token, so there is nothing a "Loading Ad Accounts" step could
  // discover that "Loading Pages" hasn't already - and the connection
  // itself has already been flagged "needs_reauth" by flagConnectionIfAuthError,
  // which is the actual fix the tenant needs (Reconnect Meta), not a retry.
  let authFailure = false;

  // Pages + Instagram - one Graph call under the hood, reported as two
  // steps per the Phase 6 UI example.
  setStep("pages", "running");
  setStep("instagram", "running");
  await publish();
  try {
    const result = await syncPagesAndInstagram(tenantId, connection.id, connection.accessToken);
    setStep("pages", "done", pluralize(result.pagesCount, "page"));
    setStep("instagram", "done", pluralize(result.instagramCount, "account"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStep("pages", "error", message);
    setStep("instagram", "error", message);
    anyError = true;
    if (isAuthError(err)) {
      authFailure = true;
      await flagConnectionIfAuthError(tenantId, err, "Meta sync (Pages)");
    }
  }
  await publish();

  // Ad accounts
  if (!authFailure) {
    setStep("ad_accounts", "running");
    await publish();
    try {
      const count = await syncAdAccounts(tenantId, connection.id, connection.accessToken);
      setStep("ad_accounts", "done", pluralize(count, "account"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStep("ad_accounts", "error", message);
      anyError = true;
      if (isAuthError(err)) {
        authFailure = true;
        await flagConnectionIfAuthError(tenantId, err, "Meta sync (Ad Accounts)");
      }
    }
    await publish();
  }

  // Campaigns (+ ad sets + ads), scoped to the selected ad account.
  if (!authFailure) {
    setStep("campaigns", "running");
    await publish();
    try {
      const result = await syncCampaignsForSelectedAdAccount(tenantId, connection.accessToken);
      if (result.skipped) {
        setStep("campaigns", "skipped", result.reason);
      } else {
        setStep(
          "campaigns",
          "done",
          `${pluralize(result.campaignsCount, "campaign")}, ${pluralize(result.adSetsCount, "ad set")}, ${pluralize(result.adsCount, "ad")}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStep("campaigns", "error", message);
      anyError = true;
      if (isAuthError(err)) {
        authFailure = true;
        await flagConnectionIfAuthError(tenantId, err, "Meta sync (Campaigns)");
      }
    }
    await publish();
  }

  // Forms, scoped to the selected Page.
  if (!authFailure) {
    setStep("forms", "running");
    await publish();
    try {
      const result = await syncFormsForSelectedPage(tenantId);
      if (result.skipped) {
        setStep("forms", "skipped", result.reason);
      } else {
        setStep("forms", "done", pluralize(result.formsCount, "form"));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStep("forms", "error", message);
      anyError = true;
      if (isAuthError(err)) {
        authFailure = true;
        await flagConnectionIfAuthError(tenantId, err, "Meta sync (Forms)");
      }
    }
    await publish();
  }

  if (authFailure) {
    skipRemaining("Meta connection needs reauthorization.");
  }
  setStep("completed", anyError ? "error" : "done", anyError ? "Completed with errors - see steps above." : undefined);
  await publish();

  // Durable record, independent of Redis - this is what the Settings
  // screen's own "last synced" / error banner reflects, not the transient
  // progress checklist above.
  await recordMetaConnectionSyncResult(connection.id, anyError ? "One or more sync steps failed - see step details." : null);

  return { ok: !anyError, steps };
}
