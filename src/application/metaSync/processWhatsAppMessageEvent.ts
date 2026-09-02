// WhatsApp Lead Capture feature - Phase 8 (WhatsApp Contact -> Lead) +
// Phase 9 (Campaign Attribution). The WhatsApp counterpart to
// processMetaLeadEvent.ts - "go process this inbound WhatsApp message" for
// an event captured by metaWhatsappEventService.ts's captureWhatsappEvents.
// Executed by api/internal/handler.ts's process-lead action when the QStash
// message carries `kind: "whatsapp_message_received"` (see
// src/infrastructure/queue/qstash.ts's publishWhatsappMessageReceived).
//
// Unlike processMetaLeadEvent.ts, this pipeline makes NO Meta Graph API
// call at all: every field a WhatsApp lead needs (sender, contact name,
// first message, and - when present - the Click-to-WhatsApp referral) was
// already delivered inline in the webhook payload and durably stored on the
// whatsapp_message_events row by the capture step. There is no equivalent
// of Instant Form's "fetch full lead details" round trip to make.
//
// Attribution (Phase 9): when the stored event carries a referral object
// (messages[].referral - present only for a message that started from
// clicking a Click-to-WhatsApp ad, per Meta's own documented shape),
// referral.source_id is the AD'S OWN Meta id. That id is looked up against
// meta_lead_routes (via getMetaLeadRouteByMetaAdId, keyed on Meta's ad id -
// already populated by metaCampaignService.ts's per-ad resolution, Phase
// 3/4) to recover the ad/ad-set/campaign/CRM-campaign chain, EXACTLY the
// same "resolved once at sync time, never re-derived from the Graph API on
// every event" posture Phase 4 already established. No referral, or a
// referral whose source_id does not match anything this tenant has synced
// yet -> every attribution field stays null, which the CRM's existing
// "Unknown / Organic WhatsApp" convention (leadApproachLabel + the Leads
// UI's own fallback rendering) already renders correctly - NEVER guessed
// from the message text, the contact name, or anything else.
//
// Idempotency: same two-layer defense as processMetaLeadEvent.ts - a Redis
// fast-path claim (a miss just means "check Postgres", never proof of
// non-existence) plus the authoritative unique index on leads.metaLeadId
// (via insertWhatsappLead's `whatsapp:<waMessageId>` key), so a QStash
// redelivery, a manual retry, or a race with another invocation can never
// create a second lead for the same WhatsApp message.

import { releaseLeadIdClaim, tryClaimLeadId } from "../../infrastructure/cache/redis";
import { leadExistsByMetaLeadId, logEvent } from "../../infrastructure/db/repositories";
import {
  getMetaLeadRouteByMetaAdId,
  getWhatsappMessageEventById,
  insertWhatsappLead,
  markWhatsappMessageEventCompleted,
  markWhatsappMessageEventDuplicate,
  markWhatsappMessageEventProcessing,
  markWhatsappMessageEventRetrying,
} from "../../infrastructure/db/repositories/whatsapp";
import { RetryableProcessingError } from "../processLead";

export type ProcessWhatsAppMessageEventOutcome = "processed" | "duplicate";

interface WhatsappReferral {
  source_id?: string; // the Click-to-WhatsApp ad's OWN Meta id
  source_type?: string; // "ad" | "post" - documented by Meta, never invented
}

/** Resolves the lead's own idempotency key the same way insertWhatsappLead
 * builds it, so the Redis claim and leadExistsByMetaLeadId check both agree
 * with what the eventual insert will actually use. */
function leadIdempotencyKey(waMessageId: string): string {
  return `whatsapp:${waMessageId}`;
}

