// Runs on a single global QStash schedule (every 15 minutes by default -
// see scripts/setup-schedules.ts) rather than Vercel's own cron, because
// Vercel Hobby caps cron at once a day. One sweep walks every campaign
// across every company that has a verified/active webhook - see
// listActiveWebhookConfigs - rather than provisioning a schedule per
// tenant, which keeps this within QStash's free-tier schedule limits
// however many companies sign up.
//
// For each campaign, it pages through Meta's own /leads endpoint (using
// that campaign's own access token) for the last N hours and compares
// against what is already in Postgres for that campaign. Anything missing
// means the webhook delivery was lost, delayed past retry, or dead-lettered
// - reconciliation inserts it directly, tagged `recoveredByReconciliation`,
// so no lead is permanently lost even if the whole webhook path failed for
// a while.
//
// It also sweeps raw events that were durably persisted but never
// successfully published to QStash (see getUnenqueuedRawEvents) and retries
// publishing them - the second half of the durability guarantee.

import { getRecentLeadsForForm } from "../infrastructure/meta/graphClient";
import { listActiveWebhookConfigs } from "../infrastructure/db/repositories/campaigns";
import {
  getRecentMetaLeadIds,
  getUnenqueuedRawEvents,
  insertRecoveredLead,
  logEvent,
  markRawEventEnqueued,
  markRawEventEnqueueFailed,
  recordReconciliationRun,
} from "../infrastructure/db/repositories";
import { publishLeadReceived } from "../infrastructure/queue/qstash";
import { LeadPlatform } from "../domain/types";

const LOOKBACK_HOURS = Number(process.env.RECONCILIATION_LOOKBACK_HOURS ?? 6);

export interface ReconciliationSummary {
  campaignsScanned: number;
  formsScanned: number;
  metaLeadsSeen: number;
  missingLeadsFound: number;
  missingLeadsRecovered: number;
  unenqueuedEventsRetried: number;
  errors: number;
}

export async function runReconciliation(): Promise<ReconciliationSummary> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const sinceIso = since.toISOString();
  const sinceUnix = Math.floor(since.getTime() / 1000);

  const activeCampaigns = await listActiveWebhookConfigs();

  let formsScanned = 0;
  let metaLeadsSeen = 0;
  let missingFound = 0;
  let missingRecovered = 0;
  let errors = 0;

  for (const config of activeCampaigns) {
    const knownLeadIds = await getRecentMetaLeadIds(config.campaignId, sinceIso);
    let campaignMissingFound = 0;
    let campaignMissingRecovered = 0;
    let campaignLeadsSeen = 0;
    let campaignErrors = 0;

    for (const formId of config.formIds) {
      formsScanned++;
      try {
        for await (const lead of getRecentLeadsForForm(formId, sinceUnix, config.accessToken)) {
          metaLeadsSeen++;
          campaignLeadsSeen++;
          if (knownLeadIds.has(lead.id)) continue;

          missingFound++;
          campaignMissingFound++;
          const result = await insertRecoveredLead({
            companyId: config.companyId,
            branchId: config.branchId,
            crmCampaignId: config.campaignId,
            metaLeadId: lead.id,
            platform: LeadPlatform.Unknown, // reconciliation doesn't know the source object type
            pageId: lead.pageId ?? "",
            formId: lead.formId,
            adId: lead.adId,
            adName: lead.adName,
            adSetId: lead.adSetId,
            adSetName: lead.adSetName,
            campaignId: lead.campaignId,
            campaignName: lead.campaignName,
            formResponses: lead.fieldData,
            metaCreatedAt: new Date(lead.createdTime),
            // No webhook raw event exists for a lead reconciliation discovers directly from
            // the Graph API - a synthetic id is fine here since rawEventId has no FK constraint.
            rawEventId: crypto.randomUUID(),
          });

          if (result.outcome === "inserted") {
            missingRecovered++;
            campaignMissingRecovered++;
            await logEvent({
              leadId: result.id,
              eventType: "Reconciled",
              detail: `Recovered missing Meta Lead ID ${lead.id} for form ${formId}`,
            });
          }
        }
      } catch (err) {
        errors++;
        campaignErrors++;
        console.error(`[reconciliation] Error scanning form ${formId} (campaign ${config.campaignId}):`, err);
      }
    }

    await recordReconciliationRun({
      companyId: config.companyId,
      campaignId: config.campaignId,
      formsScanned: config.formIds.length,
      metaLeadsSeen: campaignLeadsSeen,
      missingLeadsFound: campaignMissingFound,
      missingLeadsRecovered: campaignMissingRecovered,
      errors: campaignErrors,
    });
  }

  // Retry publishing any raw event that was durably persisted but never
  // confirmed enqueued (queue outage right after the webhook write) -
  // global across tenants, each row already carries its own routing.
  const unenqueued = await getUnenqueuedRawEvents(15);
  let retried = 0;
  for (const event of unenqueued) {
    if (!event.metaLeadId || !event.companyId || !event.campaignId) continue;
    try {
      const messageId = await publishLeadReceived({
        rawEventId: event.id,
        metaLeadId: event.metaLeadId,
        objectType: event.objectType,
        companyId: event.companyId,
        campaignId: event.campaignId,
      });
      await markRawEventEnqueued(event.id, messageId);
      retried++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await markRawEventEnqueueFailed(event.id, message);
      errors++;
    }
  }

  return {
    campaignsScanned: activeCampaigns.length,
    formsScanned,
    metaLeadsSeen,
    missingLeadsFound: missingFound,
    missingLeadsRecovered: missingRecovered,
    unenqueuedEventsRetried: retried,
    errors,
  };
}
