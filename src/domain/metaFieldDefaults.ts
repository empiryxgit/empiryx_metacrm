// Phase 10 - a small dictionary of WELL-KNOWN Meta lead-form field keys,
// used ONLY in two places, both non-authoritative:
//   1. ensureDefaultFieldMappings (src/infrastructure/db/repositories/
//      metaFormMappings.ts) - to pre-fill a sensible starting suggestion
//      the first time a question is synced, which an administrator can
//      freely override on the Field Mapping screen.
//   2. resolveLeadFields (src/application/metaSync/resolveLeadFields.ts) -
//      as a last-resort fallback ONLY when a field arrives on a lead that
//      has no persisted mapping row at all yet (e.g. ingestion outran a
//      sync, or the legacy per-campaign pipeline never synced this form's
//      questions in the first place).
//
// This is deliberately NOT how ingestion normally resolves fields -
// resolveLeadFields always prefers the tenant's own persisted
// meta_form_field_mappings row when one exists. Every Meta form can ask
// different questions (Form A: Name/Phone/Email/Budget/Location vs Form
// B: Name/Phone/Property Type/Possession Date/Budget, per the Phase 10
// spec's own example) - this dictionary only recognizes the handful of
// keys common across most real-estate/solar lead forms; anything else
// falls through to an auto-generated custom field (see suggestMapping's
// own fallback below), never dropped.

export type MetaFieldSuggestion =
  | { mappingType: "system"; systemField: "fullName" | "phoneNumber" | "email" }
  | { mappingType: "custom"; customFieldKey: string; customFieldLabel: string };

// Keys are matched case-insensitively against Meta's own field key (the
// same value that shows up as field_data[].name on an incoming lead - see
// graphClient.getLeadDetails). Mirrors the Phase 10 spec's own example
// table exactly (full_name/phone_number/email/budget/location/
// property_type), plus a couple of other very common real-estate/solar
// lead-form keys.
const KNOWN_META_FIELD_SUGGESTIONS: Record<string, MetaFieldSuggestion> = {
  full_name: { mappingType: "system", systemField: "fullName" },
  name: { mappingType: "system", systemField: "fullName" },
  first_name: { mappingType: "system", systemField: "fullName" },
  phone_number: { mappingType: "system", systemField: "phoneNumber" },
  phone: { mappingType: "system", systemField: "phoneNumber" },
  email: { mappingType: "system", systemField: "email" },
  budget: { mappingType: "custom", customFieldKey: "budget", customFieldLabel: "Budget" },
  location: { mappingType: "custom", customFieldKey: "location", customFieldLabel: "Location" },
  preferred_location: { mappingType: "custom", customFieldKey: "location", customFieldLabel: "Location" },
  property_type: { mappingType: "custom", customFieldKey: "propertyType", customFieldLabel: "Property Type" },
  possession_date: { mappingType: "custom", customFieldKey: "possessionDate", customFieldLabel: "Possession Date" },
  system_capacity: { mappingType: "custom", customFieldKey: "systemCapacity", customFieldLabel: "System Capacity" },
  monthly_bill: { mappingType: "custom", customFieldKey: "monthlyBill", customFieldLabel: "Monthly Bill" },
};

/** camelCase-ish key derived from Meta's own field key (e.g.
 * "roof_type" -> "roofType"), used when auto-generating a custom-field key
 * for a question this dictionary doesn't recognize - keeps
 * auto-generated customFields keys consistent with every hand-authored
 * FieldDef.key in src/domain/industryTemplates.ts. */
export function keyFromMetaFieldKey(metaFieldKey: string): string {
  const parts = metaFieldKey
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .filter(Boolean);
  if (parts.length === 0) return "field";
  return parts[0] + parts.slice(1).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("");
}

/** Title Case label derived from Meta's own field key, used as a fallback
 * when Meta's own question label ("What's your budget?" - often a full
 * sentence, not a short label) isn't a good display name on its own; the
 * admin can always rename it on the Field Mapping screen regardless. */
export function labelFromMetaFieldKey(metaFieldKey: string): string {
  const parts = metaFieldKey.trim().split(/[^a-zA-Z0-9]+/).filter(Boolean);
  if (parts.length === 0) return metaFieldKey;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(" ");
}

/** The one function both call sites above actually use - looks up the
 * known dictionary by Meta's field key (case-insensitive), falling back
 * to an auto-generated custom field derived from the key itself. Always
 * returns something - a field this dictionary has never heard of is still
 * captured, just as an unmapped-looking custom field an administrator can
 * later repoint. */
export function suggestMetaFieldMapping(metaFieldKey: string): MetaFieldSuggestion {
  const known = KNOWN_META_FIELD_SUGGESTIONS[metaFieldKey.trim().toLowerCase()];
  if (known) return known;
  return {
    mappingType: "custom",
    customFieldKey: keyFromMetaFieldKey(metaFieldKey),
    customFieldLabel: labelFromMetaFieldKey(metaFieldKey),
  };
}
