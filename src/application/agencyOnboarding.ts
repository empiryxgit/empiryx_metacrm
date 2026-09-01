// "Generate Onboarding Link" (Agency Dashboard -> Clients -> Add Client ->
// Generate Onboarding Link) - a third way to get a client onto an agency's
// roster, alongside addClientOrganization (agency types in everything,
// system password) and inviteExistingClient (links an already-registered
// company by email, needs accept/decline) in src/application/agency.ts.
// This one hands a PROSPECTIVE client - someone with no RUTA account at
// all - a secure link that self-registers them: the agency only supplies a
// display name + contact email up front, the actual company/owner/password
// are whatever the person completing the link types in themselves. The act
// of completing that form through a validly-claimed link IS the consent
// step here, the same way clicking "Create Account" is consent on the
// ordinary public registration flow - there is no separate accept/decline
// afterward the way inviteExistingClient needs one.
//
// Security model (see organizationInvitations' own doc comment in
// schema.ts and generateOnboardingToken in src/infrastructure/auth/
// tokens.ts for the mechanics): the link's token is the ONLY credential
// either endpoint below accepts - never an id in the URL. Neither
// getOnboardingLinkPreview nor completeAgencyOnboarding takes an
// agencyCompanyId or clientCompanyId parameter at all - both resolve the
// agency purely by hashing the caller-supplied token and looking that hash
// up - so there is no id-shaped input for a caller to tamper with in order
// to pick their own agency in the first place.

import { AuthError } from "./auth";
import { uniqueSlug } from "./auth";
import { hashPassword } from "../infrastructure/auth/password";
import { generateOnboardingToken, hashOnboardingToken, ONBOARDING_TOKEN_TTL_SECONDS } from "../infrastructure/auth/tokens";
import { isUniqueViolation } from "../infrastructure/db/repositories";
import {
  acceptInvitationByHash,
  createInvitation,
  getInvitationByHash,
  listInvitationsForAgency,
  revokeInvitation,
  setInvitationResultingCompany,
} from "../infrastructure/db/repositories/organizationInvitations";
import { effectiveInvitationStatus } from "../domain/organizationInvitationStatus";
import {
  createClientFixedRoles,
  createCompany,
  createUser,
  emailExists,
  getCompanyById,
  setCompanyCreatedBy,
  completeOnboarding,
} from "../infrastructure/db/repositories/tenancy";
import { linkOrReactivateClientOrganization } from "../infrastructure/db/repositories/organizations";
import { assignClientToUser } from "../infrastructure/db/repositories/agencyClientAssignments";
import { provisionDefaultForms } from "../infrastructure/db/repositories/forms";
import { getIndustryTemplate } from "../domain/industryTemplates";
import { recordAgencyAuditEvent } from "./agencyAuditLog";

export interface GenerateOnboardingLinkInput {
  agencyCompanyId: string;
  actingUserId: string;
  clientName: string;
  contactEmail: string;
}

export interface GenerateOnboardingLinkResult {
  // The raw token - shown exactly once, same one-time-reveal contract as
  // addClientOrganization's temporaryPassword. The caller (the API handler)
  // builds the actual /onboarding/agency/{token} URL; this layer has no
  // notion of the deployment's base URL.
  token: string;
  expiresAt: Date;
}

/** Generates a fresh, cryptographically random invite token and stores only
 * its hash - see generateOnboardingToken's own doc comment for why that's
 * the right primitive here. clientName/contactEmail are purely descriptive
 * (shown back on the public landing page before an account exists to read
 * them from) - they place no constraint on what completeAgencyOnboarding
 * ultimately creates. Always creates a PENDING invitation - see
 * createInvitation's own comment on why nothing else is possible here.
 *
 * At most one PENDING invitation may exist per (agency, email) pair at a
 * time - enforced by ux_organization_invitations_one_pending_per_agency_email
 * in schema.ts, not just a soft application-layer check, so it holds even
 * under concurrent requests. This function pre-checks nothing and instead
 * catches that constraint's violation below, translating it into the same
 * friendly AuthError shape every other validation failure here uses - an
 * agency generating a second link before the first is revoked/accepted
 * gets a clear message, never a raw 500. */
