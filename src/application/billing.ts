// Campaign/client capacity enforcement + Razorpay overage purchase flow.
// The application-layer counterpart to src/domain/billing.ts's pure
// pricing/limit catalog - this file is where those numbers meet real
// company/campaign/agency-client rows.
//
// Central design decision (see this feature's own PR description for the
// full reasoning): a CLIENT company never has a plan of its own - only an
// Individual tenant or an Agency ever pays. So every check/purchase here
// first resolves the "pool root" company (resolvePoolRootCompanyId) -
// itself for an ordinary Individual/Agency, or the CLAIMING AGENCY for a
// company that is itself a claimed client - and then works entirely in
// terms of that root, regardless of which company's login session actually
// triggered the check. This is what makes "10 campaigns total across 5
// clients" a real, enforced pool rather than marketing copy: a client's
// own team creating a campaign directly (no agency client-switcher
// involved) still counts against - and is blocked by - their agency's
// shared limit, exactly the same as an agency user creating it while
// "inside" that client.

import { AuthError } from "./auth";
import type { AccountType } from "../domain/accountType";
import { resolveAccountType } from "../domain/accountType";
import {
  BASE_CLIENT_LIMIT_AGENCY,
  BASE_SUBSCRIPTION_KIND,
  baseCampaignLimit,
  computeBaseSubscriptionAmountInPaise,
  computeOverageAmountInPaise,
  cycleEndDate,
  overageKindForAccountType,
  overageSlotsForQuantity,
  CYCLE_DISCOUNT,
  CYCLE_LABELS,
  BILLING_CYCLE_KEYS,
  type BillingCycle,
  type OverageKind,
  type PurchaseKind,
} from "../domain/billing";
import { resolveEntitlementState, effectiveCampaignLimit, effectiveClientLimit, isEntitlementBlocked, type EntitlementState } from "../domain/trial";
import { selectExcessForDowngrade, type DowngradeCandidate } from "../domain/capacityDowngrade";
import {
  getCompanyById,
  applyOverageCapacityPurchase,
  applyBaseSubscriptionPurchase,
} from "../infrastructure/db/repositories/tenancy";
import { listClaimedClientOrganizations, getClaimingAgencyForClient, setAgencyClientStatus } from "../infrastructure/db/repositories/organizations";
import { listCampaigns, listCampaignsForCompanies, updateCampaign } from "../infrastructure/db/repositories/campaigns";
import { recordAgencyAuditEvent } from "./agencyAuditLog";
import {
  getBillingOrderByRazorpayOrderId,
  insertBillingOrder,
  markBillingOrderPaid,
  stampBillingOrderWebhookConfirmed,
} from "../infrastructure/db/repositories/billing";
import { createRazorpayOrder, verifyRazorpayPaymentSignature } from "../infrastructure/razorpay/client";
import { randomUUID } from "node:crypto";

/** Serializes an EntitlementState (src/domain/trial.ts) for a JSON API
 * response - Date -> ISO string, everything else passed through as-is.
 * Shared by getBillingStatus (/api/billing/status) and getEntitlementSummary
 * (/api/auth/me) so the trial banner and the Subscription & Capacity page
 * can never disagree about which state an account is in. */
export type SerializedEntitlementState =
  | { kind: "trialing"; daysRemaining: number; trialEndsAt: string }
  | { kind: "trial_expired"; trialEndsAt: string }
  | { kind: "subscribed"; expiresAt: string | null }
  | { kind: "subscription_expired"; expiresAt: string };

function serializeEntitlementState(state: EntitlementState): SerializedEntitlementState {
  switch (state.kind) {
    case "trialing":
      return { kind: "trialing", daysRemaining: state.daysRemaining, trialEndsAt: state.trialEndsAt.toISOString() };
    case "trial_expired":
      return { kind: "trial_expired", trialEndsAt: state.trialEndsAt.toISOString() };
    case "subscribed":
      return { kind: "subscribed", expiresAt: state.expiresAt ? state.expiresAt.toISOString() : null };
    case "subscription_expired":
      return { kind: "subscription_expired", expiresAt: state.expiresAt.toISOString() };
  }
}

