// The tenant-level counterpart to src/application/processLead.ts - "go
// process this lead" for a lead captured via the AUTOMATIC per-Page
// webhook receiver (see metaLeadEventService.ts's captureLeadgenEvents +
// api/webhooks/meta/handler.ts's leadgen resource), instead of the
// legacy per-campaign one. Executed by api/internal/handler.ts's
// process-lead action when the QStash message carries
// `kind: "tenant_meta_sync"` (see src/infrastructure/queue/qstash.ts's
// publishTenantLeadReceived).
//
// Same idempotency posture as processLead.ts: safe to run twice for the
// same Meta Lead ID (Redis fast-path claim, then the authoritative unique
// index on leads.meta_lead_id), whether that's a QStash redelivery, a
// manual retry, or (eventually) a reconciliation recovery landing on the
// same lead concurrently.
//
// The one genuine difference from the legacy pipeline: there is no
// per-campaign webhook config to read an access token from. This pipeline
// uses the SELECTED Page's own page-scoped access token (see
// getMetaPageInternalByPageId - the same token Phase 5/6's sync already
// uses for Forms), and resolves which CRM campaign (and therefore branch)
// the lead belongs to from the lead's OWN Meta campaign id, matched
// against whatever Phase 6's sync has already brought in
// (getMetaCampaignByMetaCampaignId). If that Meta campaign hasn't been
// synced yet, OR has been synced but not yet mapped to a CRM campaign
// (Phase 9: mapping is a separate, explicit user action - see
// mapMetaCampaignToCrmCampaign), the lead is still captured - just left
// unmapped (crmCampaignId/branchId both null) rather than dropped or
// retried forever over something a resync/mapping will fix on its own.

import { getLeadDetails, MetaApiError } from "../../infrastructure/meta/graphClient";
import { releaseLeadIdClaim, tryClaimLeadId } from "../../infrastructure/cache/redis";
import { leadExistsByMetaLeadId, logEvent } from "../../infrastructure/db/repositories";
import {
  getMetaLeadEventById,
  insertMetaSyncLead,
  markMetaLeadEventCompleted,
  markMetaLeadEventDuplicate,
  markMetaLeadEventProcessing,
  markMetaLeadEventRetrying,
} from "../../infrastructure/db/repositories/metaLeadEvents";
import { getMetaPageInternalByPageId } from "../../infrastructure/db/repositories/metaIntegration";
import { getMetaCampaignByMetaCampaignId } from "../../infrastructure/db/repositories/metaSync";
import { resolveLeadFields } from "./resolveLeadFields";
import { RetryableProcessingError } from "../processLead";
import { LeadPlatform } from "../../domain/types";
import { flagConnectionIfAuthError } from "./metaConnectionService";

export type ProcessMetaLeadEventOutcome = "processed" | "duplicate";

