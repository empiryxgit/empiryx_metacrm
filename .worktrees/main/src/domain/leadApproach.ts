// WhatsApp Lead Capture feature - Phase 1 (Generic Lead Approach model).
//
// `leads.source` (see industryTemplates.ts LEAD_SOURCES) already answers
// "where did this lead come from" (meta_lead_ads, whatsapp, website,
// referral, ...) and is left completely unchanged by this feature - every
// existing filter, report, and manual "Add Customer" dropdown built on it
// keeps working exactly as before (NON-NEGOTIABLE requirement: existing
// Meta Instant Form functionality must not regress).
//
// What was genuinely missing is a second, orthogonal axis: HOW a Meta-
// sourced lead was actually captured - through an Instant Form submission,
// or through a WhatsApp conversation started from a Click-to-WhatsApp ad.
// Both are "Meta" in the `source` sense; they are completely different
// capture mechanisms with different data shapes (form field_data vs. a
// free-text message), which is exactly the distinction this file's
// `leadApproach` catalog exists to make explicit, generically, so a future
// approach (Website, Messenger, Instagram, Phone) is just one more catalog
// entry - never a hard-coded if/else scattered through the app.
//
// `leads.leadApproach` (see schema.ts) is nullable and additive: every lead
// captured before this feature existed simply has leadApproach = null,
// which the UI treats identically to "Unknown" (see leadApproachLabel
// below) - no backfill migration silently reclassifies historical data.

export const LEAD_APPROACHES: Array<{ key: string; label: string }> = [
  // Existing Meta Lead Ads pipeline (leads.source = "meta_lead_ads") -
  // stamped going forward by processMetaLeadEvent.ts so a Meta Instant Form
  // lead is now unambiguous in the UI, not just inferred from `source`.
  { key: "meta_instant_form", label: "Instant Form" },
  // New in this feature - see processWhatsAppMessageEvent.ts.
  { key: "whatsapp", label: "WhatsApp" },
  // Not yet implemented by any ingestion pipeline - reserved catalog
  // entries so the UI/reporting layer never needs a schema change to add
  // one later (Phase 1's own "must be extensible" requirement).
  { key: "website", label: "Website" },
  { key: "messenger", label: "Messenger" },
  { key: "instagram", label: "Instagram" },
  { key: "phone", label: "Phone" },
  { key: "manual", label: "Manual" },
  // Explicit, honest "we looked and could not reliably tell" - see
  // metaLeadApproachResolver.ts. Never guessed into one of the above.
  { key: "unknown", label: "Unknown" },
];

export type LeadApproachKey = (typeof LEAD_APPROACHES)[number]["key"];

const LEAD_APPROACH_KEYS = new Set(LEAD_APPROACHES.map((a) => a.key));

export function isValidLeadApproach(value: string): boolean {
  return LEAD_APPROACH_KEYS.has(value);
}

/** Null (every lead captured before this feature existed, or a resolver
 * that never ran) reads exactly the same as the explicit "unknown" key -
 * one label, so the UI never has to special-case "no value yet" versus
 * "we determined it and it was UNKNOWN". */
export function leadApproachLabel(key: string | null | undefined): string {
  if (!key) return "Unknown";
  const found = LEAD_APPROACHES.find((a) => a.key === key);
  return found ? found.label : "Unknown";
}

// ---------------------------------------------------------------------------
// Automatic Lead Approach Detection (Phase 3) - confidence vocabulary.
// ---------------------------------------------------------------------------

/**
 * DETERMINED - resolved from real, documented Meta configuration data (an
 * ad's linked lead_gen_form_id, or an ad set's destination_type) - never
 * from a campaign/ad NAME (explicitly forbidden - see
 * metaLeadApproachResolver.ts's own tests).
 * UNDETERMINED - the available Meta data did not reliably indicate an
 * approach; resolver returns UNKNOWN with a logged reason rather than
 * guessing.
 */
export const LEAD_APPROACH_CONFIDENCE = ["DETERMINED", "UNDETERMINED"] as const;
export type LeadApproachConfidence = (typeof LEAD_APPROACH_CONFIDENCE)[number];