/** A 402 - distinct from a plain AuthError so callers (the campaigns/
 * agency-clients handlers) can attach the machine-readable `code`/
 * `details` the frontend uses to redirect straight to /subscription.html
 * instead of just showing a generic error banner. */
export class LimitExceededError extends AuthError {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message, 402);
  }
}

/** Resolves which company's plan a given company's usage actually counts
 * against - see this file's own header comment. An agency's own company
 * always resolves to itself; an ordinary Individual with no claiming
 * agency also resolves to itself; a claimed CLIENT company resolves to its
 * claiming agency. */
export async function resolvePoolRootCompanyId(companyId: string): Promise<{ rootCompanyId: string; accountType: AccountType }> {
  const company = await getCompanyById(companyId);
  if (!company) throw new AuthError("Company not found.", 404);

  const accountType = resolveAccountType(company.accountType);
  if (accountType === "agency") {
    return { rootCompanyId: companyId, accountType: "agency" };
  }

  const claim = await getClaimingAgencyForClient(companyId);
  if (claim) {
    return { rootCompanyId: claim.agencyCompanyId, accountType: "agency" };
  }

  return { rootCompanyId: companyId, accountType: "individual" };
}

/**
 * Phase 16 (Meta lead synchronization) - "Only active and authorized
 * campaigns are processed." Called at the very start of every lead-
 * processing worker (src/application/processLead.ts,
 * src/application/metaSync/processMetaLeadEvent.ts,
 * src/application/metaSync/processWhatsAppMessageEvent.ts) before any
 * Graph API call or DB write, so a lead arriving for a trial_expired or
 * subscription_expired account is never inserted.
 *
 * Deliberately a single ACCOUNT-level check, not a per-campaign
 * authorization column: the campaign LIMIT during trial is already pinned
 * to exactly 1 (see effectiveCampaignLimit in src/domain/trial.ts, applied
 * by getCampaignLimitStatus) - there is never a scenario where a trialing
 * account has one authorized campaign and a second, unauthorized one
 * whose leads must be told apart. Once the account itself is blocked, ALL
 * of its campaigns stop ingesting; while trialing or genuinely subscribed,
 * every one of its (already limit-enforced) campaigns ingests normally.
 *
 * Fails OPEN (returns false - never blocks) if the company row can't be
 * resolved at all - a data-integrity gap here must never silently drop a
 * legitimate tenant's leads; getCampaignLimitStatus's own 404 on a missing
 * company is a separate, already-handled failure mode elsewhere.
 */
async function computeEntitlementBlocked(companyId: string): Promise<boolean> {
  const { rootCompanyId } = await resolvePoolRootCompanyId(companyId);
  const rootCompany = await getCompanyById(rootCompanyId);
  if (!rootCompany) return false;
  return isEntitlementBlocked(resolveEntitlementState(rootCompany));
}

export async function isLeadIngestionBlocked(companyId: string): Promise<boolean> {
  return computeEntitlementBlocked(companyId);
}

/**
 * Phase 11 - the harder trial-expiration lockout. A trial_expired or
 * subscription_expired account can still VIEW everything it already has
 * (every GET endpoint stays open - see requirePermission in
 * src/infrastructure/auth/context.ts, the only caller of this function),
 * but every WRITE gated by a specific permission (create/update/delete a
 * lead, campaign, user, role, branch, setting, form, etc.) is blocked
 * until the account subscribes. Identical underlying check to
 * isLeadIngestionBlocked above (same computeEntitlementBlocked helper,
 * same pool-root resolution so a claimed client is locked out by its
 * agency's own state, never its own) - kept as a separate exported name
 * because the two live at genuinely different call sites (a QStash
 * background worker vs. every synchronous API write) and describe
 * different things to a reader, even though the state they check is one
 * and the same.
 *
 * The billing/subscribe endpoints themselves are the deliberate exception
 * - a locked-out account must still be able to pay its way out - so
 * requirePermission's callers for those two actions
 * (handleBillingCreateOrder, handleBillingVerify in
 * api/campaigns/handler.ts) pass { allowWhenBlocked: true } rather than
 * this function ever special-casing a resource/action string itself.
 */
