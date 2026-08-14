// Meta Webhooks entry point - one unguessable URL per campaign
// (https://.../api/webhooks/meta/{slug}), because each campaign has its own
// Meta app/page and therefore its own app secret and verify token (see
// webhook_configs, configured from the campaign's "Add webhook" screen).
//
//   GET  -> the one-time subscription verification handshake for THIS
//           campaign's config.
//   POST -> the actual lead notification, verified against THIS campaign's
//           app secret and routed to ingestWebhookPayload with the
//           resolved company/campaign context.
//
// bodyParser is disabled so we can verify X-Hub-Signature-256 against the
// exact bytes Meta sent.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyMetaSignature } from "../../../src/infrastructure/meta/verifySignature";
import { ingestWebhookPayload } from "../../../src/application/ingestWebhook";
import { getWebhookConfigBySlug, markWebhookVerified } from "../../../src/infrastructure/db/repositories/campaigns";

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const slug = req.query.slug as string;
  const webhookConfig = await getWebhookConfigBySlug(slug);

  if (!webhookConfig) {
    // Deliberately generic - do not reveal whether a slug is "close" to a
    // real one.
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (req.method === "GET") {
    // Meta's webhook verification handshake, checked against THIS
    // campaign's own verify token.
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === webhookConfig.verifyToken) {
      await markWebhookVerified(webhookConfig.id);
      res.status(200).send(String(challenge ?? ""));
      return;
    }
    res.status(403).json({ error: "Verification token mismatch" });
    return;
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["x-hub-signature-256"];
  const signatureHeader = (Array.isArray(signature) ? signature[0] : signature) ?? null;

  if (!verifyMetaSignature(rawBody, signatureHeader, webhookConfig.appSecret)) {
    // Do NOT persist unverified payloads - this is the one case where we
    // reject before the durability write, because we cannot trust the body
    // came from Meta at all.
    res.status(401).json({ error: "Invalid signature" });
    return;
  }

  try {
    const result = await ingestWebhookPayload(rawBody, signatureHeader, {
      companyId: webhookConfig.companyId,
      campaignId: webhookConfig.campaignId,
    });
    // Always 200 once the durability write succeeded, even if the enqueue
    // step failed - Meta should not retry-storm us for a problem that is
    // already safely recorded and will self-heal via reconciliation.
    res.status(200).json({ received: result.persisted, enqueued: result.enqueued });
  } catch (err) {
    // Only a genuine failure to persist reaches here - tell Meta to retry.
    console.error("[webhook] Failed to persist incoming event:", err);
    res.status(500).json({ error: "Failed to persist event" });
  }
}
