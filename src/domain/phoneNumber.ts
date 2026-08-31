// E.164 validation for any phone number this deployment actually dials out
// to on its own (currently: users.phoneNumber, the smart-follow-up
// WhatsApp/SMS nudge recipient - see api/admin/users/handler.ts and
// src/application/followUpNudges.ts). Deliberately NOT applied to a lead's
// own phoneNumber (api/leads/handler.ts) - that value is customer-supplied,
// display-only data the CRM never uses to originate an outbound send by
// itself, so rejecting a messy real-world lead phone number would cost more
// (a lead an agent can't save) than it protects against.
//
// Format: a leading "+", then 7-15 digits, first digit 1-9 (ITU-T E.164) -
// e.g. "+14155238886". Kept intentionally permissive beyond that (no
// country-specific length/prefix table) since this only guards "is this
// even plausibly a phone number Twilio's API could accept," not full
// carrier-level validation.
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export function isValidE164(value: string): boolean {
  return E164_PATTERN.test(value);
}
