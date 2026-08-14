// The "worker". Invoked by QStash over HTTP, not by a persistent consumer -
// this is the piece of the architecture that replaces a traditional message
// broker consumer, and it's what makes the whole pipeline run on Vercel's
// serverless model instead of an always-on process.
//
// QStash's own retry policy (configured at publish time - see
// src/infrastructure/queue/qstash.ts) re-invokes this endpoint with
// exponential backoff whenever it returns a non-2xx status or times out.
// After the configured retry count is exhausted, QStash calls the
// failureCallback endpoint (api/internal/dead-letter.ts) instead.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Receiver } from "@upstash/qstash";
import { processLead, RetryableProcessingError } from "../../src/application/processLead";
import { incrementRetryCount, logEvent } from "../../src/infrastructure/db/repositories";

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

function getReceiver(): Receiver {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error("QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY are not set. See .env.example.");
  }
  return new Receiver({ currentSigningKey, nextSigningKey });
}

interface LeadReceivedBody {
  rawEventId: string;
  metaLeadId: string;
  objectType: string;
  companyId: string;
  campaignId: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["upstash-signature"];
  const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

  try {
    const isValid = await getReceiver().verify({
      signature: signatureHeader ?? "",
      body: rawBody,
    });
    if (!isValid) {
      res.status(401).json({ error: "Invalid QStash signature" });
      return;
    }
  } catch (err) {
    console.error("[process-lead] Signature verification failed:", err);
    res.status(401).json({ error: "Invalid QStash signature" });
    return;
  }

  const message = JSON.parse(rawBody) as LeadReceivedBody;
  const attempt = Number(req.headers["upstash-retried"] ?? 0) + 1;

  try {
    const outcome = await processLead(
      message.rawEventId,
      message.metaLeadId,
      message.objectType,
      message.companyId,
      message.campaignId,
    );
    console.log(`[process-lead] ${message.metaLeadId} -> ${outcome} (attempt ${attempt})`);
    res.status(200).json({ outcome });
  } catch (err) {
    const isRetryable = err instanceof RetryableProcessingError;
    const messageText = err instanceof Error ? err.message : String(err);

    console.error(`[process-lead] Attempt ${attempt} failed for ${message.metaLeadId}: ${messageText}`);
    await incrementRetryCount(message.metaLeadId, messageText);
    await logEvent({
      rawEventId: message.rawEventId,
      eventType: "RetryScheduled",
      detail: `Attempt ${attempt} failed: ${messageText}`,
    });

    // Any non-2xx tells QStash to retry with backoff, up to the retries
    // configured at publish time. We distinguish the status only for
    // observability; QStash retries on both 4xx (except a few) and 5xx by
    // default, so 502 is used here to signal "try again" unambiguously.
    res.status(isRetryable ? 502 : 500).json({ error: messageText });
  }
}
