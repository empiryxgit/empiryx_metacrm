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
// publishing them - the second half of the durability guarantee for the
// legacy per-campaign pipeline.
//
// Phase 11 adds the tenant-level pipeline's equivalent sweep -
// getUnenqueuedMetaLeadEvents - closing the gap metaLeadEventService.ts
// used to flag as "not yet built": a meta_lead_events row whose QStash
// publish failed (or whose process died between the durability write and
// the publish call) now self-heals here too, on the same schedule.

import { getRecentLeadsForForm, MetaApiError } from "../infrastructure/meta/graphClient";
import { listActiveWebhookConfigs } from "../infrastructure/db/repositories/campaigns";
import {
  getRecentMetaLeadIds,
  getRecentMetaLeadIdsForCompany,
  getUnenqueuedRawEvents,
  insertRecoveredLead,
  logEvent,
  markRawEventEnqueued,
  markRawEventEnqueueFailed,
  recordReconciliationRun,
} from "../infrastructure/db/repositories";
import { getUnenqueuedMetaLeadEvents, insertMetaSyncLead, markMetaLeadEventEnqueued } from "../infrastructure/db/repositories/metaLeadEvents";
import { getUnenqueuedWhatsappMessageEvents, markWhatsappMessageEventEnqueued } from "../infrastructure/db/repositories/whatsapp";
import { listTenantsForMetaLeadReconciliation } from "../infrastructure/db/repositories/metaIntegration";
import { getMetaCampaignByMetaCampaignId } from "../infrastructure/db/repositories/metaSync";
import { publishLeadReceived, publishTenantLeadReceived, publishWhatsappMessageReceived } from "../infrastructure/queue/qstash";
import { resolveLeadFields } from "./metaSync/resolveLeadFields";
import { refreshExpiringMetaTokens } from "./metaSync/metaTokenRefreshService";
import { flagConnectionIfAuthError } from "./metaSync/metaConnectionService";
import { LeadPlatform } from "../domain/types";

const LOOKBACK_HOURS = Number(process.env.RECONCILIATION_LOOKBACK_HOURS ?? 6);

