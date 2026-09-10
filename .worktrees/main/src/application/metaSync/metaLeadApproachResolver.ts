// WhatsApp Lead Capture feature - Phase 3 (Automatic Lead Approach
// Detection). Determines whether ONE synced ad captures leads through a
// Meta Instant Form or a Click-to-WhatsApp destination, using ONLY real,
// documented Meta configuration data - never the ad/ad-set/campaign NAME.
//
// The two signals this resolver checks, and why both are needed:
//
//   1. The AD's own creative - does it link to a lead-gen form?
//      (creative.object_story_spec.link_data.call_to_action.value.lead_gen_form_id
//      - see graphClient.getAdCreativeLeadFormId). This is a per-AD fact:
//      two ads in the same ad set can each point at a different form.
//
//   2. The AD SET's destination_type - is it "WHATSAPP"? (Meta's own
//      Marketing API field, required and documented for Click-to-WhatsApp
//      ad sets - see graphClient.getCampaignAdSets). This is a per-AD-SET
//      fact: every ad within a Click-to-WhatsApp ad set shares it.
//
// Lead form linkage is checked FIRST and wins if present: an ad's own
// creative is the more specific, more authoritative signal Meta gives for
// "this exact ad submits to this exact form" - there's no known case where
// an ad has both a linked lead form AND a WhatsApp destination_type on its
// ad set (they're different campaign objectives), but if that ever did
// occur, trusting the ad-level fact over the ad-set-level fact is the safer
// choice.
//
// Anything else - no lead_gen_form_id, no "WHATSAPP" destination_type - is
// UNKNOWN, with `confidence: "UNDETERMINED"` and a human-readable reason in
// `metadata.reason`. Never guessed into either bucket.

import { getAdCreativeLeadFormId } from "../../infrastructure/meta/graphClient";
import type { LeadApproachConfidence } from "../../domain/leadApproach";

export interface ResolveLeadApproachInput {
  metaAdId: string; // Meta's OWN ad id (not our row id) - what the Graph API calls take
  adSetDestinationType: string | null; // from graphClient.MetaAdSetSummary.destinationType, for the ad's parent ad set
}

export interface ResolvedLeadApproach {
  approach: "meta_instant_form" | "whatsapp" | "unknown";
  confidence: LeadApproachConfidence;
  formId: string | null;
  reason: string | null; // populated only when confidence is UNDETERMINED
}

/**
 * Resolves ONE ad's lead approach. Makes at most one Graph API call (the
 * ad-set destination_type is passed in, already fetched once per ad set by
 * the caller - see metaCampaignService.ts - rather than re-fetched per ad).
 */
export async function resolveLeadApproachForAd(input: ResolveLeadApproachInput, userAccessToken: string): Promise<ResolvedLeadApproach> {
  // Signal 1: does this specific ad's creative link to an Instant Form?
  let leadGenFormId: string | null = null;
  try {
    leadGenFormId = await getAdCreativeLeadFormId(input.metaAdId, userAccessToken);
  } catch (err) {
    // "If a particular campaign/ad destination cannot reliably be
    // determined through the available API response, implement a safe
    // fallback rather than guessing" - a failed creative lookup (a
    // transient Graph error, or a permission gap on this specific ad)
    // falls through to checking destination_type instead of throwing and
    // aborting the whole campaign sync over one ad.
    console.warn(`[lead-approach-resolver] Failed to read creative for ad ${input.metaAdId}, falling back to destination_type only:`, err);
  }

  if (leadGenFormId) {
    return { approach: "meta_instant_form", confidence: "DETERMINED", formId: leadGenFormId, reason: null };
  }

  // Signal 2: is the parent ad set's destination_type exactly "WHATSAPP"?
  if (input.adSetDestinationType === "WHATSAPP") {
    return { approach: "whatsapp", confidence: "DETERMINED", formId: null, reason: null };
  }

  return {
    approach: "unknown",
    confidence: "UNDETERMINED",
    formId: null,
    reason: input.adSetDestinationType
      ? `Ad set destination_type is "${input.adSetDestinationType}", not a currently-supported lead approach, and this ad has no linked lead_gen_form_id.`
      : "No destination_type on the ad set and no linked lead_gen_form_id on this ad's creative.",
  };
}
