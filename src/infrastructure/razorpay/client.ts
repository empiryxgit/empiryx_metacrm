// Thin Razorpay REST client - Orders API only. Checkout.js (loaded
// client-side on public/subscription.html) handles the actual card/UPI/
// netbanking collection, so raw payment credentials never reach this
// server - all this file ever sees is an order id, a payment id, and a
// signature to verify (see verifyRazorpayPaymentSignature/
// verifyRazorpayWebhookSignature below), never card numbers, CVVs, or UPI
// PINs. No official `razorpay` npm package dependency: the surface area
// this project actually needs (create an order, verify two signature
// shapes) is a handful of lines, so a plain fetch-based client keeps this
// project's existing "no unnecessary complexity" posture (see
// package.json's own short dependency list) rather than pulling in an SDK
// and its own dependency tree for that.
//
// Credentials: RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET (Dashboard -> Settings
// -> API Keys) authenticate the Orders API call below via HTTP Basic Auth.
// RAZORPAY_WEBHOOK_SECRET (Dashboard -> Settings -> Webhooks - a SEPARATE
// secret from the Key Secret) verifies the webhook in
// verifyRazorpayWebhookSignature. All three are read directly from
// process.env - set as Vercel Environment Variables, never typed into this
// codebase or handled anywhere in chat/tooling.

import { createHmac, timingSafeEqual } from "node:crypto";

export class RazorpayConfigError extends Error {}

function getApiCredentials(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new RazorpayConfigError("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured.");
  }
  return { keyId, keySecret };
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
}

/** Creates a Razorpay Order for `amountInPaise` (Razorpay's own
 * smallest-unit convention, same as Stripe cents) - the id this returns is
 * what Checkout.js opens client-side; nothing else about the payment
 * itself ever touches this server. `receipt` is our own billing_orders.id,
 * threaded through so Razorpay's own dashboard/webhook payload can be
 * cross-referenced back to that row without a second query, and `notes`
 * carries the same context for the same reason (visible in the Razorpay
 * Dashboard for manual reconciliation if it's ever needed). */
export async function createRazorpayOrder(input: {
  amountInPaise: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  const { keyId, keySecret } = getApiCredentials();
  const res = await fetch("https://api.razorpay.com/v1/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`,
    },
    body: JSON.stringify({
      amount: input.amountInPaise,
      currency: input.currency,
      receipt: input.receipt,
      notes: input.notes ?? {},
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; amount?: number; currency?: string; status?: string; error?: { description?: string } };
  if (!res.ok || !data.id) {
    throw new Error(`Razorpay order creation failed: ${data?.error?.description || `HTTP ${res.status}`}`);
  }
  return { id: data.id, amount: data.amount ?? input.amountInPaise, currency: data.currency ?? input.currency, status: data.status ?? "created" };
}

/** Verifies the razorpay_order_id / razorpay_payment_id / razorpay_signature
 * triple Checkout.js hands back to the browser on a successful payment
 * (Razorpay's documented "Step 6: Verify payment signature") - HMAC-SHA256
 * of "orderId|paymentId" keyed with the Key Secret. Same shape as
 * verifyMetaSignature (src/infrastructure/meta/verifySignature.ts):
 * timingSafeEqual after an equal-length check, never a plain string
 * comparison. */
export function verifyRazorpayPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  const { keySecret } = getApiCredentials();
  const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeHexEqual(expected, signature);
}

/** Verifies an incoming Razorpay WEBHOOK request's X-Razorpay-Signature
 * header - HMAC-SHA256 of the RAW request body, keyed with the separate
 * Webhook Secret (RAZORPAY_WEBHOOK_SECRET) configured in the Razorpay
 * Dashboard's Webhooks screen - deliberately not the Key Secret used
 * above. Identical shape to verifyMetaSignature, reused here rather than
 * duplicated inline. MUST run against the raw, unparsed body - see
 * api/webhooks/meta/handler.ts's own file-wide `bodyParser: false`. */
export function verifyRazorpayWebhookSignature(rawBody: string, signatureHeader: string | null | undefined): boolean {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret || !signatureHeader) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody, "utf8").digest("hex");
  return safeHexEqual(expected, signatureHeader);
}

function safeHexEqual(expectedHex: string, providedHex: string): boolean {
  let expectedBuf: Buffer;
  let providedBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expectedHex, "hex");
    providedBuf = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length === 0 || expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