export async function generateOnboardingLink(input: GenerateOnboardingLinkInput): Promise<GenerateOnboardingLinkResult> {
  const clientName = input.clientName.trim();
  const email = input.contactEmail.trim().toLowerCase();
  if (!clientName || !email) {
    throw new AuthError("Client name and contact email are both required.");
  }

  const { token, hash } = generateOnboardingToken();
  const expiresAt = new Date(Date.now() + ONBOARDING_TOKEN_TTL_SECONDS * 1000);

  try {
    await createInvitation({
      agencyCompanyId: input.agencyCompanyId,
      tokenHash: hash,
      clientName,
      email,
      expiresAt,
      createdBy: input.actingUserId,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AuthError(`An onboarding invitation to ${email} is already pending. Revoke it first, or wait for it to be accepted or expire, before generating a new one.`);
    }
    throw err;
  }

  // CLIENT_INVITED - this self-serve onboarding link is a third "invite a
  // client" path alongside inviteExistingClient (agency.ts), which fires the
  // same event - see agencyAuditLog.ts's header comment. clientCompanyId is
  // null: no client company exists yet at this point, only an invitation for
  // one that may or may not ever be redeemed (see completeAgencyOnboarding
  // below for CLIENT_CREATED, fired once one actually is).
  await recordAgencyAuditEvent({
    agencyCompanyId: input.agencyCompanyId,
    action: "CLIENT_INVITED",
    agencyUserId: input.actingUserId,
    clientCompanyId: null,
    detail: `Generated onboarding link for "${clientName}" (${email})`,
  });

  return { token, expiresAt };
}

/** Every onboarding invitation this agency has generated - the Clients
 * page's own management list (pending links to copy/revoke, plus
 * accepted/expired/revoked history). Tenant-scoped by construction
 * (listInvitationsForAgency only ever queries the calling agency's own
 * id). Never returns tokenHash - there is no legitimate reason for this
 * response to carry even the hash of a live credential, and the raw token
 * was never stored in the first place. `status` here is the DISPLAYED
 * status (PENDING/ACCEPTED/EXPIRED/REVOKED) - see
 * effectiveInvitationStatus's own comment on why EXPIRED is computed
 * rather than read straight off the stored column. */
export async function listOnboardingLinks(agencyCompanyId: string) {
  const rows = await listInvitationsForAgency(agencyCompanyId);
  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName,
    contactEmail: r.email,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    acceptedAt: r.acceptedAt,
    revokedAt: r.revokedAt,
    resultingCompanyId: r.resultingCompanyId,
    status: effectiveInvitationStatus(r),
  }));
}

/** Scoped by agencyCompanyId inside the repository call - tenant-aware by
 * construction: an agency can only revoke an invitation it actually
 * generated, never another agency's. Revoking an already-accepted or
 * already-expired invitation is harmless (it can't be redeemed either way)
 * so this never bothers rejecting that case specially. */
export async function revokeOnboardingLink(agencyCompanyId: string, invitationId: string): Promise<void> {
  await revokeInvitation(agencyCompanyId, invitationId);
}

export interface OnboardingLinkPreview {
  agencyName: string;
  clientName: string;
  contactEmail: string;
}

// One shared, deliberately generic message for every "this token doesn't
// work right now" case (not found / expired / already accepted / revoked).
// Distinguishing them for the visitor would mean confirming details about
// someone else's invite to whoever happens to be holding a guessed or
// stale link - the same "don't leak more than the outcome" posture
// loginCompanyAndUser's own comment on NO_SUCH_USER_DUMMY_HASH follows.
const INVALID_LINK_MESSAGE = "This invitation link is invalid, has expired, or has already been used.";

