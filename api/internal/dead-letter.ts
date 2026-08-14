// QStash's failureCallback target (see publishLeadReceived). Called exactly
// once, automatically, when a message has exhausted every retry attempt.
// The payload QStash sends wraps the original message body plus metadata
// including `dlqId`, which can be used to inspect or manually redrive the
// message later via QStash's DLQ REST API / dashboard.
//
// This handler does NOT attempt to reprocess the lead - that is
// reconciliation's job, on its own schedule, using the Graph API directly
// rather than replaying a possibly-still-failing message. It only records
// the failure so it is visible in monitoring and on the lead's own row.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Receiver } from "@upstash/qstash";
import { markLeadDeadLettered, logEvent } from "../../src/infrastructure/db/repositories";

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

interface QStashFailureCallbackBody {
  dlqId: string;
  sourceMessageId: string;
  status: number;
  body: string; // base64-encoded original message body
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["upstash-signature"];
  const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (currentSigningKey && nextSigningKey) {
    try {
      const isValid = await new Receiver({ currentSigningKey, nextSigningKey }).verify({
        signature: signatureHeader ?? "",
        body: rawBody,
      });
      if (!isValid) {
        res.status(401).json({ error: "Invalid QStash signature" });
        return;
      }
    } catch {
      res.status(401).json({ error: "Invalid QStash signature" });
      return;
    }
  }

  const payload = JSON.parse(rawBody) as QStashFailureCallbackBody;
  const originalMessage = JSON.parse(Buffer.from(payload.body, "base64").toString("utf8")) as {
    rawEventId: string;
    metaLeadId: string;
  };

  console.error(
    `[dead-letter] Lead ${originalMessage.metaLeadId} (raw event ${originalMessage.rawEventId}) exhausted all retries. dlqId=${payload.dlqId}`,
  );

  await markLeadDeadLettered(originalMessage.metaLeadId, `Exhausted retries, QStash status ${payload.status}`);
  await logEvent({
    rawEventId: originalMessage.rawEventId,
    eventType: "DeadLettered",
    detail: `dlqId=${payload.dlqId}, last status=${payload.status}`,
  });

  // Always 200 - this just acknowledges receipt of the failure notification.
  res.status(200).json({ recorded: true });
}
