import { desc, eq, sql } from "drizzle-orm";
import { getDb } from "../client";
import { billingOrders } from "../schema";
import { firstOrThrow } from "../util";

// ---- Billing / overage orders --------------------------------------------
// See billingOrders' own doc comment in schema.ts for the full created ->
// paid lifecycle these functions implement.

export async function insertBillingOrder(input: {
  id: string;
  companyId: string;
  createdBy: string | null;
  kind: string;
  quantity: number;
  cycle: string;
  amountInPaise: number;
  currency: string;
  razorpayOrderId: string;
}) {
  const db = await getDb();
  const rows = await db.insert(billingOrders).values({ ...input, status: "created" }).returning();
  return firstOrThrow(rows);
}

export async function getBillingOrderByRazorpayOrderId(razorpayOrderId: string) {
  const db = await getDb();
  const [row] = await db.select().from(billingOrders).where(eq(billingOrders.razorpayOrderId, razorpayOrderId)).limit(1);
  return row ?? null;
}

/** Platform Admin "Subscriptions" full billing management - looked up by
 * this app's own id (never razorpayOrderId - that column is what the two
 * PAYMENT confirmation paths join on; an admin acting from
 * public/admin/subscriptions.html always has this row's own id already,
 * from listBillingOrdersForCompany's own output). */
export async function getBillingOrderById(id: string) {
  const db = await getDb();
  const [row] = await db.select().from(billingOrders).where(eq(billingOrders.id, id)).limit(1);
  return row ?? null;
}

export async function listBillingOrdersForCompany(companyId: string) {
  const db = await getDb();
  return db
    .select({
      id: billingOrders.id,
      kind: billingOrders.kind,
      quantity: billingOrders.quantity,
      cycle: billingOrders.cycle,
      amountInPaise: billingOrders.amountInPaise,
      currency: billingOrders.currency,
      razorpayOrderId: billingOrders.razorpayOrderId,
      razorpayPaymentId: billingOrders.razorpayPaymentId,
      status: billingOrders.status,
      verifiedAt: billingOrders.verifiedAt,
      webhookConfirmedAt: billingOrders.webhookConfirmedAt,
      refundedAt: billingOrders.refundedAt,
      refundAmountInPaise: billingOrders.refundAmountInPaise,
      refundReason: billingOrders.refundReason,
      createdAt: billingOrders.createdAt,
    })
    .from(billingOrders)
    .where(eq(billingOrders.companyId, companyId))
    .orderBy(desc(billingOrders.createdAt));
}

