// Server-side field validation for form submissions - the authoritative
// check. The client (public/assets/formRenderer.js) runs an equivalent set
// of checks for instant feedback, but per the "never trust frontend alone"
// requirement, EVERY submission (internal or public) is re-validated here
// before a Lead is ever written. No framework/vendor imports - pure domain
// logic, consistent with src/domain/types.ts.

// Deliberately typed with plain `string` (not the FormFieldType/mapping
// unions from industryTemplates.ts) so this same interface accepts both a
// freshly-validated field definition AND a row read straight back out of
// the form_fields table (whose columns are untyped text at the DB layer) -
// callers on both sides already runtime-checked these values earlier
// (see api/forms/handler.ts's validateFieldDefs / the schema itself).
export interface ValidatableField {
  key: string;
  label: string;
  fieldType: string;
  mappingType: string;
  systemField?: string | null;
  options?: string[] | null;
  required: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose on purpose - international phone formats vary widely; this only
// rejects obvious junk (letters, too short), never a legitimate number.
const PHONE_RE = /^[0-9+\-\s().]{6,20}$/;
const MAX_TEXT_LENGTH = 5000;

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Validates a raw submitted values object (keyed by field.key) against a
 * form's field list. Returns per-field error messages; an empty object
 * means the submission is valid. `skipStaticOptionsCheck` fields (system
 * fields whose real choices are resolved at write-time - source/owner/
 * pipelineStage/crmCampaignId) are checked for required-ness only here; the
 * caller (api/forms/handler.ts) separately verifies those values are real,
 * company-scoped choices before writing the Lead.
 */
export function validateSubmissionValues(
  fields: ValidatableField[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};

  for (const field of fields) {
    const raw = values[field.key];
    const empty = isEmpty(raw);

    if (field.required && empty && field.fieldType !== "checkbox") {
      errors[field.key] = `${field.label} is required.`;
      continue;
    }
    if (empty) continue; // optional + not provided - nothing further to check

    switch (field.fieldType) {
      case "email": {
        if (typeof raw !== "string" || !EMAIL_RE.test(raw.trim())) {
          errors[field.key] = `${field.label} must be a valid email address.`;
        }
        break;
      }
      case "phone": {
        if (typeof raw !== "string" || !PHONE_RE.test(raw.trim())) {
          errors[field.key] = `${field.label} must be a valid phone number.`;
        }
        break;
      }
      case "number":
      case "currency": {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          errors[field.key] = `${field.label} must be a number.`;
        } else if (n < 0) {
          errors[field.key] = `${field.label} cannot be negative.`;
        }
        break;
      }
      case "date":
      case "datetime": {
        const d = new Date(String(raw));
        if (Number.isNaN(d.getTime())) {
          errors[field.key] = `${field.label} must be a valid date.`;
        }
        break;
      }
      case "select":
      case "radio": {
        // Only enforce the static option list for CUSTOM fields - system
        // fields with dynamic choices (source/owner/stage/campaign) are
        // checked against live company data by the caller instead.
        if (field.mappingType === "custom" && field.options && field.options.length > 0) {
          if (!field.options.includes(String(raw))) {
            errors[field.key] = `${field.label} must be one of the offered choices.`;
          }
        }
        break;
      }
      case "multiselect": {
        const arr = Array.isArray(raw) ? raw : [raw];
        if (field.mappingType === "custom" && field.options && field.options.length > 0) {
          const invalid = arr.filter((v) => !field.options!.includes(String(v)));
          if (invalid.length > 0) {
            errors[field.key] = `${field.label} contains an invalid choice.`;
          }
        }
        break;
      }
      case "text":
      case "textarea":
      default: {
        if (typeof raw === "string" && raw.length > MAX_TEXT_LENGTH) {
          errors[field.key] = `${field.label} is too long.`;
        }
        break;
      }
    }
  }

  return errors;
}