export async function isAccountLockedOut(companyId: string): Promise<boolean> {
  return computeEntitlementBlocked(companyId);
}

/** Extra slots only count while the paid-for cycle is still in the future -
 * lazily checked here (compared to now() at read time), never swept by a
 * background job - same posture as every other lazily-resolved status
 * column in this codebase (see companies.extraCapacityExpiresAt's own
 * comment in schema.ts). */
function activeExtraSlots(company: { extraCampaignSlots: number; extraClientSlots: number; extraCapacityExpiresAt: Date | string | null }) {
  if (!company.extraCapacityExpiresAt) return { extraCampaigns: 0, extraClients: 0 };
  if (new Date(company.extraCapacityExpiresAt).getTime() <= Date.now()) return { extraCampaigns: 0, extraClients: 0 };
  return { extraCampaigns: company.extraCampaignSlots, extraClients: company.extraClientSlots };
}

export interface CampaignLimitStatus {
  accountType: AccountType;
  rootCompanyId: string;
  used: number;
  baseLimit: number;
  extra: number;
  limit: number;
  remaining: number;
}

/**
 * Campaign-count status for whichever company `companyId` resolves to.
 * Agency pooling: the pool is the agency's OWN company plus every client it
 * currently claims (same CLAIMED_AGENCY_CLIENT_STATUSES roster used
 * everywhere else an agency's book is counted) - deliberately including
 * the agency's own company, since nothing stops an agency user from
 * creating a campaign directly under their own company without ever
 * entering a client context, and "10 campaigns total" on the marketing
 * page is framed as a total across the whole book, not just clients.
 * Excluding the agency's own company would be a loophole, not a feature.
 */
export async function getCampaignLimitStatus(companyId: string): Promise<CampaignLimitStatus> {
  const { rootCompanyId, accountType } = await resolvePoolRootCompanyId(companyId);
  const rootCompany = await getCompanyById(rootCompanyId);
  if (!rootCompany) throw new AuthError("Company not found.", 404);

  let used: number;
  if (accountType === "agency") {
    const claimed = await listClaimedClientOrganizations(rootCompanyId);
    const poolCompanyIds = [rootCompanyId, ...claimed.map((c) => c.clientCompanyId)];
    used = (await listCampaignsForCompanies(poolCompanyIds)).length;
  } else {
    used = (await listCampaigns(rootCompanyId)).length;
  }

  const { extraCampaigns } = activeExtraSlots(rootCompany);
  const baseLimit = baseCampaignLimit(accountType);
  // Trial-aware: during an active trial this overrides baseLimit+extra down
  // to TRIAL_CAMPAIGN_LIMIT (1); once trial_expired/subscription_expired it
  // is pinned to `used` (blocking new creation while leaving existing
  // campaigns untouched) - see effectiveCampaignLimit's own doc comment in
  // src/domain/trial.ts. Only genuinely "subscribed" resolves to the
  // ordinary paid baseLimit + extra overage, exactly as before this
  // feature existed.
  const entitlement = resolveEntitlementState(rootCompany);
  const limit = effectiveCampaignLimit(entitlement, baseLimit + extraCampaigns, used);

  return { accountType, rootCompanyId, used, baseLimit, extra: extraCampaigns, limit, remaining: Math.max(0, limit - used) };
}

/** Called right before a new campaign is actually inserted (see
 * api/campaigns/handler.ts's handleCollection POST branch) - throws
 * LimitExceededError (402) rather than returning a boolean, so the caller
 * can't accidentally forget to check a return value and create the
 * campaign anyway. */
export async function assertCampaignLimitNotReached(companyId: string): Promise<void> {
  const status = await getCampaignLimitStatus(companyId);
  if (status.used >= status.limit) {
    throw new LimitExceededError(
      `You've reached your plan's campaign limit (${status.limit}). Add extra capacity to create another campaign.`,
      "campaign_limit_reached",
      { used: status.used, limit: status.limit },
    );
  }
}