export async function processMetaLeadEvent(
  leadEventId: string,
  metaLeadId: string,
  tenantId: string,
): Promise<ProcessMetaLeadEventOutcome> {
  // Fast-path dedupe via Redis - a miss just means "check Postgres", never
  // treated as proof of non-existence (same contract as processLead.ts).
  const claimed = await tryClaimLeadId(metaLeadId);
  if (!claimed) {
    await markMetaLeadEventDuplicate(leadEventId);
    return "duplicate";
  }

  if (await leadExistsByMetaLeadId(metaLeadId)) {
    await markMetaLeadEventDuplicate(leadEventId);
    return "duplicate";
  }

  const event = await getMetaLeadEventById(tenantId, leadEventId);
  if (!event) {
    // Should not happen - the row was just inserted by the same request
    // that published this message. Not retryable: there is nothing to
    // reprocess if the durability record itself is gone.
    await releaseLeadIdClaim(metaLeadId);
    throw new Error(`meta_lead_events row ${leadEventId} not found`);
  }

  if (!event.pageId) {
    await releaseLeadIdClaim(metaLeadId);
    // This attempt failed, but QStash still has retries left (see
    // publishTenantLeadReceived's `retries: 5`) - RETRYING, not the
    // terminal FAILED, which is reserved for the dead-letter callback once
    // every attempt is exhausted.
    await markMetaLeadEventRetrying(leadEventId, "Event has no pageId - cannot resolve a Page access token.");
    throw new Error(`meta_lead_events ${leadEventId} has no pageId`);
  }

  const page = await getMetaPageInternalByPageId(tenantId, event.pageId);
  if (!page) {
    // The Page was unselected/disconnected between the webhook arriving
    // and this message being processed. Still recorded as RETRYING (not
    // terminal) - the same reasoning as the legacy pipeline's "webhook
    // config deleted" case: a later retry might land after the Page is
    // reconnected, and only the dead-letter callback should mark this
    // event's terminal FAILED state once retries are actually exhausted.
    await releaseLeadIdClaim(metaLeadId);
    const message = `No connected Page found for tenant ${tenantId} / page ${event.pageId}`;
    await markMetaLeadEventRetrying(leadEventId, message);
    throw new Error(message);
  }

  // Phase 14 - the Background Worker's real work starts here: flip
  // "enqueued" -> "processing" before the first Meta API call, so a stuck
  // "processing" row visibly means a worker started but never finished
  // (see markMetaLeadEventProcessing's own comment).
  await markMetaLeadEventProcessing(leadEventId);

  let details;
  try {
    details = await getLeadDetails(metaLeadId, page.pageAccessToken);
  } catch (err) {
    await releaseLeadIdClaim(metaLeadId); // allow a legitimate retry to re-claim
    // Phase 16 - "Meta API authentication failure": if this particular
    // failure was classified as an auth problem (expired token, revoked
    // authorization, missing permission, or page access removed), flag the
    // tenant's connection right now rather than letting every subsequent
    // lead for this tenant retry-and-fail silently until QStash eventually
    // dead-letters each one with no clear explanation. A no-op for any
    // other kind of failure (network blip, Meta 5xx) - see
    // flagConnectionIfAuthError's own comment.
    await flagConnectionIfAuthError(tenantId, err, "Lead ingestion (getLeadDetails)");
    const message = err instanceof MetaApiError ? err.message : String(err);
    await markMetaLeadEventRetrying(leadEventId, `Failed to fetch lead details: ${message}`);
    throw new RetryableProcessingError(`Failed to fetch lead details for ${metaLeadId}: ${message}`);
  }

  // Phase 13: everything from here through the insert is wrapped so a
  // failure ANYWHERE in it - a DB blip resolving fields/campaign, a
  // Postgres outage on the insert itself, anything unexpected - always
  // releases the Redis claim before propagating. Without this, a failure
  // here (as opposed to the getLeadDetails failure just above, which
  // already releases on its own) would leave the claim stuck for its full
  // TTL: every retry landing before then would see "already claimed" and
  // get silently marked a duplicate WITHOUT the lead ever having been
  // created - exactly the silent discard Phase 13 rules out. A raw
  // application/DB error is treated the same as a Graph API failure:
  // wrapped as RetryableProcessingError so QStash's own retry (and
  // eventually its dead-letter callback) still gets a chance to recover
  // it - "never silently discard an event" applies here just as much as
  // to the Meta-facing failure above.
  try {
    // Phase 10: resolves every field on this lead (system + custom)
    // against the tenant's own persisted Meta Field -> CRM Field mapping -
    // see resolveLeadFields's own comment for the fallback behavior when
    // this form was never synced.
    const contact = await resolveLeadFields(tenantId, details.formId, details.fieldData);

    // Resolve which CRM campaign (and therefore branch) this lead belongs
    // to from the lead's OWN Meta campaign id - see this module's header
    // comment for why an unsynced or unmapped campaign is
    // captured-but-unmapped rather than a failure. Phase 9: the lead's
    // crmCampaignId comes from the Meta campaign's MAPPING
    // (metaCampaign.crmCampaignId), never from the metaCampaigns row's own
    // id - a synced-but-unmapped Meta campaign still captures the lead,
    // just with crmCampaignId left null.
    const metaCampaign = details.campaignId ? await getMetaCampaignByMetaCampaignId(tenantId, details.campaignId) : null;

    const result = await insertMetaSyncLead({
      companyId: tenantId,
      branchId: metaCampaign?.crmCampaignBranchId ?? null,
      crmCampaignId: metaCampaign?.crmCampaignId ?? null,
      metaLeadId: details.id,
      // Meta's leadgen webhook envelope's top-level `object` is always
      // "page" for both Facebook and Instagram lead ads placements - there
      // is no reliable per-lead signal to distinguish them here, so this
      // defaults to Facebook, same effective behavior the legacy pipeline
      // falls back to for anything not literally containing "instagram".
      platform: LeadPlatform.Facebook,
      pageId: details.pageId ?? event.pageId,
      formId: details.formId,
      formName: contact.formName,
      adId: details.adId,
      adName: details.adName,
      adSetId: details.adSetId,
      adSetName: details.adSetName,
      campaignId: details.campaignId,
      campaignName: details.campaignName,
      fullName: contact.fullName,
      email: contact.email,
      phoneNumber: contact.phoneNumber,
      customFields: contact.customFields,
      formResponses: details.fieldData,
      metaCreatedAt: new Date(details.createdTime),
    });

    if (result.outcome === "duplicate") {
      // Lost a race with another invocation - not an error.
      await markMetaLeadEventDuplicate(leadEventId);
      await logEvent({ eventType: "Duplicate", detail: `Race-condition duplicate (tenant sync): ${metaLeadId}` });
      return "duplicate";
    }

    await markMetaLeadEventCompleted(leadEventId);
    await logEvent({ leadId: result.id, eventType: "Processed", detail: "Automatic tenant-level Meta sync" });
    return "processed";
  } catch (err) {
    await releaseLeadIdClaim(metaLeadId);
    const message = err instanceof Error ? err.message : String(err);
    await markMetaLeadEventRetrying(leadEventId, `Failed to create lead: ${message}`);
    throw new RetryableProcessingError(`Failed to create lead for ${metaLeadId}: ${message}`);
  }
}
