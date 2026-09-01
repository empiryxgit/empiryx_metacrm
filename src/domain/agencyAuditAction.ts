// Fixed catalog of agency/client access audit events - see
// src/application/agencyAuditLog.ts's own header comment for the full
// design (why these 11 exact names, what `agencyUserId` means for each,
// and the "never log secrets" contract). Same "TS union + backing array +
// type guard, stored as plain text" pattern as AgencyClientStatus
// (src/domain/agencyClientStatus.ts) and OrganizationInvitationStatus
// (src/domain/organizationInvitationStatus.ts) - deliberately NOT a real
// Postgres enum, so adding a 12th event later is a pure application-layer
// change with no migration required.
export type AgencyAuditAction =
  | "AGENCY_CREATED"
  | "CLIENT_INVITED"
  | "INVITATION_ACCEPTED"
  | "CLIENT_CREATED"
  | "CLIENT_SUSPENDED"
  | "CLIENT_REMOVED"
  | "AGENCY_USER_CREATED"
  | "AGENCY_USER_ASSIGNED"
  | "CLIENT_ACCESS_GRANTED"
  | "CLIENT_ACCESS_REVOKED"
  | "CLIENT_CONTEXT_SWITCHED";

export const AGENCY_AUDIT_ACTIONS: AgencyAuditAction[] = [
  "AGENCY_CREATED",
  "CLIENT_INVITED",
  "INVITATION_ACCEPTED",
  "CLIENT_CREATED",
  "CLIENT_SUSPENDED",
  "CLIENT_REMOVED",
  "AGENCY_USER_CREATED",
  "AGENCY_USER_ASSIGNED",
  "CLIENT_ACCESS_GRANTED",
  "CLIENT_ACCESS_REVOKED",
  "CLIENT_CONTEXT_SWITCHED",
];

export function isAgencyAuditAction(value: string): value is AgencyAuditAction {
  return (AGENCY_AUDIT_ACTIONS as string[]).includes(value);
}
