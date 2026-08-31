// The fixed status catalog for one row of `agency_organizations` (see
// schema.ts's own doc comment on that table for why this is a relationship,
// not a third `account_type` value). Same union-type-plus-array convention
// as AccountType/ACCOUNT_TYPE_KEYS in accountType.ts and every other fixed
// catalog in this codebase.

export type AgencyRelationshipStatus = "active" | "revoked";

export const AGENCY_RELATIONSHIP_STATUSES: AgencyRelationshipStatus[] = ["active", "revoked"];

export function isAgencyRelationshipStatus(value: unknown): value is AgencyRelationshipStatus {
  return typeof value === "string" && (AGENCY_RELATIONSHIP_STATUSES as string[]).includes(value);
}