/** Read-only lookup for the public landing page
 * (public/onboarding-agency.html, reached via /onboarding/agency/{token}) -
 * shows "Welcome to ABC Digital" WITHOUT consuming the token. Never called
 * by the actual redemption step below, which re-validates atomically on
 * its own via acceptInvitationByHash rather than trusting a prior preview
 * call. Takes only the raw token - no agencyCompanyId/clientCompanyId
 * input exists here for a tampered request to override. */
export async function getOnboardingLinkPreview(rawToken: string): Promise<OnboardingLinkPreview> {
  const row = await getInvitationByHash(hashOnboardingToken(rawToken));
  if (!row || effectiveInvitationStatus(row) !== "PENDING") {
    throw new AuthError(INVALID_LINK_MESSAGE, 410);
  }
  const agency = await getCompanyById(row.agencyCompanyId);
  if (!agency) throw new AuthError(INVALID_LINK_MESSAGE, 410);
  return { agencyName: agency.name, clientName: row.clientName, contactEmail: row.email };
}

export interface CompleteAgencyOnboardingInput {
  token: string;
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  phoneNumber: string;
  password: string;
}

export interface CompleteAgencyOnboardingResult {
  company: { id: string; name: string };
  owner: { id: string; email: string; fullName: string };
}

/**
 * Redeems the invitation: atomically accepts it (see
 * acceptInvitationByHash's own doc comment for why that specific
 * statement, not a plain SELECT-then-UPDATE, is what makes this genuinely
 * single-use under concurrent requests), then creates a brand-new company +
 * Owner user from what the PERSON filled in - not from the invitation's own
 * clientName/email, which are just what the agency guessed before this
 * person ever saw the form. Links the new company as an "active" client of
 * whichever agency the ACCEPTED INVITATION ROW names
 * (claimed.agencyCompanyId) - never anything the request body supplies;
 * this input type has no agencyCompanyId field for a tampered request to
 * populate in the first place, so there is nothing for frontend
 * manipulation to override here. Unlike inviteExistingClient, there is no
 * further accept/decline step, because completing this form at all only
 * happens via a link that already had to be privately handed to this
 * person - same trust level addClientOrganization's own doc comment
 * describes for the agency-originates-it case.
 */