export interface ClientLimitStatus {
  used: number;
  baseLimit: number;
  extra: number;
  limit: number;
  remaining: number;
}

/** Agency-only. Unlike getCampaignLimitStatus, this is always called with
 * the AGENCY's own real companyId directly (from api/admin/users/
 * handler.ts's client-add/invite actions, which - per
 * agencyClientContext.ts's own documented rule - never run through
 * withEffectiveCompanyContext) - there is no "resolve pool root" step
 * needed here, a client can never itself add another client. */
export async function getClientLimitStatus(agencyCompanyId: string): Promise<ClientLimitStatus> {
  const company = await getCompanyById(agencyCompanyId);
  if (!company) throw new AuthError("Company not found.", 404);

  const claimed = await listClaimedClientOrganizations(agencyCompanyId);
  const used = claimed.length;
  const { extraClients } = activeExtraSlots(company);
  // Trial-aware, same rule as getCampaignLimitStatus above - see
  // effectiveClientLimit's own doc comment in src/domain/trial.ts.
  const entitlement = resolveEntitlementState(company);
  const limit = effectiveClientLimit(entitlement, BASE_CLIENT_LIMIT_AGENCY + extraClients, used);

  return { used, baseLimit: BASE_CLIENT_LIMIT_AGENCY, extra: extraClients, limit, remaining: Math.max(0, limit - used) };
}

/** Called right before addClientOrganization/inviteExistingClient (see
 * api/admin/users/handler.ts's handleAgencyClientsCollection POST and
 * handleAgencyInviteClient) actually link a new client. */
export async function assertClientLimitNotReached(agencyCompanyId: string): Promise<void> {
  const status = await getClientLimitStatus(agencyCompanyId);
  if (status.used >= status.limit) {
    throw new LimitExceededError(
      `You've reached your plan's client limit (${status.limit}). Add extra capacity to add another client.`,
      "client_limit_reached",
      { used: status.used, limit: status.limit },
    );
  }
}

export interface CapacityDowngradeResult {
  campaignsPaused: number;
  clientsSuspended: number;
}

/**
 * Phase 14 - "never delete data on downgrade, mark excess inactive
 * instead." A "downgrade" is any moment where a root company's existing
 * campaign/client count exceeds its CURRENTLY effective limit - in
 * practice, almost always a paid extra-capacity cycle expiring (see
 * activeExtraSlots above), since nothing in this app yet lets a company
 * reduce its own base plan directly. Uses the exact same pooled `used`
 * definitions as getCampaignLimitStatus/getClientLimitStatus (agency
 * campaigns pool across every currently-claimed client; client count is
 * the agency's own claimed-client list) so a company is never downgraded
 * against a different notion of "used" than the one that blocks its new
 * creation.
 *
 * Deliberately NOT called from any read path (getBillingStatus,
 * getCampaignLimitStatus, /api/auth/me, etc.) - those stay pure/lazy with
 * zero side effects, matching activeExtraSlots's own documented posture.
 * This is a write, so it only ever runs from the existing reconciliation
 * sweep (src/application/reconcile.ts), the same place this codebase
 * already puts every other periodic self-healing check (token refresh,
 * unenqueued-event retries). Idempotent - re-running against an
 * already-downgraded company is a no-op (see selectExcessForDowngrade's
 * own doc comment) - so it is always safe to call on every sweep for
 * every root company, not just ones suspected of having just downgraded.
 *
 * "Inactive" reuses each row's OWN existing status vocabulary rather than
 * a new column: a paused campaign (`campaigns.status = "paused"`, the same
 * status a tenant could set themselves from the Campaign page) or a
 * suspended client relationship (`agency_clients.status = "suspended"`,
 * the same status setClientRelationshipStatus already uses for a manual
 * suspend). Nothing is ever deleted, and every row this touches keeps its
 * full history and data - re-subscribing/buying more capacity does not
 * automatically reactivate them (same as a tenant's own manual pause), but
 * nothing here or anywhere else in this codebase ever removes the data
 * itself.
 */