export async function processWhatsAppMessageEvent(
  messageEventId: string,
  waMessageId: string,
  tenantId: string,
): Promise<ProcessWhatsAppMessageEventOutcome> {
  const metaLeadId = leadIdempotencyKey(waMessageId);

  // Fast-path dedupe via Redis - a miss just means "check Postgres", never
  // treated as proof of non-existence (same contract as processLead.ts /
  // processMetaLeadEvent.ts).
  const claimed = await tryClaimLeadId(metaLeadId);
  if (!claimed) {
    await markWhatsappMessageEventDuplicate(messageEventId);
    return "duplicate";
  }

  if (await leadExistsByMetaLeadId(metaLeadId)) {
    await markWhatsappMessageEventDuplicate(messageEventId);
    return "duplicate";
  }

  const event = await getWhatsappMessageEventById(messageEventId);
  if (!event || event.tenantId !== tenantId) {
    // Tenant isolation - scoped the same defensive way
    // processMetaLeadEvent.ts's getMetaLeadEventById already is: the row
    // should always already agree with the QStash message's own tenantId
    // (both set together by captureWhatsappEvents), but a future bug that
    // ever let them diverge fails closed here instead of silently
    // processing the wrong tenant's message.
    await releaseLeadIdClaim(metaLeadId);
    throw new Error(`whatsapp_message_events row ${messageEventId} not found for tenant ${tenantId}`);
  }

  if (!event.fromPhoneNumber) {
    // Should not happen - captureWhatsappEvents only ever records an event
    // when message.from is present. Not retryable: there is no missing
    // dependency a retry would resolve, the stored row itself is
    // incomplete.
    await releaseLeadIdClaim(metaLeadId);
    await markWhatsappMessageEventRetrying(messageEventId, "Stored event has no fromPhoneNumber - cannot create a lead.");
    throw new Error(`whatsapp_message_events ${messageEventId} has no fromPhoneNumber`);
  }

  // Phase 14 - flip "enqueued" -> "processing" before doing any further
  // work, same visibility contract as the Instant Form pipeline's
  // markMetaLeadEventProcessing.
  await markWhatsappMessageEventProcessing(messageEventId);

  try {
    // Phase 9 - Campaign Attribution. Only ever attempted from a REAL,
    // Meta-delivered referral.source_id - never guessed from the message
    // text, contact name, or anything else. A referral with no
    // matching route (ad not yet synced, or genuinely organic) leaves every
    // attribution field null, which the CRM already renders as
    // "Unknown / Organic WhatsApp" (src/domain/leadApproach.ts).
    const referral = (event.referral as WhatsappReferral | null) ?? null;
    let adId: string | null = null;
    let adName: string | null = null;
    let adSetId: string | null = null;
    let adSetName: string | null = null;
    let campaignId: string | null = null;
    let campaignName: string | null = null;
    let crmCampaignId: string | null = null;
    let branchId: string | null = null;

    if (referral?.source_id) {
      // getMetaLeadRouteByMetaAdId already joins all the way out to the ad
      // set, Meta campaign, and (if mapped) CRM campaign/branch in one
      // query - no further lookups needed here.
      const route = await getMetaLeadRouteByMetaAdId(tenantId, referral.source_id);
      if (route) {
        adId = route.adId;
        adName = route.adName;
        adSetId = route.adSetId ?? null;
        adSetName = route.adSetName ?? null;
        campaignId = route.campaignId ?? null;
        campaignName = route.campaignName ?? null;
        crmCampaignId = route.crmCampaignId ?? null;
        branchId = route.crmCampaignBranchId ?? null;
      }
      // No matching route (this ad hasn't been synced by
      // metaCampaignService.ts yet, or the referral names an ad this tenant
      // does not own) - every field above simply stays null. Never guessed.
    }

    const result = await insertWhatsappLead({
      tenantId,
      waMessageId,
      fromPhoneNumber: event.fromPhoneNumber,
      contactName: event.contactName,
      messageText: event.messageText,
      adId,
      adName,
      adSetId,
      adSetName,
      campaignId,
      campaignName,
      crmCampaignId,
      branchId,
    });

    if (result.outcome === "duplicate") {
      // Lost a race with another invocation - not an error.
      await markWhatsappMessageEventDuplicate(messageEventId);
      await logEvent({ eventType: "Duplicate", detail: `Race-condition duplicate (WhatsApp): ${waMessageId}` });
      return "duplicate";
    }

    await markWhatsappMessageEventCompleted(messageEventId);
    await logEvent({ leadId: result.id, eventType: "Processed", detail: "Automatic WhatsApp lead capture" });
    return "processed";
  } catch (err) {
    // Phase 13 - release the Redis claim on ANY failure past this point, so
    // a legitimate retry can re-claim rather than being silently marked a
    // duplicate with no lead ever created (same reasoning
    // processMetaLeadEvent.ts documents for its own try/catch).
    await releaseLeadIdClaim(metaLeadId);
    const message = err instanceof Error ? err.message : String(err);
    await markWhatsappMessageEventRetrying(messageEventId, `Failed to create lead: ${message}`);
    throw new RetryableProcessingError(`Failed to create lead for WhatsApp message ${waMessageId}: ${message}`);
  }
}
