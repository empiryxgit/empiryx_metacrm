// Combines the QStash-invoked worker (process-lead), the reconciliation
// sweep (QStash schedule + Vercel cron fallback), and the QStash
// failureCallback target (dead-letter) into ONE Vercel Function - see
// api/auth/handler.ts for why. URLs unchanged: /api/internal/process-lead,
// /api/internal/reconciliation, /api/internal/dead-letter - vercel.json
// rewrites them here with ?action= injected. All three still need the raw
// request body for signature verification, so bodyParser stays disabled
// for the whole function and each handler reads it itself.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Receiver } from "@upstash/qstash";
import { processLead, RetryableProcessingError } from "../../src/application/processLead";
import { processMetaLeadEvent } from "../../src/application/metaSync/processMetaLeadEvent";
import { runReconciliation } from "../../src/application/reconcile";
import { incrementRetryCount, logEvent, markLeadDeadLettered } from "../../src/infrastructure/db/repositories";
import { markMetaLeadEventFailed } from "../../src/infrastructure/db/repositories/metaLeadEvents";

export const config = {
  api: { bodyParser: false },
};

function getAction(req: VercelRequest): string {
  const segments = req.query.action;
  if (Array.isArray(segments)) return segments[0] ?? "";
  return typeof segments === "string" ? segments : "";
}

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getQstashReceiver(): Receiver {
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) {
    throw new Error("QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY are not set. See .env.example.");
  }
  return new Receiver({ currentSigningKey, nextSigningKey });
}

function getSignatureHeader(req: VercelRequest): string {
  const signature = req.headers["upstash-signature"];
  return (Array.isArray(signature) ? signature[0] : signature) ?? "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  switch (getAction(req)) {
    case "process-lead":
      return handleProcessLead(req, res);
    case "reconciliation":
      return handleReconciliation(req, res);
    case "dead-letter":
      return handleDeadLetter(req, res);
    default:
      res.status(404).json({ error: "Not found" });
  }
}

// The "worker". Invoked by QStash over HTTP, not by a persistent consumer -
// this is the piece of the architecture that replaces a traditional message
// broker consumer, and it's what makes the whole pipeline run on Vercel's
// serverless model instead of an always-on process.
//
// QStash's own retry policy (configured at publish time - see
// src/infrastructure/queue/qstash.ts) re-invokes this endpoint with
// exponential backoff whenever it returns a non-2xx status or times out.
// After the configured retry count is exhausted, QStash calls the
// failureCallback endpoint (the dead-letter action below) instead.
interface LeadReceivedBody {
  // publishLeadReceived never actually sets this - it's declared here
  // (always undefined in practice) purely so TS treats `kind` as a valid
  // discriminant across the LeadReceivedBody | TenantLeadReceivedBody
  // union below; `message.kind === "tenant_meta_sync"` is false for every
  // real legacy message, which is exactly the routing this needs.
  kind?: undefined;
  rawEventId: string;
  metaLeadId: string;
  objectType: string;
  companyId: string;
  campaignId: string;
}

// Tenant-level counterpart - see
// src/infrastructure/queue/qstash.ts's publishTenantLeadReceived and
// src/application/metaSync/processMetaLeadEvent.ts. Same endpoint, same
// QStash topic, distinguished purely by this `kind` field so the 12-
// Function cap never has to grow for this new pipeline.
interface TenantLeadReceivedBody {
  kind: "tenant_meta_sync";
  leadEventId: string;
  metaLeadId: string;
  tenantId: string;
}

async function handleProcessLead(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signatureHeader = getSignatureHeader(req);

  try {
    const isValid = await getQstashReceiver().verify({ signature: signatureHeader, body: rawBody });
    if (!isValid) {
      res.status(401).json({ error: "Invalid QStash signature" });
      return;
    }
  } catch (err) {
    console.error("[process-lead] Signature verification failed:", err);
    res.status(401).json({ error: "Invalid QStash signature" });
    return;
  }

  const message = JSON.parse(rawBody) as LeadReceivedBody | TenantLeadReceivedBody;
  const attempt = Number(req.headers["upstash-retried"] ?? 0) + 1;

  if (message.kind === "tenant_meta_sync") return handleProcessTenantLead(message, attempt, res);
  return handleProcessLegacyLead(message, attempt, res);
}