export async function reconcileCapacityDowngrade(rootCompanyId: string): Promise<CapacityDowngradeResult> {
  const rootCompany = await getCompanyById(rootCompanyId);
  if (!rootCompany) return { campaignsPaused: 0, clientsSuspended: 0 };

  const accountType = resolveAccountType(rootCompany.accountType);
  const entitlement = resolveEntitlementState(rootCompany);
  const { extraCampaigns, extraClients } = activeExtraSlots(rootCompany);

  // --- Campaigns (pooled the same way getCampaignLimitStatus pools them) ---
  let campaignRows: Awaited<ReturnType<typeof listCampaigns>>;
  let claimed: Awaited<ReturnType<typeof listClaimedClientOrganizations>> = [];
  if (accountType === "agency") {
    claimed = await listClaimedClientOrganizations(rootCompanyId);
    const poolCompanyIds = [rootCompanyId, ...claimed.map((c) => c.clientCompanyId)];
    campaignRows = await listCampaignsForCompanies(poolCompanyIds);
  } else {
    campaignRows = await listCampaigns(rootCompanyId);
  }

  const campaignLimit = effectiveCampaignLimit(entitlement, baseCampaignLimit(accountType) + extraCampaigns, campaignRows.length);
  const campaignCandidates: DowngradeCandidate[] = campaignRows.map((c) => ({
    id: c.id,
    createdAt: c.createdAt,
    isActive: c.status !== "paused" && c.status !== "archived",
  }));
  const campaignsToPause = selectExcessForDowngrade(campaignCandidates, campaignLimit);
  for (const campaignId of campaignsToPause) {
    const row = campaignRows.find((c) => c.id === campaignId);
    if (row) await updateCampaign(row.companyId, campaignId, { status: "paused" });
  }

  // --- Clients (agency only - the relationship itself, not that client's
  // own campaigns, which the pooled count above already covers) ---
  let clientsSuspended = 0;
  if (accountType === "agency") {
    const clientLimit = effectiveClientLimit(entitlement, BASE_CLIENT_LIMIT_AGENCY + extraClients, claimed.length);
    const clientCandidates: DowngradeCandidate[] = claimed.map((c) => ({
      id: c.clientCompanyId,
      createdAt: c.linkedAt,
      isActive: c.relationshipStatus === "active" || c.relationshipStatus === "invited" || c.relationshipStatus === "pending",
    }));
    const clientsToSuspend = selectExcessForDowngrade(clientCandidates, clientLimit);
    for (const clientCompanyId of clientsToSuspend) {
      await setAgencyClientStatus(rootCompanyId, clientCompanyId, "suspended");
      // System-automated suspension - agencyUserId is deliberately null
      // here, a legitimate third case alongside the two documented in
      // agencyAuditLog.ts's own header comment (always-the-actor /
      // null-for-a-non-agency-actor): there is no human actor at all for
      // this transition, so null plus an explicit "Automatically" detail
      // string is the honest record, never attributed to whichever agency
      // user happens to be logged in when the sweep runs.
      await recordAgencyAuditEvent({
        agencyCompanyId: rootCompanyId,
        action: "CLIENT_SUSPENDED",
        agencyUserId: null,
        clientCompanyId,
        detail: `Automatically suspended: plan capacity decreased to ${clientLimit} and this was among the newest clients beyond the new limit.`,
      });
    }
    clientsSuspended = clientsToSuspend.length;
  }

  return { campaignsPaused: campaignsToPause.length, clientsSuspended };
}

// ---------------------------------------------------------------------------
// /subscription.html - status + purchase flow
// ---------------------------------------------------------------------------

