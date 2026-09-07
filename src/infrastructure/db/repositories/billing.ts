import { and, eq } from "drizzle-orm";
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

/** The idempotent created -> paid transition. Both the client-side verify
 * call and the later webhook race to call this for the same order - the
 * `WHERE status = 'created'` makes it a conditional UPDATE, so only the
 * FIRST caller to reach it actually flips the row (and, in the caller's
 * own code, actually grants capacity); the second gets back `null` and
 * knows to treat this as a no-op rather than double-granting. Never
 * separate a "read status" check from this UPDATE in caller code - that
 * would reopen exactly the race this function exists to close. */
export async function markBillingOrderPaid(
  razorpayOrderId: string,
  input: { razorpayPaymentId: string; razorpaySignature: string | null; via: "verify" | "webhook" },
) {
  const db = await getDb();
  const rows = await db
    .update(billingOrders)
    .set({
      status: "paid",
      razorpayPaymentId: input.razorpayPaymentId,
      razorpaySignature: input.razorpaySignature,
      ...(input.via === "verify" ? { verifiedAt: new Date() } : { webhookConfirmedAt: new Date() }),
      updatedAt: new Date(),
    })
    .where(and(eq(billingOrders.razorpayOrderId, razorpayOrderId), eq(billingOrders.status, "created")))
    .returning();
  return rows[0] ?? null;
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
