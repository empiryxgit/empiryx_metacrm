// Thin wrapper around the Upstash QStash client. QStash is the durable
// message queue for this system: publishing a message here is durable
// (QStash persists it before returning), and QStash itself calls our HTTP
// endpoint with automatic retries and exponential backoff - so unlike a
// classic broker, there is no separate "consumer process" to keep alive.
// That is exactly what makes this fit Vercel's serverless model, where
// nothing can hold an open connection or run continuously.

import { getEnv } from "../env";
import { Client } from "@upstash/qstash";

function getBaseUrl(): string {
  const url = getEnv("PUBLIC_BASE_URL");
  if (!url) {
    throw new Error("PUBLIC_BASE_URL is not set (e.g. https://your-app.vercel.app). See .env.example.");
  }
  return url.replace(/\/$/, "");
}

function getClient(): Client {
  const token = getEnv("QSTASH_TOKEN");
  if (!token) {
    throw new Error("QSTASH_TOKEN is not set. See .env.example.");
  }
  return new Client({ token });
}

export interface PublishLeadReceivedInput {
  rawEventId: string;
  metaLeadId: string;
  objectType: string;
  companyId: string;
  campaignId: string;
}

/**
 * Publishes the "go process this lead" message. Configured with:
 *  - retries: up to 5 attempts, QStash applies its own exponential backoff
 *    between attempts automatically.
 *  - failureCallback: once retries are exhausted, QStash POSTs the failed
 *    message (plus a `dlqId`) to our dead-letter endpoint AND keeps a copy
 *    in its own Dead Letter Queue, retrievable/redrivable via the QStash
 *    REST API or dashboard.
 */
export async function publishLeadReceived(input: PublishLeadReceivedInput): Promise<string> {
  const client = getClient();
  const result = await client.publishJSON({
    url: `${getBaseUrl()}/api/internal/process-lead`,
    body: input,
    retries: 5,
    failureCallback: `${getBaseUrl()}/api/internal/dead-letter`,
    headers: {
      "Content-Type": "application/json",
    },
  });
  return result.messageId;
}

export interface PublishTenantLeadReceivedInput {
  leadEventId: string; // crm.meta_lead_events.id - this pipeline's durability record (no raw_meta_events row involved)
  metaLeadId: string;
  tenantId: string;
}

/**
 * Tenant-level counterpart to publishLeadReceived above - "go process this
 * lead" for a lead captured via the automatic per-Page webhook receiver
 * (src/application/metaSync/metaLeadEventService.ts), rather than the
 * legacy per-campaign one. Deliberately posts to the SAME
 * /api/internal/process-lead endpoint (not a new one - see the Vercel
 * Hobby 12-Function-cap reasoning throughout this codebase); the `kind`
 * discriminator on the body is what api/internal/handler.ts uses to route
 * to processMetaLeadEvent instead of the legacy processLead.
 */
export async function publishTenantLeadReceived(input: PublishTenantLeadReceivedInput): Promise<string> {
  const client = getClient();
  const result = await client.publishJSON({
    url: `${getBaseUrl()}/api/internal/process-lead`,
    body: { kind: "tenant_meta_sync", ...input },
    retries: 5,
    failureCallback: `${getBaseUrl()}/api/internal/dead-letter`,
    headers: {
      "Content-Type": "application/json",
    },
  });
  return result.messageId;
}

export interface PublishWhatsappMessageReceivedInput {
  messageEventId: string; // crm.whatsapp_message_events.id - this pipeline's durability record
  waMessageId: string;
  tenantId: string;
}

/**
 * WhatsApp Lead Capture feature (Phase 6/7) - "go process this inbound
 * WhatsApp message" for an event captured by
 * metaWhatsappEventService.ts's captureWhatsappEvents. Deliberately posts
 * to the SAME /api/internal/process-lead endpoint as publishLeadReceived
 * and publishTenantLeadReceived above (not a new one - the Vercel Hobby
 * 12-Function cap reasoning throughout this codebase applies here too); the
 * `kind: "whatsapp_message_received"` discriminator on the body is what
 * api/internal/handler.ts uses to route to processWhatsAppMessageEvent
 * instead of either existing lead-processing path.
 */
export async function publishWhatsappMessageReceived(input: PublishWhatsappMessageReceivedInput): Promise<string> {
  const client = getClient();
  const result = await client.publishJSON({
    url: `${getBaseUrl()}/api/internal/process-lead`,
    body: { kind: "whatsapp_message_received", ...input },
    retries: 5,
    failureCallback: `${getBaseUrl()}/api/internal/dead-letter`,
    headers: {
      "Content-Type": "application/json",
    },
  });
  return result.messageId;
}