export interface ReconciliationSummary {
  campaignsScanned: number;
  formsScanned: number;
  metaLeadsSeen: number;
  missingLeadsFound: number;
  missingLeadsRecovered: number;
  unenqueuedEventsRetried: number;
  // Phase 11 - the tenant-level pipeline's own count, kept separate from
  // unenqueuedEventsRetried above (a different table, a different
  // publish call, a different failure mode) rather than folded into one
  // combined number.
  unenqueuedMetaLeadEventsRetried: number;
  // WhatsApp Lead Capture feature (Phase 13) - the WhatsApp pipeline's own
  // "captured but never confirmed enqueued" retry count, same shape as
  // unenqueuedMetaLeadEventsRetried but against whatsapp_message_events. No
  // "missing WhatsApp messages" scan exists (see
  // getUnenqueuedWhatsappMessageEvents' own comment for why the Cloud API
  // has no endpoint to scan against) - this retry is the full extent of
  // this pipeline's self-healing.
  unenqueuedWhatsappMessageEventsRetried: number;
  // Review finding - the tenant-level pipeline's own MISSING LEAD recovery
  // (as opposed to unenqueuedMetaLeadEventsRetried above, which only
  // retries publishing an event that WAS captured but never confirmed
  // enqueued). Before this, a webhook delivery that Meta simply never sent
  // - the network blip / brief subscription hiccup that leaves no
  // meta_lead_events row at all - had no recovery path for this pipeline,
  // unlike the legacy per-campaign one (missingLeadsFound/Recovered
  // above), which has always self-healed this exact failure mode. Kept as
  // its own separate count, same "different table, different pipeline,
  // never folded together" convention as every other Phase-11-and-later
  // addition in this summary.
  tenantPipelineFormsScanned: number;
  tenantPipelineLeadsSeen: number;
  tenantPipelineMissingLeadsFound: number;
  tenantPipelineMissingLeadsRecovered: number;
  // Review finding - proactive long-lived token refresh (see
  // metaTokenRefreshService.ts). tokensChecked is how many active
  // connections were within the refresh window this run;
  // tokensRefreshFailed is not itself an error condition worth bumping
  // `errors` for (see the loop below) - most failures here just mean "try
  // again next sweep, still time left" - but is surfaced separately so a
  // persistently-failing refresh is visible without digging through logs.
  tokensChecked: number;
  tokensRefreshed: number;
  tokensRefreshFailed: number;
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
          // Phase 10: same dynamic field resolution the two live ingestion
          // pipelines use - a lead reconciliation recovers directly from
          // the Graph API had never had its fullName/email/phoneNumber (or
          // any custom field) extracted at all before this, an existing
          // gap this closes as a side effect of sharing the one resolver.
          const contact = await resolveLeadFields(config.companyId, lead.formId, lead.fieldData);
          const result = await insertRecoveredLead({
            companyId: config.companyId,
            branchId: config.branchId,
            crmCampaignId: config.campaignId,
            metaLeadId: lead.id,
            platform: LeadPlatform.Unknown, // reconciliation doesn't know the source object type
            pageId: lead.pageId ?? "",
            formId: lead.formId,
            formName: contact.formName,
            adId: lead.adId,
            adName: lead.adName,
            adSetId: lead.adSetId,
            adSetName: lead.adSetName,
            campaignId: lead.campaignId,
            campaignName: lead.campaignName,
            fullName: contact.fullName,
            email: contact.email,
            phoneNumber: contact.phoneNumber,
            customFields: contact.customFields,
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

  // Phase 11 - retry publishing any tenant-level meta_lead_events row that
  // was durably persisted (by the /leadgen webhook receiver) but never
  // confirmed enqueued. Same "leave it exactly as it was on a repeat
  // failure" contract as the raw-event sweep above: a publish that fails
  // again here is only logged, never re-thrown - the row stays at status
  // "received" and simply reappears in the next sweep once the age cutoff
  // has passed again (see getUnenqueuedMetaLeadEvents's own comment for
  // why there is no separate "enqueue_failed" state to set).
  const unenqueuedMetaLeadEvents = await getUnenqueuedMetaLeadEvents(15);
  let metaLeadEventsRetried = 0;
  for (const event of unenqueuedMetaLeadEvents) {
    try {
      await publishTenantLeadReceived({ leadEventId: event.id, metaLeadId: event.leadgenId, tenantId: event.tenantId });
      await markMetaLeadEventEnqueued(event.id);
      metaLeadEventsRetried++;
    } catch (err) {
      console.error(`[reconciliation] Failed to re-publish meta_lead_events ${event.id} (lead ${event.leadgenId}):`, err);
      errors++;
    }
  }

  // WhatsApp Lead Capture feature (Phase 13) - retry publishing any
  // whatsapp_message_events row that was durably persisted (by the shared
  // /leadgen webhook receiver's WhatsApp branch) but never confirmed
  // enqueued. Same "leave it exactly as it was on a repeat failure"
  // contract as the meta_lead_events sweep above.
  const unenqueuedWhatsappEvents = await getUnenqueuedWhatsappMessageEvents(15);
  let whatsappMessageEventsRetried = 0;
  for (const event of unenqueuedWhatsappEvents) {
    try {
      await publishWhatsappMessageReceived({ messageEventId: event.id, waMessageId: event.waMessageId, tenantId: event.tenantId });
      await markWhatsappMessageEventEnqueued(event.id);
      whatsappMessageEventsRetried++;
    } catch (err) {
      console.error(`[reconciliation] Failed to re-publish whatsapp_message_events ${event.id} (message ${event.waMessageId}):`, err);
      errors++;
    }
  }

  // Review finding - the tenant-level pipeline's own MISSING LEAD recovery,
  // bringing it to parity with the legacy per-campaign sweep above (which
  // has always self-healed a webhook delivery Meta simply never sent, not
  // just one that arrived but failed to enqueue). Same shape as the legacy
  // loop: page through each eligible tenant's forms via the SAME
  // getRecentLeadsForForm generator, compare against what's already in
  // Postgres for that tenant, and recover anything missing directly
  // through insertMetaSyncLead - the identical field-resolution/
  // attribution path processMetaLeadEvent.ts and the historical backfill
  // (metaFormService.ts) both already use, so a lead recovered here is
  // indistinguishable in shape from one that arrived live.
  const reconciliationTargets = await listTenantsForMetaLeadReconciliation();
  let tenantPipelineFormsScanned = 0;
  let tenantPipelineLeadsSeen = 0;
  let tenantPipelineMissingFound = 0;
  let tenantPipelineMissingRecovered = 0;

  for (const target of reconciliationTargets) {
    const knownLeadIds = await getRecentMetaLeadIdsForCompany(target.tenantId, sinceIso);

    for (const formId of target.formIds) {
      tenantPipelineFormsScanned++;
      try {
        for await (const lead of getRecentLeadsForForm(formId, sinceUnix, target.pageAccessToken)) {
          tenantPipelineLeadsSeen++;
          if (knownLeadIds.has(lead.id)) continue;

          tenantPipelineMissingFound++;
          const contact = await resolveLeadFields(target.tenantId, lead.formId, lead.fieldData);
          const metaCampaign = lead.campaignId ? await getMetaCampaignByMetaCampaignId(target.tenantId, lead.campaignId) : null;

          const result = await insertMetaSyncLead({
            companyId: target.tenantId,
            branchId: metaCampaign?.crmCampaignBranchId ?? null,
            crmCampaignId: metaCampaign?.crmCampaignId ?? null,
            metaLeadId: lead.id,
            platform: LeadPlatform.Facebook,
            pageId: lead.pageId ?? target.metaPageId,
            formId: lead.formId,
            formName: contact.formName,
            adId: lead.adId,
            adName: lead.adName,
            adSetId: lead.adSetId,
            adSetName: lead.adSetName,
            campaignId: lead.campaignId,
            campaignName: lead.campaignName,
            fullName: contact.fullName,
            email: contact.email,
            phoneNumber: contact.phoneNumber,
            customFields: contact.customFields,
            formResponses: lead.fieldData,
            metaCreatedAt: new Date(lead.createdTime),
          });

          if (result.outcome === "inserted") {
            tenantPipelineMissingRecovered++;
            await logEvent({
              leadId: result.id,
              eventType: "Reconciled",
              detail: `Recovered missing Meta Lead ID ${lead.id} for form ${formId} (tenant-level pipeline)`,
            });
          }
        }
      } catch (err) {
        errors++;
        console.error(`[reconciliation] Error scanning form ${formId} for tenant ${target.tenantId} (tenant-level pipeline):`, err);
        // Review finding - unlike the one-time historical backfill
        // (metaFormService.ts), this recurring sweep never used to flag the
        // connection on a permission/token error - it just logged and moved
        // on, forever, with no UI signal. A `leads_retrieval`/
        // `pages_manage_ads` permission revoked (or never actually cleared
        // by Meta for live use) AFTER the initial connect would then 403
        // here every 15 minutes while the connection kept showing
        // "Connected" in Settings. Same classify-and-flag call the live
        // webhook path (processMetaLeadEvent.ts) and the historical backfill
        // both already make - a non-auth error (network blip, rate limit)
        // is a no-op here, same as everywhere else that calls this.
        if (err instanceof MetaApiError) {
          await flagConnectionIfAuthError(target.tenantId, err, "Reconciliation sweep (getRecentLeadsForForm)");
        }
      }
    }
  }

  // Review finding - proactive long-lived token refresh (see
  // metaTokenRefreshService.ts's own header comment for why this needs to
  // exist at all). A refresh failure is not counted against `errors` -
  // most failures here just mean "try again on the next sweep, there's
  // still time before the token actually expires" - tokensRefreshFailed
  // surfaces it separately instead.
  const tokenRefreshResult = await refreshExpiringMetaTokens();

  return {
    campaignsScanned: activeCampaigns.length,
    formsScanned,
    metaLeadsSeen,
    missingLeadsFound: missingFound,
    missingLeadsRecovered: missingRecovered,
    unenqueuedEventsRetried: retried,
    unenqueuedMetaLeadEventsRetried: metaLeadEventsRetried,
    unenqueuedWhatsappMessageEventsRetried: whatsappMessageEventsRetried,
    tenantPipelineFormsScanned,
    tenantPipelineLeadsSeen,
    tenantPipelineMissingLeadsFound: tenantPipelineMissingFound,
    tenantPipelineMissingLeadsRecovered: tenantPipelineMissingRecovered,
    tokensChecked: tokenRefreshResult.checked,
    tokensRefreshed: tokenRefreshResult.refreshed,
    tokensRefreshFailed: tokenRefreshResult.failed,
    errors,
  };
}