export interface BillingStatus {
  accountType: AccountType;
  // true when the caller's own company is a claimed CLIENT of some agency
  // - extra capacity for their account is that agency's to buy, not
  // theirs; /subscription.html shows a read-only "contact your agency"
  // message instead of a purchase flow in this case (see
  // createOverageOrder's own guard, which independently refuses to create
  // an order for a non-root company either way).
  managedExternally: boolean;
  // The 15-day trial / paid-base-plan state (see src/domain/trial.ts) -
  // what drives /subscription.html's trial banner and the "Subscribe to
  // your plan" purchase flow below. Always the ROOT company's own state
  // (see resolvePoolRootCompanyId) - a claimed client is always
  // "subscribed" in its own right (it never has a plan of its own), the
  // AGENCY's trial/subscription is what actually governs.
  entitlement: SerializedEntitlementState;
  campaigns: CampaignLimitStatus;
  clients: ClientLimitStatus | null;
  currentCycle: { cycle: BillingCycle | null; expiresAt: string | null } | null;
  overage: {
    kind: OverageKind;
    unitLabel: string;
    pricing: Array<{ cycle: BillingCycle; label: string; unitAmountInPaise: number; discountPct: number }>;
  };
  // Present only while the root company is not yet "subscribed" (trialing,
  // trial_expired, or subscription_expired) - the base-plan purchase flow
  // (createBaseSubscriptionOrder below) that converts a trial (or lapsed
  // subscription) into an active paid plan. Null once already subscribed -
  // /subscription.html shows the ordinary "Add extra capacity" purchase
  // card instead in that case.
  subscribe: {
    pricing: Array<{ cycle: BillingCycle; label: string; amountInPaise: number; discountPct: number }>;
  } | null;
}

export async function getBillingStatus(companyId: string): Promise<BillingStatus> {
  const { rootCompanyId, accountType } = await resolvePoolRootCompanyId(companyId);
  const managedExternally = rootCompanyId !== companyId;

  const campaigns = await getCampaignLimitStatus(companyId);
  const clients = accountType === "agency" ? await getClientLimitStatus(rootCompanyId) : null;

  const rootCompany = await getCompanyById(rootCompanyId);
  const currentCycle = rootCompany
    ? {
        cycle: (rootCompany.extraCapacityCycle as BillingCycle | null) ?? null,
        expiresAt: rootCompany.extraCapacityExpiresAt ? new Date(rootCompany.extraCapacityExpiresAt).toISOString() : null,
      }
    : null;

  const entitlementState = rootCompany ? resolveEntitlementState(rootCompany) : { kind: "subscribed" as const, expiresAt: null };
  const entitlement = serializeEntitlementState(entitlementState);

  const kind = overageKindForAccountType(accountType);
  return {
    accountType,
    managedExternally,
    entitlement,
    campaigns,
    clients,
    currentCycle,
    overage: {
      kind,
      unitLabel: kind === "agency_bundles" ? "bundle (1 client + 2 campaigns)" : "campaign",
      pricing: BILLING_CYCLE_KEYS.map((cycle) => ({
        cycle,
        label: CYCLE_LABELS[cycle],
        unitAmountInPaise: computeOverageAmountInPaise(kind, 1, cycle),
        discountPct: Math.round(CYCLE_DISCOUNT[cycle] * 100),
      })),
    },
    subscribe:
      entitlementState.kind === "subscribed"
        ? null
        : {
            pricing: BILLING_CYCLE_KEYS.map((cycle) => ({
              cycle,
              label: CYCLE_LABELS[cycle],
              amountInPaise: computeBaseSubscriptionAmountInPaise(accountType, cycle),
              discountPct: Math.round(CYCLE_DISCOUNT[cycle] * 100),
            })),
          },
  };
}

/**
 * Lean read used by /api/auth/me (see api/auth/handler.ts's handleMe) to
 * power the trial banner shown on every protected page (App.renderTrialBanner
 * in public/assets/app.js) - the same entitlement/usage numbers
 * getBillingStatus computes for /subscription.html, without that
 * function's overage/subscribe pricing catalogs (irrelevant to a nav
 * banner). Always resolves against the caller's own REAL company
 * (never an active agency client context - see handleMe's own comment on
 * why billing/entitlement is deliberately not run through
 * withEffectiveCompanyContext), same as every other billing function in
 * this file.
 */