export interface ScheduleReconciliationInput {
  cron: string; // e.g. "*/15 * * * *" - every 15 minutes, unlike Vercel Hobby's 1x/day cron cap
}

/** Idempotent: creates the recurring reconciliation schedule if it does not already exist.
 * Run once via `npm run setup:schedules` (see scripts/setup-schedules.ts), not on every request. */
export async function ensureReconciliationSchedule({ cron }: ScheduleReconciliationInput): Promise<string> {
  const client = getClient();
  const destination = `${getBaseUrl()}/api/internal/reconciliation`;

  const existing = await client.schedules.list();
  const already = existing.find((s) => s.destination === destination);
  if (already) {
    return already.scheduleId;
  }

  const created = await client.schedules.create({
    destination,
    cron,
    retries: 3,
  });
  return created.scheduleId;
}

// ---------------------------------------------------------------------------
// RUTA Insight/Alert Engine (Phase E) - see src/application/insights/ for the
// full pipeline. Two new QStash primitives, following the exact conventions
// already established above:
//   - ensureInsightScanSchedule: ONE global schedule (like
//     ensureReconciliationSchedule), not one-per-tenant - the scan endpoint
//     itself loops over every eligible tenant internally (see
//     insightScanService.ts's own header comment for why, and
//     src/application/reconcile.ts's header for the precedent this mirrors).
//   - publishInsightNotification: DOES fan out one publish per notification
//     (like publishLeadReceived/publishWhatsappMessageReceived above) -
//     each recipient's delivery gets its own independent QStash retry/
//     backoff and dead-letter target.
// ---------------------------------------------------------------------------

export interface ScheduleInsightScanInput {
  cron: string; // e.g. "*/30 * * * *" - every 30 minutes
}

/** Idempotent: creates the recurring insight-scan schedule if it does not
 * already exist. Run once via `npm run setup:schedules` (see
 * scripts/setup-schedules.ts), not on every request - mirrors
 * ensureReconciliationSchedule exactly. */
export async function ensureInsightScanSchedule({ cron }: ScheduleInsightScanInput): Promise<string> {
  const client = getClient();
  const destination = `${getBaseUrl()}/api/internal/insights-scan`;

  const existing = await client.schedules.list();
  const already = existing.find((s) => s.destination === destination);
  if (already) {
    return already.scheduleId;
  }

  const created = await client.schedules.create({
    destination,
    cron,
    retries: 3,
  });
  return created.scheduleId;
}

export interface PublishInsightNotificationInput {
  queueId: string; // crm.ruta_notification_queue.id
  tenantId: string;
}

// Discriminator handleDeadLetter (api/internal/handler.ts) switches on to
// mark the right row on exhausted retries - same "kind" convention as
// publishTenantLeadReceived/publishWhatsappMessageReceived's bodies above.
const RUTA_NOTIFICATION_KIND = "ruta_notification" as const;

export interface PublishInsightNotificationOpts {
  // Unix seconds - QStash holds the message undelivered until this instant,
  // the mechanism notificationQueue.ts uses to honor quiet hours without any
  // polling/sweep endpoint of its own. Omit to deliver as soon as possible.
  notBefore?: number;
}

/**
 * Publishes the "go attempt this queued notification's delivery" message.
 * Same retries/failureCallback shape as publishLeadReceived - once QStash's
 * own retries (3, deliberately fewer than the 5 used for lead processing:
 * a stale alert delivered a day late after 5 backoff attempts is worse than
 * one that fails cleanly and gets marked so) are exhausted, the failure
 * callback (api/internal/handler.ts's handleDeadLetter, extended with a
 * "ruta_notification" kind) marks the corresponding queue row
 * status='failed', failure_reason='exhausted_retries'.
 */
export async function publishInsightNotification(input: PublishInsightNotificationInput, opts: PublishInsightNotificationOpts = {}): Promise<string> {
  const client = getClient();
  const result = await client.publishJSON({
    url: `${getBaseUrl()}/api/internal/notify-deliver`,
    body: { kind: RUTA_NOTIFICATION_KIND, ...input },
    retries: 3,
    notBefore: opts.notBefore,
    failureCallback: `${getBaseUrl()}/api/internal/dead-letter`,
    headers: {
      "Content-Type": "application/json",
    },
  });
  return result.messageId;
}
