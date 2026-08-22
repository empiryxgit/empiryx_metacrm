// Executed by api/internal/process-lead.ts, the QStash-triggered "worker".
// Idempotent by design: safe to run twice for the same Meta Lead ID, whether
// that's an at-least-once QStash redelivery, a manual retry, or a
// reconciliation recovery landing on the same lead concurrently.

import { getLeadDetails, MetaApiError } from "../infrastructure/meta/graphClient";
import { releaseLeadIdClaim, tryClaimLeadId } from "../infrastructure/cache/redis";
import { insertLead, leadExistsByMetaLeadId, logEvent } from "../infrastructure/db/repositories";
import { getCampaign, getWebhookConfigByCampaignIdInternal } from "../infrastructure/db/repositories/campaigns";
import { resolveLeadFields } from "./metaSync/resolveLeadFields";
import { LeadPlatform } from "../domain/types";
import type { MetaLeadDetails } from "../domain/types";

export type ProcessLeadOutcome = "processed" | "duplicate";

export class RetryableProcessingError extends Error {}

export async function processLead(
  rawEventId: string,
  metaLeadId: string,
  objectType: string,
  companyId: string,
  crmCampaignId: string,
): Promise<ProcessLeadOutcome> {
  // Fast-path dedupe via Redis. A miss just means "check Postgres" - never
  // treated as proof of non-existence.
  const claimed = await tryClaimLeadId(metaLeadId);
  if (!claimed) {
    await logEvent({ rawEventId, eventType: "Duplicate", detail: `Redis fast-path rejected ${metaLeadId}` });
    return "duplicate";
  }

  // Authoritative check against Postgres.
  if (await leadExistsByMetaLeadId(metaLeadId)) {
    await logEvent({ rawEventId, eventType: "Duplicate", detail: `Already present in CRM: ${metaLeadId}` });
    return "duplicate";
  }

  // Phase 19 (tenant isolation audit) - scoped by companyId as well as
  // crmCampaignId, so a webhook config belonging to a DIFFERENT tenant can
  // never be returned here even if companyId/crmCampaignId ever diverged
  // (e.g. a future bug reusing this queue message shape) - see
  // getWebhookConfigByCampaignIdInternal's own comment.
  const webhookConfig = await getWebhookConfigByCampaignIdInternal(companyId, crmCampaignId);
  if (!webhookConfig) {
    // The campaign's webhook config was deleted/changed after this message was queued
    // (or, per the tenant check above, never belonged to this tenant to begin with).
    // Not retryable - there is no access token to fetch the lead with.
    await releaseLeadIdClaim(metaLeadId);
    throw new Error(`No webhook configuration found for campaign ${crmCampaignId}`);
  }

  let details: MetaLeadDetails;
  try {
    details = await getLeadDetails(metaLeadId, webhookConfig.accessToken);
  } catch (err) {
    await releaseLeadIdClaim(metaLeadId); // allow a legitimate retry to re-claim
    const message = err instanceof MetaApiError ? err.message : String(err);
    throw new RetryableProcessingError(`Failed to fetch lead details for ${metaLeadId}: ${message}`);
  }

  // Phase 13: everything from here through the insert is wrapped so a
  // failure ANYWHERE in it - a DB blip resolving fields/campaign, a
  // Postgres outage on the insert itself, anything unexpected - always
  // releases the Redis claim before propagating. Without this, a failure
  // here (as opposed to the getLeadDetails failure just above, which
  // already releases on its own) would leave the claim stuck for its full
  // TTL: every retry landing before then would see "already claimed" and
  // silently short-circuit to "duplicate" WITHOUT the lead ever having
  // been created - exactly the silent discard Phase 13 rules out.
  try {
    // Phase 10: resolves every field on this lead (system + custom)
    // against the tenant's own persisted Meta Field -> CRM Field mapping -
    // see resolveLeadFields's own comment for the fallback behavior when
    // this form was never synced.
    const contact = await resolveLeadFields(companyId, details.formId, details.fieldData);

    // Meta ingestion never receives a branchId directly (the webhook only
    // knows the campaign) - it's resolved here from the campaign's own
    // branchId, so a lead raised by a branch-owned campaign lands in that
    // branch automatically, with zero change needed to the webhook
    // handler or the QStash message shape.
    const campaign = await getCampaign(companyId, crmCampaignId);

    const result = await insertLead({
      companyId,
      branchId: campaign?.branchId ?? null,
      crmCampaignId,
      metaLeadId: details.id,
      platform: objectType.includes("instagram") ? LeadPlatform.Instagram : LeadPlatform.Facebook,
      pageId: details.pageId ?? "",
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
      rawEventId,
    });

    if (result.outcome === "duplicate") {
      // Lost a race with another invocation - not an error.
      await logEvent({ rawEventId, eventType: "Duplicate", detail: `Race-condition duplicate: ${metaLeadId}` });
      return "duplicate";
    }

    await logEvent({ leadId: result.id, rawEventId, eventType: "Processed" });
    return "processed";
  } catch (err) {
    await releaseLeadIdClaim(metaLeadId);
    const message = err instanceof Error ? err.message : String(err);
    throw new RetryableProcessingError(`Failed to create lead for ${metaLeadId}: ${message}`);
  }
}