export interface EntitlementSummary {
  accountType: AccountType;
  entitlement: SerializedEntitlementState;
  campaigns: { used: number; limit: number };
  clients: { used: number; limit: number } | null;
}

export async function getEntitlementSummary(companyId: string): Promise<EntitlementSummary> {
  const { rootCompanyId, accountType } = await resolvePoolRootCompanyId(companyId);
  const campaigns = await getCampaignLimitStatus(companyId);
  const clients = accountType === "agency" ? await getClientLimitStatus(rootCompanyId) : null;
  const rootCompany = await getCompanyById(rootCompanyId);
  const entitlementState = rootCompany ? resolveEntitlementState(rootCompany) : { kind: "subscribed" as const, expiresAt: null };

  return {
    accountType,
    entitlement: serializeEntitlementState(entitlementState),
    campaigns: { used: campaigns.used, limit: campaigns.limit },
    clients: clients ? { used: clients.used, limit: clients.limit } : null,
  };
}

/** Starts a purchase: computes the price, creates a Razorpay Order, and
 * records a "created" billing_orders row before any money has moved - see
 * billingOrders' own doc comment in schema.ts for the full lifecycle. */
export async function createOverageOrder(input: {
  companyId: string;
  createdBy: string;
  quantity: number;
  cycle: BillingCycle;
}): Promise<{ orderId: string; razorpayOrderId: string; amountInPaise: number; currency: string; keyId: string }> {
  const { rootCompanyId, accountType } = await resolvePoolRootCompanyId(input.companyId);
  if (rootCompanyId !== input.companyId) {
    throw new AuthError("Extra capacity for your account is managed by your agency - ask them to purchase it.", 403);
  }

  const kind = overageKindForAccountType(accountType);
  const amountInPaise = computeOverageAmountInPaise(kind, input.quantity, input.cycle);
  const localId = randomUUID();

  const razorpayOrder = await createRazorpayOrder({
    amountInPaise,
    currency: "INR",
    receipt: localId,
    notes: { companyId: rootCompanyId, kind, quantity: String(input.quantity), cycle: input.cycle },
  });

  await insertBillingOrder({
    id: localId,
    companyId: rootCompanyId,
    createdBy: input.createdBy,
    kind,
    quantity: input.quantity,
    cycle: input.cycle,
    amountInPaise,
    currency: "INR",
    razorpayOrderId: razorpayOrder.id,
  });

  return {
    orderId: localId,
    razorpayOrderId: razorpayOrder.id,
    amountInPaise,
    currency: "INR",
    keyId: process.env.RAZORPAY_KEY_ID ?? "",
  };
}

/**
 * Starts the trial -> paid conversion (or a lapsed subscription's renewal) -
 * the base-plan counterpart to createOverageOrder above. Always quantity 1
 * (a company has exactly one base plan). Same root-company-only guard as
 * createOverageOrder: a claimed client can never subscribe on its own
 * behalf, only the agency (or a self-standing Individual) can.
 */
export async function createBaseSubscriptionOrder(input: {
  companyId: string;
  createdBy: string;
  cycle: BillingCycle;
}): Promise<{ orderId: string; razorpayOrderId: string; amountInPaise: number; currency: string; keyId: string }> {
  const { rootCompanyId, accountType } = await resolvePoolRootCompanyId(input.companyId);
  if (rootCompanyId !== input.companyId) {
    throw new AuthError("Your plan is managed by your agency - ask them to subscribe.", 403);
  }

  const amountInPaise = computeBaseSubscriptionAmountInPaise(accountType, input.cycle);
  const localId = randomUUID();

  const razorpayOrder = await createRazorpayOrder({
    amountInPaise,
    currency: "INR",
    receipt: localId,
    notes: { companyId: rootCompanyId, kind: BASE_SUBSCRIPTION_KIND, quantity: "1", cycle: input.cycle },
  });

  await insertBillingOrder({
    id: localId,
    companyId: rootCompanyId,
    createdBy: input.createdBy,
    kind: BASE_SUBSCRIPTION_KIND,
    quantity: 1,
    cycle: input.cycle,
    amountInPaise,
    currency: "INR",
    razorpayOrderId: razorpayOrder.id,
  });

  return {
    orderId: localId,
    razorpayOrderId: razorpayOrder.id,
    amountInPaise,
    currency: "INR",
    keyId: process.env.RAZORPAY_KEY_ID ?? "",
  };
}

