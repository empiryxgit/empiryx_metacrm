// The fixed status catalog for one row of `organization_invitations` (see
// schema.ts's own doc comment on that table). Same union-type-plus-array
// convention as AccountType/ACCOUNT_TYPE_KEYS and AgencyClientStatus/
// AGENCY_CLIENT_STATUSES - every other fixed catalog in this codebase.
//
// Only PENDING, ACCEPTED, and REVOKED are ever WRITTEN to the status
// column - see acceptInvitation/revokeInvitation in
// src/infrastructure/db/repositories/organizationInvitations.ts. EXPIRED is
// never written by this codebase; it is computed at read time by comparing
// a still-PENDING row's expiresAt to "now" (see effectiveInvitationStatus
// below) rather than requiring a cron job to sweep expired rows and flip a
// column. This keeps the single-use claim
// (acceptInvitation's own atomic UPDATE ... WHERE status = 'PENDING' AND
// expires_at > now()) correct without that job: an expired-but-still-
// "PENDING"-in-the-database row is already unacceptable regardless of what
// the status column says, because the same WHERE clause checks expiresAt
// directly. EXPIRED exists in this catalog purely so callers that only look
// at a computed/display status (an admin's Onboarding Links list) see the
// truth, not a stale "Pending".
export type OrganizationInvitationStatus = "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED";

export const ORGANIZATION_INVITATION_STATUSES: OrganizationInvitationStatus[] = ["PENDING", "ACCEPTED", "EXPIRED", "REVOKED"];

export function isOrganizationInvitationStatus(value: unknown): value is OrganizationInvitationStatus {
  return typeof value === "string" && (ORGANIZATION_INVITATION_STATUSES as string[]).includes(value);
}

/** The DISPLAYED status for one invitation row - the stored `status` column
 * for ACCEPTED/REVOKED (those are terminal and always accurate), but
 * "EXPIRED" instead of a stale "PENDING" once `expiresAt` has passed. See
 * this file's own header comment for why EXPIRED is computed here rather
 * than stored. */
export function effectiveInvitationStatus(row: { status: string; expiresAt: Date }): OrganizationInvitationStatus {
  if (row.status === "PENDING" && row.expiresAt.getTime() < Date.now()) return "EXPIRED";
  return row.status as OrganizationInvitationStatus;
}
