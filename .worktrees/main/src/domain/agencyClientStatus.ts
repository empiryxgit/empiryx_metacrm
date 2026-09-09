// The fixed status catalog for one row of `agency_clients` (see schema.ts's
// own doc comment on that table for why this is a relationship, not a
// third `account_type` value). Same union-type-plus-array convention as
// AccountType/ACCOUNT_TYPE_KEYS in accountType.ts and every other fixed
// catalog in this codebase.
//
// Lifecycle (not enforced as a state machine here - that belongs in the
// application layer wiring this table up, a later phase, same split
// documented on the agencyClients table itself):
//   invited   - the agency has invited this client organization; the client
//               has not yet responded.
//   pending   - the client has responded/requested to join and the agency
//               (or an automated step) has not yet confirmed it.
//   active    - the relationship is live - this is the ONE status that
//               represents "this agency currently manages this client" in
//               the everyday sense.
//   suspended - temporarily paused (by either party) without severing the
//               relationship outright - distinct from "removed" the same
//               way a disabled user (users.status) differs from a deleted
//               one; the row and its history stay intact.
//   removed   - terminal. The one status EXCLUDED from
//               ux_agency_clients_one_claimed_agency_per_client (see
//               schema.ts) - a "removed" relationship frees the client
//               organization to be claimed by a different (or the same,
//               reactivated) agency.

export type AgencyClientStatus = "invited" | "pending" | "active" | "suspended" | "removed";

export const AGENCY_CLIENT_STATUSES: AgencyClientStatus[] = ["invited", "pending", "active", "suspended", "removed"];

// The statuses that occupy a client organization's one-agency slot (see the
// partial unique index on agencyClients) - kept here, not just inline in
// the migration, so application code can ask "is this client currently
// claimed by an agency" without re-deriving the list. Must stay in sync
// with ux_agency_clients_one_claimed_agency_per_client's WHERE clause.
export const CLAIMED_AGENCY_CLIENT_STATUSES: AgencyClientStatus[] = ["invited", "pending", "active", "suspended"];

export function isAgencyClientStatus(value: unknown): value is AgencyClientStatus {
  return typeof value === "string" && (AGENCY_CLIENT_STATUSES as string[]).includes(value);
}