async function handleProcessLegacyLead(message: LeadReceivedBody, attempt: number, res: VercelResponse) {
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

async function handleProcessTenantLead(message: TenantLeadReceivedBody, attempt: number, res: VercelResponse) {
  try {
    const outcome = await processMetaLeadEvent(message.leadEventId, message.metaLeadId, message.tenantId);
    console.log(`[process-lead] (tenant sync) ${message.metaLeadId} -> ${outcome} (attempt ${attempt})`);
    res.status(200).json({ outcome });
  } catch (err) {
    // processMetaLeadEvent already records the failure on the
    // meta_lead_events row itself (markMetaLeadEventRetrying, with its own
    // retryCount increment) before throwing - nothing further to persist
    // here, unlike the legacy path above which has no such row of its own
    // to write to. The row only reaches this handler's terminal FAILED
    // state below, once QStash's own retries are exhausted.
    const isRetryable = err instanceof RetryableProcessingError;
    const messageText = err instanceof Error ? err.message : String(err);
    console.error(`[process-lead] (tenant sync) Attempt ${attempt} failed for ${message.metaLeadId}: ${messageText}`);
    res.status(isRetryable ? 502 : 500).json({ error: messageText });
  }
}

// Two trigger sources are accepted:
//  1. A QStash Schedule (see scripts/setup-schedules.ts) - the PRIMARY
//     trigger, POSTing here every 15 minutes (configurable) with a QStash
//     signature. Not bound by Vercel's own cron limits.
//  2. Vercel's own daily Cron Job (see vercel.json) - a low-frequency
//     fallback in case the QStash schedule is ever deleted or misconfigured.
//     Vercel invokes this via GET and, when CRON_SECRET is set, attaches
//     `Authorization: Bearer <CRON_SECRET>` - see
//     https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
//
// Either path is independently sufficient to authenticate the request; if
// neither credential matches, the request is rejected.
function isAuthorizedVercelCron(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.authorization === `Bearer ${cronSecret}`;
}

async function handleReconciliation(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (req.method === "GET") {
    if (!isAuthorizedVercelCron(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  } else {
    const rawBody = await readRawBody(req);
    const signatureHeader = getSignatureHeader(req);

    const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
    if (!currentSigningKey || !nextSigningKey) {
      res.status(500).json({ error: "QStash signing keys are not configured" });
      return;
    }
    try {
      const isValid = await new Receiver({ currentSigningKey, nextSigningKey }).verify({
        signature: signatureHeader,
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

  try {
    const summary = await runReconciliation();
    console.log("[reconciliation] Completed:", summary);
    res.status(200).json(summary);
  } catch (err) {
    console.error("[reconciliation] Run failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}

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
interface QStashFailureCallbackBody {
  dlqId: string;
  sourceMessageId: string;
  status: number;
  body: string; // base64-encoded original message body
}

async function handleDeadLetter(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const rawBody = await readRawBody(req);
  const signatureHeader = getSignatureHeader(req);

  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (currentSigningKey && nextSigningKey) {
    try {
      const isValid = await new Receiver({ currentSigningKey, nextSigningKey }).verify({
        signature: signatureHeader,
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
    kind?: "tenant_meta_sync";
    rawEventId?: string;
    leadEventId?: string;
    metaLeadId: string;
  };

  if (originalMessage.kind === "tenant_meta_sync" && originalMessage.leadEventId) {
    // Tenant-level pipeline - there is no `leads` row to mark (processing
    // never got far enough to create one), so the failure is recorded on
    // meta_lead_events itself instead, which IS this pipeline's durability
    // record.
    console.error(
      `[dead-letter] (tenant sync) Lead ${originalMessage.metaLeadId} (event ${originalMessage.leadEventId}) exhausted all retries. dlqId=${payload.dlqId}`,
    );
    await markMetaLeadEventFailed(originalMessage.leadEventId, `Exhausted retries, QStash status ${payload.status}, dlqId=${payload.dlqId}`);
    res.status(200).json({ recorded: true });
    return;
  }

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
