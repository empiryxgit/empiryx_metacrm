// Executed by api/internal/process-lead.ts, the QStash-triggered "worker".
// Idempotent by design: safe to run twice for the same Meta Lead ID, whether
// that's an at-least-once QStash redelivery, a manual retry, or a
// reconciliation recovery landing on the same lead concurrently.

import { getLeadDetails, MetaApiError } from "../infrastructure/meta/graphClient";
import { releaseLeadIdClaim, tryClaimLeadId } from "../infrastructure/cache/redis";
import { insertLead, leadExistsByMetaLeadId, logEvent } from "../infrastructure/db/repositories";
import { getWebhookConfigByCampaignIdInternal } from "../infrastructure/db/repositories/campaigns";
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

  const webhookConfig = await getWebhookConfigByCampaignIdInternal(crmCampaignId);
  if (!webhookConfig) {
    // The campaign's webhook config was deleted/changed after this message was queued.
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

  const contact = extractContactFields(details);

  const result = await insertLead({
    companyId,
    crmCampaignId,
    metaLeadId: details.id,
    platform: objectType.includes("instagram") ? LeadPlatform.Instagram : LeadPlatform.Facebook,
    pageId: details.pageId ?? "",
    formId: details.formId,
    adId: details.adId,
    adName: details.adName,
    adSetId: details.adSetId,
    adSetName: details.adSetName,
    campaignId: details.campaignId,
    campaignName: details.campaignName,
    fullName: contact.fullName,
    email: contact.email,
    phoneNumber: contact.phoneNumber,
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
}

function extractContactFields(details: MetaLeadDetails) {
  const contact: { fullName?: string; email?: string; phoneNumber?: string } = {};
  for (const field of details.fieldData) {
    const value = field.values[0];
    switch (field.name.toLowerCase()) {
      case "full_name":
      case "name":
        contact.fullName = value;
        break;
      case "email":
        contact.email = value;
        break;
      case "phone_number":
      case "phone":
        contact.phoneNumber = value;
        break;
    }
  }
  return contact;
}