/** Confirms a captured payment and applies its entitlement atomically. */
export async function markBillingOrderPaidAndApply(input: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string | null;
  via: "verify" | "webhook";
  expiresAt: Date;
}) {
  const db = await getDb();
  const rows = await db.execute(sql`
    WITH paid_order AS (
      UPDATE "crm"."billing_orders"
      SET
        status = 'paid',
        razorpay_payment_id = ${input.razorpayPaymentId},
        razorpay_signature = ${input.razorpaySignature},
        verified_at = CASE WHEN ${input.via} = 'verify' THEN now() ELSE verified_at END,
        webhook_confirmed_at = CASE WHEN ${input.via} = 'webhook' THEN now() ELSE webhook_confirmed_at END,
        updated_at = now()
      WHERE razorpay_order_id = ${input.razorpayOrderId}
        AND status = 'created'
      RETURNING *
    ), updated_company AS (
      UPDATE "crm"."companies" AS company
      SET
        subscription_status = CASE WHEN paid.kind = 'base_subscription' THEN 'active' ELSE company.subscription_status END,
        subscription_cycle = CASE WHEN paid.kind = 'base_subscription' THEN paid.cycle ELSE company.subscription_cycle END,
        subscription_expires_at = CASE
          WHEN paid.kind <> 'base_subscription' THEN company.subscription_expires_at
          WHEN company.subscription_status = 'active'
            AND company.subscription_expires_at IS NOT NULL
            AND company.subscription_expires_at > ${input.expiresAt}
          THEN company.subscription_expires_at
          ELSE ${input.expiresAt}
        END,
        extra_campaign_slots = CASE
          WHEN paid.kind = 'base_subscription' THEN company.extra_campaign_slots
          WHEN company.extra_capacity_expires_at IS NOT NULL AND company.extra_capacity_expires_at > now()
          THEN company.extra_campaign_slots + CASE WHEN paid.kind = 'agency_bundles' THEN paid.quantity * 2 ELSE paid.quantity END
          ELSE CASE WHEN paid.kind = 'agency_bundles' THEN paid.quantity * 2 ELSE paid.quantity END
        END,
        extra_client_slots = CASE
          WHEN paid.kind = 'base_subscription' THEN company.extra_client_slots
          WHEN company.extra_capacity_expires_at IS NOT NULL AND company.extra_capacity_expires_at > now()
          THEN company.extra_client_slots + CASE WHEN paid.kind = 'agency_bundles' THEN paid.quantity ELSE 0 END
          ELSE CASE WHEN paid.kind = 'agency_bundles' THEN paid.quantity ELSE 0 END
        END,
        extra_capacity_cycle = CASE WHEN paid.kind = 'base_subscription' THEN company.extra_capacity_cycle ELSE paid.cycle END,
        extra_capacity_expires_at = CASE
          WHEN paid.kind = 'base_subscription' THEN company.extra_capacity_expires_at
          WHEN company.extra_capacity_expires_at IS NOT NULL AND company.extra_capacity_expires_at > ${input.expiresAt}
          THEN company.extra_capacity_expires_at
          ELSE ${input.expiresAt}
        END,
        updated_at = now()
      FROM paid_order AS paid
      WHERE company.id = paid.company_id
      RETURNING company.id
    )
    SELECT id FROM updated_company
  `);
  return Array.isArray(rows) ? rows.length > 0 : rows.rows.length > 0;
}

/** Webhook-only: stamps webhookConfirmedAt on an order the BROWSER
 * round-trip already won the created->paid race for (see
 * markBillingOrderPaid's own comment) - an audit-trail fact ("Razorpay
 * itself also independently confirmed this payment"), not a capacity
 * grant (that already happened when the row was first marked paid). */
export async function stampBillingOrderWebhookConfirmed(razorpayOrderId: string) {
  const db = await getDb();
  await db.update(billingOrders).set({ webhookConfirmedAt: new Date(), updatedAt: new Date() }).where(eq(billingOrders.razorpayOrderId, razorpayOrderId));
}

/** Platform Admin "Subscriptions" full billing management - records that an
 * admin has marked one specific payment order refunded. Gated on
 * status = 'paid' AND refunded_at IS NULL, same conditional-UPDATE shape as
 * markBillingOrderPaidAndApply's own "WHERE status = 'created'" guard -
 * never marks an unpaid order refunded, and never lets a second refund
 * attempt silently overwrite the first refund's own recorded amount/reason/
 * admin. Returns null (no row updated) if either guard fails, so the
 * caller (refundPaymentOrder, src/application/platformAdmin.ts) can turn
 * that into a real 404/409 rather than silently reporting success. See
 * this column's own doc comment in schema.ts - this is an audit-trail
 * fact, never a live call to Razorpay's Refunds API. */
export async function markBillingOrderRefunded(input: {
  id: string;
  refundAmountInPaise: number;
  refundReason: string | null;
  refundedBy: string;
}) {
  const db = await getDb();
  const rows = await db
    .update(billingOrders)
    .set({
      refundedAt: new Date(),
      refundAmountInPaise: input.refundAmountInPaise,
      refundReason: input.refundReason,
      refundedBy: input.refundedBy,
      updatedAt: new Date(),
    })
    .where(sql`${billingOrders.id} = ${input.id} AND ${billingOrders.status} = 'paid' AND ${billingOrders.refundedAt} IS NULL`)
    .returning();
  return rows[0] ?? null;
}
