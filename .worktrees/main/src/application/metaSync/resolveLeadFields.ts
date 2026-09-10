// Phase 10 - THE dynamic field resolver. Replaces processLead.ts's old
// extractContactFields (a hard-coded switch on full_name/name/email/
// phone_number/phone that silently dropped every other field) with a
// lookup against the tenant's own persisted Meta Field -> CRM Field
// mapping (meta_form_field_mappings - see that table's schema.ts doc
// comment). Used by BOTH ingestion pipelines - the legacy per-campaign one
// (processLead.ts) and the tenant-level automatic one
// (processMetaLeadEvent.ts) - and by reconciliation (reconcile.ts) - so
// there is exactly one place that ever interprets a Meta field_data entry.
//
// Every field on the incoming lead ends up somewhere: a known system
// column (fullName/phoneNumber/email) or leads.customFields, keyed by
// whatever the mapping (or, absent one, the built-in suggestion
// dictionary) says. Nothing is ever silently discarded.
//
// Phase 12 - also resolves the form's own display NAME (leads.form_name),
// the one piece of "populate the CRM Lead" the ingestion pipelines never
// filled in: Meta's leadgen Graph API returns a form's id on the lead
// object, never its name, so this is the one field here that does NOT
// come from fieldData at all - it comes from the same synced meta_forms
// row the mappings themselves are looked up against (see
// getFieldMappingsByMetaFormId's own comment). Left undefined, same as
// every other optional field here, when the form was never synced.

import { getFieldMappingsByMetaFormId } from "../../infrastructure/db/repositories/metaFormMappings";
import { suggestMetaFieldMapping } from "../../domain/metaFieldDefaults";

export interface MetaFieldDataLike {
  name: string;
  values: string[];
}

export interface ResolvedMetaLeadFields {
  fullName?: string;
  email?: string;
  phoneNumber?: string;
  formName?: string;
  customFields: Record<string, unknown>;
}

/**
 * Resolves one lead's raw Meta field_data into system fields + customFields
 * (plus the form's own display name, see the header comment), using
 * tenantId's persisted mapping for `formId` when one exists (the normal
 * case for any form that's gone through a sync - see metaFormService.ts)
 * and falling back, PER FIELD, to suggestMetaFieldMapping's built-in
 * dictionary when no mapping row exists at all (formId was never synced,
 * or this specific question is newer than the last sync). formId being
 * undefined (Meta's response omitting it, which the domain types already
 * model as optional) simply means every field falls through to the
 * dictionary fallback, and formName is left undefined.
 */
export async function resolveLeadFields(tenantId: string, formId: string | undefined, fieldData: MetaFieldDataLike[]): Promise<ResolvedMetaLeadFields> {
  const { formName, mappings } = formId ? await getFieldMappingsByMetaFormId(tenantId, formId) : { formName: null, mappings: [] };
  const mappingByKey = new Map(mappings.map((m) => [m.metaFieldKey, m]));

  const result: ResolvedMetaLeadFields = { customFields: {}, formName: formName ?? undefined };

  for (const field of fieldData) {
    const value = field.values?.[0];
    if (value === undefined || value === "") continue;

    const key = field.name.trim().toLowerCase();
    const mapping = mappingByKey.get(key);

    if (mapping) {
      if (mapping.mappingType === "system") {
        if (mapping.systemField === "fullName") result.fullName = value;
        else if (mapping.systemField === "phoneNumber") result.phoneNumber = value;
        else if (mapping.systemField === "email") result.email = value;
        // Any other systemField value would be a data bug (the save path
        // only ever writes these three) - silently ignored rather than
        // thrown, consistent with resolveSubmission's own `default: break`
        // for an unrecognized systemField in api/forms/handler.ts.
      } else if (mapping.customFieldKey) {
        result.customFields[mapping.customFieldKey] = value;
      }
      continue;
    }

    // No persisted mapping for this exact field - fall back to the
    // built-in dictionary so the lead is still captured correctly rather
    // than landing entirely in customFields under Meta's raw key.
    const suggestion = suggestMetaFieldMapping(key);
    if (suggestion.mappingType === "system") {
      if (suggestion.systemField === "fullName") result.fullName = value;
      else if (suggestion.systemField === "phoneNumber") result.phoneNumber = value;
      else if (suggestion.systemField === "email") result.email = value;
    } else {
      result.customFields[suggestion.customFieldKey] = value;
    }
  }

  return result;
}
