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
// Security model (see agencyOnboardingTokens' own doc comment in schema.ts
// and generateOnboardingToken in src/infrastructure/auth/tokens.ts for the
// mechanics): the link's token is the ONLY credential either endpoint below
// accepts - never an id in the URL. getOnboardingLinkPreview and
// completeAgencyOnboarding both resolve agencyCompanyId purely by hashing
// the caller-supplied token and looking that hash up; neither function
// takes an agencyCompanyId or clientCompanyId parameter at all, so there is
// no id-shaped input for a caller to tamper with in the first place.

import { AuthError } from "./auth";
import { uniqueSlug } from "./auth";
import { hashPassword } from "../infrastructure/auth/password";
import { generateOnboardingToken, hashOnboardingToken, ONBOARDING_TOKEN_TTL_SECONDS } from "../infrastructure/auth/tokens";
import {
  claimOnboardingTokenByHash,
  createOnboardingToken,
  getOnboardingTokenByHash,
  listOnboardingTokensForAgency,
  revokeOnboardingToken,
  setOnboardingTokenResultingCompany,
} from "../infrastructure/db/repositories/agencyOnboardingTokens";
import {
  createCompany,
  createOwnerRole,
  createUser,
  emailExists,
  getCompanyById,
  setCompanyCreatedBy,
  completeOnboarding,
} from "../infrastructure/db/repositories/tenancy";
import { linkOrReactivateClientOrganization } from "../infrastructure/db/repositories/organizations";
import { provisionDefaultForms } from "../infrastructure/db/repositories/forms";
import { getIndustryTemplate } from "../domain/industryTemplates";

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
 * ultimately creates. */
export async function generateOnboardingLink(input: GenerateOnboardingLinkInput): Promise<GenerateOnboardingLinkResult> {
  const clientName = input.clientName.trim();
  const contactEmail = input.contactEmail.trim().toLowerCase();
  if (!clientName || !contactEmail) {
    throw new AuthError("Client name and contact email are both required.");
  }

  const { token, hash } = generateOnboardingToken();
  const expiresAt = new Date(Date.now() + ONBOARDING_TOKEN_TTL_SECONDS * 1000);

  await createOnboardingToken({
    agencyCompanyId: input.agencyCompanyId,
    tokenHash: hash,
    clientName,
    contactEmail,
    expiresAt,
    createdBy: input.actingUserId,
  });

  return { token, expiresAt };
}

/** Every onboarding link this agency has generated - the Clients page's own
 * management list (pending links to copy/revoke, plus used/expired
 * history). Never returns tokenHash - there is no legitimate reason for
 * this response to carry even the hash of a live credential, and the raw
 * token was never stored in the first place. */
export async function listOnboardingLinks(agencyCompanyId: string) {
  const rows = await listOnboardingTokensForAgency(agencyCompanyId);
  const now = new Date();
  return rows.map((r) => ({
    id: r.id,
    clientName: r.clientName,
    contactEmail: r.contactEmail,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    usedAt: r.usedAt,
    revokedAt: r.revokedAt,
    resultingCompanyId: r.resultingCompanyId,
    // Derived, not stored - see agencyOnboardingTokens' own doc comment in
    // schema.ts on why expiry is a plain timestamp comparison rather than a
    // status column: "expired" only means something once you compare
    // expiresAt to "now", which a stored value can never itself express.
    status: r.revokedAt ? "revoked" : r.usedAt ? "used" : r.expiresAt < now ? "expired" : "pending",
  }));
}

/** Scoped by agencyCompanyId inside the repository call - an agency can
 * only revoke a link it actually generated. Revoking an already-used or
 * already-expired link is harmless (it can't be redeemed either way) so
 * this never bothers rejecting that case specially. */
export async function revokeOnboardingLink(agencyCompanyId: string, tokenId: string): Promise<void> {
  await revokeOnboardingToken(agencyCompanyId, tokenId);
}

export interface OnboardingLinkPreview {
  agencyName: string;
  clientName: string;
  contactEmail: string;
}

// One shared, deliberately generic message for every "this token doesn't
// work right now" case (not found / expired / already used / revoked).
// Distinguishing them for the visitor would mean confirming details about
// someone else's invite to whoever happens to be holding a guessed or
// stale link - the same "don't leak more than the outcome" posture
// loginCompanyAndUser's own comment on NO_SUCH_USER_DUMMY_HASH follows.
const INVALID_LINK_MESSAGE = "This invitation link is invalid, has expired, or has already been used.";

/** Read-only lookup for the public landing page
 * (public/onboarding-agency.html, reached via /onboarding/agency/{token}) -
 * shows "ABC Digital invited ABC Realty to join RUTA" WITHOUT consuming the
 * token. Never called by the actual redemption step below, which re-checks
 * validity itself via the atomic claim. */
export async function getOnboardingLinkPreview(rawToken: string): Promise<OnboardingLinkPreview> {
  const row = await getOnboardingTokenByHash(hashOnboardingToken(rawToken));
  if (!row || row.revokedAt || row.usedAt || row.expiresAt < new Date()) {
    throw new AuthError(INVALID_LINK_MESSAGE, 410);
  }
  const agency = await getCompanyById(row.agencyCompanyId);
  if (!agency) throw new AuthError(INVALID_LINK_MESSAGE, 410);
  return { agencyName: agency.name, clientName: row.clientName, contactEmail: row.contactEmail };
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
 * Redeems the link: atomically claims the token (see
 * claimOnboardingTokenByHash's own doc comment for why that specific
 * statement, not a plain SELECT-then-UPDATE, is what makes this genuinely
 * single-use under concurrent requests), then creates a brand-new company +
 * Owner user from what the PERSON filled in - not from the token's own
 * clientName/contactEmail, which are just what the agency guessed before
 * this person ever saw the form. Links the new company as an "active"
 * client of the inviting agency immediately: unlike inviteExistingClient,
 * there is no further accept/decline step, because completing this form at
 * all only happens via a link that already had to be privately handed to
 * this person - same trust level addClientOrganization's own doc comment
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

  const claimed = await claimOnboardingTokenByHash(hashOnboardingToken(input.token));
  if (!claimed) {
    throw new AuthError(INVALID_LINK_MESSAGE, 410);
  }

  // The token is now consumed regardless of what happens below - a failure
  // past this point is the same rare, admin-visible, manually-recoverable
  // case registerCompanyAndOwner's own comment accepts for the equivalent
  // non-transactional steps on the ordinary registration flow.
  if (await emailExists(ownerEmail)) {
    throw new AuthError("An account with this email already exists. Log in instead.", 409);
  }

  const slug = await uniqueSlug(companyName);
  const passwordHash = await hashPassword(input.password);
  const industryTemplate = "real_estate" as const;

  const company = await createCompany({ name: companyName, slug, industryTemplate, accountType: "individual" });
  const ownerRole = await createOwnerRole(company.id);
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

  try {
    await setOnboardingTokenResultingCompany(claimed.id, company.id);
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
