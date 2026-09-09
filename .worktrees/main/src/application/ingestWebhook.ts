// The only logic the webhook HTTP handler calls, once it has already
// resolved which campaign the URL slug belongs to (see
// api/webhooks/meta/[slug].ts). Deliberately minimal:
// 1) persist the raw payload (durability floor) for every leadgen change,
// 2) best-effort publish to QStash,
// 3) return - regardless of whether the publish succeeded, because a failed
//    publish is recovered later by the unenqueued-event sweep inside
//    reconciliation. This is what keeps the webhook response fast enough to
//    survive bursts of 1,000+ near-simultaneous Meta callbacks without
//    timing out or triggering Meta's own retry storm.

import { publishLeadReceived } from "../infrastructure/queue/qstash";
import { markRawEventEnqueueFailed, markRawEventEnqueued, saveRawEvent } from "../infrastructure/db/repositories";

interface MetaWebhookEnvelope {
  object: string;
  entry: Array<{
    id: string;
    time: number;
    changes: Array<{
      field: string;
      value: {
        leadgen_id: string;
        page_id?: string;
        form_id: string;
        created_time?: number;
      };
    }>;
  }>;
}

export interface IngestResult {
  persisted: number;
  enqueued: number;
}

export interface WebhookRoutingContext {
  companyId: string;
  campaignId: string;
}

export async function ingestWebhookPayload(
  rawBody: string,
  signatureHeader: string | null,
  routing: WebhookRoutingContext,
): Promise<IngestResult> {
  const envelope = JSON.parse(rawBody) as MetaWebhookEnvelope;

  let persisted = 0;
  let enqueued = 0;

  for (const entry of envelope.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "leadgen") continue; // ignore non-lead notifications

      const value = change.value;

      // Step 1: durability write. If this throws, the handler returns 5xx and
      // Meta retries delivery - nothing has been lost because nothing was
      // accepted yet.
      const rawEvent = await saveRawEvent({
        companyId: routing.companyId,
        campaignId: routing.campaignId,
        objectType: envelope.object,
        rawPayload: envelope,
        signatureHeader,
        metaLeadId: value.leadgen_id,
        pageId: value.page_id ?? entry.id,
        formId: value.form_id,
      });
      persisted++;

      // Step 2: best-effort publish. Failure does NOT fail the request - the
      // row is already durable and is recovered by the reconciliation sweep.
      try {
        const messageId = await publishLeadReceived({
          rawEventId: rawEvent.id,
          metaLeadId: value.leadgen_id,
          objectType: envelope.object,
          companyId: routing.companyId,
          campaignId: routing.campaignId,
        });
        await markRawEventEnqueued(rawEvent.id, messageId);
        enqueued++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ingest] Failed to publish raw event ${rawEvent.id} for lead ${value.leadgen_id}: ${message}`);
        await markRawEventEnqueueFailed(rawEvent.id, message);
      }
    }
  }

  return { persisted, enqueued };
}
