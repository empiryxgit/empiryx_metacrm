// Agency/client access audit trail - "Agency/client access must be
// auditable" (explicit user request). Every one of the 11 fixed events in
// src/domain/agencyAuditAction.ts is written through recordAgencyAuditEvent
// below, which is deliberately the ONLY way any call site can reach
// agencyAuditLog.ts's insert: its parameters are a small typed whitelist
// (agencyCompanyId / agencyUserId / clientCompanyId / action / detail:
// string), never an arbitrary payload object - so there is no shape through
// which a call site could accidentally pass a password, token, session
// cookie, API secret, or other credential through to the log. This is the
// enforcement point for the user's explicit constraint: "Do not log
// passwords, tokens or secrets." `detail` must only ever hold non-secret,
// human-readable context - an email address, a company/client name, a
// short note like "declined invitation" - and every call site in this
// codebase that populates it has been written with that rule in mind. If a
// future call site ever needs to record something that could plausibly be
// sensitive, it must NOT be added to `detail` - that is a sign the event
// needs its own reviewed field instead.
//
// Column semantics (the actor-vs-subject question, settled once here so
// every call site follows the same rule instead of re-deciding it):
//
//   agencyUserId - always the ACTOR: the id of whichever agency-side user
//   performed the action that produced this event. This is a single,
//   consistent rule across all 11 actions, including AGENCY_USER_CREATED and
//   AGENCY_USER_ASSIGNED (where an admin acts on a DIFFERENT user) - the
//   admin who clicked the button is agencyUserId; the user being
//   created/reassigned is not a separate typed column (the spec this table
//   follows names exactly agency_user_id/client_organization_id/action/
//   timestamp, not a second user column) but is recorded in `detail` as
//   plain non-secret context (e.g. "created user <email>", "reassigned role
//   for <email>") so the event stays traceable without inventing a field the
//   user didn't ask for. agencyUserId is null only when there genuinely is
//   no agency-side actor for the event - the sole case today is a
//   CLIENT-side user accepting/declining an agency's invite, or self-
//   registering through an agency's onboarding link: INVITATION_ACCEPTED
//   fired from respondToAgencyInvite's accept path, and CLIENT_REMOVED fired
//   from its decline path, both have the client's own user as the actor, not
//   an agency user - `detail` records that acting client user's id instead.
//
//   clientCompanyId - the client company the event concerns, when there is
//   one. Null for the two account/company-level events that have no client
//   subject at all: AGENCY_CREATED (a new agency registering) and
//   AGENCY_USER_CREATED/AGENCY_USER_ASSIGNED (agency-internal user
//   administration, not about any one client).
//
// See each call site (agency.ts, agencyOnboarding.ts, auth.ts,
// api/admin/users/handler.ts) for exactly which of the 11 actions fires
// where; every call site carries its own short comment pointing back here.

import { insertAgencyAuditLogEntry, listAgencyAuditLog, type AgencyAuditLogEntry } from "../infrastructure/db/repositories/agencyAuditLog";
import type { AgencyAuditAction } from "../domain/agencyAuditAction";

export interface RecordAgencyAuditEventInput {
  agencyCompanyId: string;
  action: AgencyAuditAction;
  /** The acting agency-side user's id - see this file's header comment for
   * the full actor-vs-subject rule. Omit or pass null when the actor is not
   * an agency-side user. */
  agencyUserId?: string | null;
  /** The client company this event concerns, when there is one. */
  clientCompanyId?: string | null;
  /** Free-text, NON-SECRET context only - never a password, token, or other
   * credential. See this file's header comment. */
  detail?: string | null;
}

/**
 * Records one audit event. Best-effort and non-throwing, same posture as
 * every other post-action side effect in this codebase (setCompanyCreatedBy,
 * completeOnboarding, provisionDefaultForms, assignClientToUser's own
 * call-site try/catches) - a failure to WRITE an audit row must never block
 * or roll back the real action it's describing, so this swallows its own
 * errors (logged to console.error) rather than letting a caller's await
 * throw. Call it AFTER the action it describes has actually succeeded.
 */
export async function recordAgencyAuditEvent(input: RecordAgencyAuditEventInput): Promise<void> {
  try {
    await insertAgencyAuditLogEntry({
      agencyCompanyId: input.agencyCompanyId,
      agencyUserId: input.agencyUserId ?? null,
      clientCompanyId: input.clientCompanyId ?? null,
      action: input.action,
      detail: input.detail ?? null,
    });
  } catch (err) {
    console.error(`[agency-audit-log] Failed to record ${input.action}:`, err);
  }
}

/** Thin passthrough for a future "Audit Log" viewer - see
 * listAgencyAuditLog's own doc comment in the repository for the read-side
 * shape. Not currently wired into any UI; the user asked only that events be
 * recorded, not for a viewer, so no route/page consumes this yet. */
export async function getAgencyAuditLog(
  agencyCompanyId: string,
  opts?: { clientCompanyId?: string; limit?: number },
): Promise<AgencyAuditLogEntry[]> {
  return listAgencyAuditLog(agencyCompanyId, opts ?? {});
}
