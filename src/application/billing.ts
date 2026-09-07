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
  baseCampaignLimit,
  computeOverageAmountInPaise,
  cycleEndDate,
  overageKindForAccountType,
  overageSlotsForQuantity,
  CYCLE_DISCOUNT,
  CYCLE_LABELS,
  BILLING_CYCLE_KEYS,
  type BillingCycle,
  type OverageKind,
} from "../domain/billing";
import { getCompanyById, applyOverageCapacityPurchase } from "../infrastructure/db/repositories/tenancy";
import { listClaimedClientOrganizations, getClaimingAgencyForClient } from "../infrastructure/db/repositories/organizations";
import { listCampaigns, listCampaignsForCompanies } from "../infrastructure/db/repositories/campaigns";
import {
  getBillingOrderByRazorpayOrderId,
  insertBillingOrder,
  markBillingOrderPaid,
  stampBillingOrderWebhookConfirmed,
} from "../infrastructure/db/repositories/billing";
import { createRazorpayOrder, verifyRazorpayPaymentSignature } from "../infrastructure/razorpay/client";
import { randomUUID } from "node:crypto";

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
  const limit = baseLimit + extraCampaigns;

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
  const limit = BASE_CLIENT_LIMIT_AGENCY + extraClients;

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
  campaigns: CampaignLimitStatus;
  clients: ClientLimitStatus | null;
  currentCycle: { cycle: BillingCycle | null; expiresAt: string | null } | null;
  overage: {
    kind: OverageKind;
    unitLabel: string;
    pricing: Array<{ cycle: BillingCycle; label: string; unitAmountInPaise: number; discountPct: number }>;
  };
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

  const kind = overageKindForAccountType(accountType);
  return {
    accountType,
    managedExternally,
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

async function applyPaidOrder(order: { companyId: string; kind: string; quantity: number; cycle: string }) {
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
