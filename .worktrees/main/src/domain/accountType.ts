// Fixed classification of the TENANT itself - is this organization a single
// individual working alone, or an agency/team managing leads on behalf of
// multiple clients. Same fixed-catalog convention already used elsewhere in
// this codebase (see IndustryKey/INDUSTRY_KEYS in industryTemplates.ts and
// PermissionCode/ALL_PERMISSIONS in permissions.ts): a union type plus a
// matching const array of every valid value, never a bare string compared
// ad hoc - so "is this a valid account type" and "list every account type"
// each have exactly one place to look.
//
// Deliberately an ORGANIZATION-level attribute (see companies.accountType
// in schema.ts), not a per-user one - same reasoning as industryTemplate/
// companySize/timezone already living on `companies` rather than `users`:
// it describes the tenant itself, not any one teammate within it, and two
// users of the same company can never disagree about which one their
// company is.

export type AccountType = "individual" | "agency";

export const ACCOUNT_TYPE_KEYS: AccountType[] = ["individual", "agency"];

export const DEFAULT_ACCOUNT_TYPE: AccountType = "individual";

export function isAccountType(value: unknown): value is AccountType {
  return typeof value === "string" && (ACCOUNT_TYPE_KEYS as string[]).includes(value);
}

/** Same "never reject registration over this, just default it" posture as
 * industryTemplates.ts's own resolver (see resolveIndustryKey in
 * src/application/auth.ts) - a missing/unrecognized value is a product
 * default, not a validation error. */
export function resolveAccountType(value: string | undefined): AccountType {
  return isAccountType(value) ? value : DEFAULT_ACCOUNT_TYPE;
}

// Label/description catalog for the registration wizard's choice cards
// (public/register.html) - the same {key, label, description} shape
// PERMISSION_CATALOG already uses in permissions.ts, kept here (not
// hard-coded in the HTML) so the UI and any future admin-facing display of
// this value read from one source.
export const ACCOUNT_TYPE_CATALOG: Array<{ key: AccountType; label: string; description: string }> = [
  { key: "individual", label: "Individual", description: "Just me - I work my own leads." },
  { key: "agency", label: "Agency", description: "My team manages leads on behalf of clients." },
];
