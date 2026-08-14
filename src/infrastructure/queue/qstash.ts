// Thin wrapper around the Upstash QStash client. QStash is the durable
// message queue for this system: publishing a message here is durable
// (QStash persists it before returning), and QStash itself calls our HTTP
// endpoint with automatic retries and exponential backoff - so unlike a
// classic broker, there is no separate "consumer process" to keep alive.
// That is exactly what makes this fit Vercel's serverless model, where
// nothing can hold an open connection or run continuously.

import { Client } from "@upstash/qstash";

function getBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) {
    throw new Error("PUBLIC_BASE_URL is not set (e.g. https://your-app.vercel.app). See .env.example.");
  }
  return url.replace(/\/$/, "");
}

function getClient(): Client {
  const token = process.env.QSTASH_TOKEN;
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
