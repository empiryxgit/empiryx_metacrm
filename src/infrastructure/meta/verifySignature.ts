// Verifies Meta's X-Hub-Signature-256 header (HMAC-SHA256 of the raw request
// body, keyed with THAT CAMPAIGN's own app secret - every campaign has its
// own Meta app/page, hence its own secret; see webhook_configs). This MUST
// run against the raw, unparsed body - see api/webhooks/meta/[slug].ts,
// which disables Vercel's automatic body parsing for exactly this reason.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null | undefined,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }

  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;

  return timingSafeEqual(expectedBuf, providedBuf);
}