export async function completeAgencyOnboarding(input: CompleteAgencyOnboardingInput): Promise<CompleteAgencyOnboardingResult> {
  const companyName = input.companyName.trim();
  const ownerName = input.ownerName.trim();
  const ownerEmail = input.ownerEmail.trim().toLowerCase();
  const phoneNumber = input.phoneNumber.trim();

  if (!companyName || !ownerName || !ownerEmail || !phoneNumber) {
    throw new AuthError("Company name, your name, email, and mobile number are all required.");
  }
  if (input.password.length < 10) {
    throw new AuthError("Password must be at least 10 characters.");
  }

  const claimed = await acceptInvitationByHash(hashOnboardingToken(input.token));
  if (!claimed) {
    throw new AuthError(INVALID_LINK_MESSAGE, 410);
  }

  // The invitation is now consumed (status='ACCEPTED') regardless of what
  // happens below - a failure past this point is the same rare,
  // admin-visible, manually-recoverable case registerCompanyAndOwner's own
  // comment accepts for the equivalent non-transactional steps on the
  // ordinary registration flow.
  if (await emailExists(ownerEmail)) {
    throw new AuthError("An account with this email already exists. Log in instead.", 409);
  }

  const slug = await uniqueSlug(companyName);
  const passwordHash = await hashPassword(input.password);
  // "general" - plain Core CRM, no industry specialization picked on this
  // client's behalf. The onboarding link's own form never collects an
  // industry choice; the client (or the agency, on their behalf) can pick a
  // real template any time afterward from Settings -> Business
  // Configuration -> Industry/Template.
  const industryTemplate = "general" as const;

  const company = await createCompany({ name: companyName, slug, industryTemplate, accountType: "individual" });
  // The four fixed CLIENT_OWNER/ADMIN/MANAGER/USER roles (see
  // src/domain/fixedRoles.ts), same as addClientOrganization's own
  // Add-Client flow - this company is likewise being originated as an
  // agency's client, just via a self-service link instead of the agency
  // typing everything in directly.
  const ownerRole = (await createClientFixedRoles(company.id)).get("CLIENT_OWNER")!;
  const owner = await createUser({
    companyId: company.id,
    roleId: ownerRole.id,
    email: ownerEmail,
    passwordHash,
    fullName: ownerName,
    phoneNumber,
  });

  await linkOrReactivateClientOrganization({
    agencyCompanyId: claimed.agencyCompanyId,
    clientCompanyId: company.id,
    createdBy: claimed.createdBy ?? undefined,
    status: "active",
  });

  // INVITATION_ACCEPTED / CLIENT_CREATED - the token redemption above
  // (acceptInvitationByHash) and the company+owner+link above have all
  // actually succeeded by this point. agencyUserId is null for
  // INVITATION_ACCEPTED - see agencyAuditLog.ts's header comment: the actor
  // completing this form is the brand-new CLIENT owner, not an agency user
  // (the agency user who generated the link is recorded separately below,
  // on CLIENT_CREATED and CLIENT_ACCESS_GRANTED, as the acting user for
  // those). CLIENT_CREATED does carry claimed.createdBy as agencyUserId
  // (nullable - the generating user could since have been removed, same
  // as the auto-assign below), since a client company genuinely was
  // created by/on behalf of that agency user's invitation.
  await recordAgencyAuditEvent({
    agencyCompanyId: claimed.agencyCompanyId,
    action: "INVITATION_ACCEPTED",
    agencyUserId: null,
    clientCompanyId: company.id,
    detail: `Onboarding link redeemed by ${owner.email}`,
  });
  await recordAgencyAuditEvent({
    agencyCompanyId: claimed.agencyCompanyId,
    action: "CLIENT_CREATED",
    agencyUserId: claimed.createdBy ?? null,
    clientCompanyId: company.id,
    detail: `Client "${company.name}" created via onboarding link (owner: ${owner.email})`,
  });

  // Auto-assign whichever agency user generated this onboarding link (the
  // invitation's own createdBy) to the client it just produced - same
  // reasoning as addClientOrganization's own comment on assignClientToUser.
  // Best-effort: claimed.createdBy is nullable (the generating user could
  // since have been removed - see organizationInvitations.createdBy's own
  // ON DELETE SET NULL), and a failure here must never block onboarding.
  if (claimed.createdBy) {
    try {
      await assignClientToUser({
        agencyCompanyId: claimed.agencyCompanyId,
        clientCompanyId: company.id,
        userId: claimed.createdBy,
        createdBy: claimed.createdBy,
      });
      // CLIENT_ACCESS_GRANTED - see addClientOrganization's identical
      // comment in agency.ts for the reasoning.
      await recordAgencyAuditEvent({
        agencyCompanyId: claimed.agencyCompanyId,
        action: "CLIENT_ACCESS_GRANTED",
        agencyUserId: claimed.createdBy,
        clientCompanyId: company.id,
        detail: "Auto-assigned to inviting user on client creation via onboarding link",
      });
    } catch (err) {
      console.error("[agency-onboarding/complete] Failed to auto-assign inviting user to new client:", err);
    }
  }

  try {
    await setInvitationResultingCompany(claimed.id, company.id);
  } catch (err) {
    console.error("[agency-onboarding/complete] Failed to record resultingCompanyId:", err);
  }
  try {
    await completeOnboarding(company.id);
  } catch (err) {
    console.error("[agency-onboarding/complete] Failed to mark onboarding complete:", err);
  }
  try {
    await setCompanyCreatedBy(company.id, owner.id);
  } catch (err) {
    console.error("[agency-onboarding/complete] Failed to set company.createdBy:", err);
  }
  try {
    await provisionDefaultForms(company.id, getIndustryTemplate(industryTemplate), owner.id);
  } catch (err) {
    console.error("[agency-onboarding/complete] Failed to provision default forms:", err);
  }

  return {
    company: { id: company.id, name: company.name },
    owner: { id: owner.id, email: owner.email, fullName: owner.fullName },
  };
}