/** Branches on the order's own stored `kind` (see PurchaseKind in
 * src/domain/billing.ts) - a base_subscription order converts the company
 * to an active paid plan (applyBaseSubscriptionPurchase), while either
 * overage kind (individual_campaigns/agency_bundles, the only other values
 * ever written to billingOrders.kind) grants extra capacity on top of an
 * already-active plan, exactly as before this feature existed. */
async function applyPaidOrder(order: { companyId: string; kind: string; quantity: number; cycle: string }) {
  if ((order.kind as PurchaseKind) === BASE_SUBSCRIPTION_KIND) {
    await applyBaseSubscriptionPurchase(order.companyId, {
      cycle: order.cycle,
      expiresAt: cycleEndDate(order.cycle as BillingCycle),
    });
    return;
  }
  const { extraCampaigns, extraClients } = overageSlotsForQuantity(order.kind as OverageKind, order.quantity);
  await applyOverageCapacityPurchase(order.companyId, {
    extraCampaigns,
    extraClients,
    cycle: order.cycle,
    expiresAt: cycleEndDate(order.cycle as BillingCycle),
  });
}

/** The BROWSER round-trip confirmation path - Checkout.js's own success
 * callback POSTs here with the completed payment's id+signature. */
export async function verifyAndApplyOveragePayment(input: {
  companyId: string;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): Promise<{ applied: boolean; alreadyProcessed: boolean }> {
  const order = await getBillingOrderByRazorpayOrderId(input.razorpayOrderId);
  if (!order) throw new AuthError("Order not found.", 404);
  if (order.companyId !== input.companyId) throw new AuthError("This order does not belong to your company.", 403);

  if (!verifyRazorpayPaymentSignature(input.razorpayOrderId, input.razorpayPaymentId, input.razorpaySignature)) {
    throw new AuthError("Payment signature verification failed.", 400);
  }

  const won = await markBillingOrderPaid(input.razorpayOrderId, {
    razorpayPaymentId: input.razorpayPaymentId,
    razorpaySignature: input.razorpaySignature,
    via: "verify",
  });

  if (won) {
    await applyPaidOrder(order);
  }

  return { applied: true, alreadyProcessed: !won };
}

/** The WEBHOOK confirmation path (payment.captured) - the authoritative
 * fallback for when the browser round-trip above never completes. Silently
 * no-ops for an order id it doesn't recognize (not ours, or a stale/
 * malformed event) rather than erroring - Razorpay retries webhooks on any
 * non-2xx, and an unrecognized order id is never going to become
 * recognized on retry. */
export async function confirmOveragePaymentFromWebhook(input: { razorpayOrderId: string; razorpayPaymentId: string }): Promise<void> {
  const order = await getBillingOrderByRazorpayOrderId(input.razorpayOrderId);
  if (!order) return;

  if (order.status === "created") {
    const won = await markBillingOrderPaid(input.razorpayOrderId, {
      razorpayPaymentId: input.razorpayPaymentId,
      // The webhook carries no browser-side signature triple of its own -
      // the webhook's OWN HMAC (already verified by the caller, see
      // api/webhooks/meta/handler.ts's razorpay-webhook branch) is the
      // trust boundary for this confirmation path.
      razorpaySignature: null,
      via: "webhook",
    });
    if (won) {
      await applyPaidOrder(order);
      return;
    }
  }

  // Already paid (the browser round-trip won the race) - just record that
  // the webhook independently confirmed it too, for the audit trail.
  await stampBillingOrderWebhookConfirmed(input.razorpayOrderId);
}
