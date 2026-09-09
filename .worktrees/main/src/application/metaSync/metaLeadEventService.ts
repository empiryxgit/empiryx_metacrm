// MetaLeadEventService - parses an incoming Meta leadgen webhook payload
// (see api/webhooks/meta/handler.ts's leadgen resource) and implements the
// durable-capture half of Phase 11's webhook flow:
//   Identify Page -> Identify Tenant -> Extract leadgen_id -> Check
//   duplicate -> Store raw event.
// Deliberately split into two functions so the HTTP handler can send Meta
// its 200 ack the instant storage is durable, WITHOUT waiting on the
// queue publish that triggers actual lead processing:
//   captureLeadgenEvents         - the fast, ack-blocking half (this
//                                  file's main export). Touches Postgres
//                                  only; no QStash call, no Meta Graph API
//                                  call, so there is nothing here Meta's
//                                  own webhook delivery timeout can be
//                                  tripped by.
//   enqueueCapturedLeadgenEvents - the slower half (one QStash publish per
//                                  newly-captured event), called by the
//                                  handler AFTER it has already responded
//                                  to Meta. Never blocks the response and
//                                  never throws back into the handler - a
//                                  publish failure here is recovered later
//                                  by reconcile.ts's unenqueued-event
//                                  sweep (getUnenqueuedMetaLeadEvents), the
//                                  same durability guarantee the legacy
//                                  per-campaign pipeline already has via
//                                  getUnenqueuedRawEvents.
// meta_lead_events IS this pipeline's durability record - there is no
// separate raw_meta_events row behind a tenant-synced lead.

import { publishTenantLeadReceived } from "../../infrastructure/queue/qstash";
import {
  getMetaLeadEventByTenantAndLeadgenId,
  getSubscribedMetaPagesByPageId,
  markMetaLeadEventEnqueued,
  recordMetaLeadEvent,
} from "../../infrastructure/db/repositories/metaLeadEvents";

interface LeadgenChangeValue {
  leadgen_id?: string;
  page_id?: string;
  form_id?: string;
  ad_id?: string;
  // Meta's Marketing API still calls an ad set an "adgroup" in some places
  // (a naming holdover) - the leadgen webhook payload uses adgroup_id for
  // what the rest of this codebase (meta_ad_sets) calls an ad set id.
  adgroup_id?: string;
  campaign_id?: string;
}

interface LeadgenChange {
  field?: string;
  value?: LeadgenChangeValue;
}

interface WebhookEntry {
  id?: string; // the Meta Page id this entry is about
  changes?: LeadgenChange[];
}

interface LeadgenWebhookPayload {
  object?: string;
  entry?: WebhookEntry[];
}

/** One newly-captured (never a duplicate) event - everything
 * enqueueCapturedLeadgenEvents needs to publish it. Deliberately just
 * these three fields, not the whole DB row, so the ack-blocking half never
 * hands back more than the enqueue half actually uses. */
export interface CapturedLeadgenEvent {
  eventId: string;
  leadgenId: string;
  tenantId: string;
}

export interface CaptureLeadgenEventsResult {
  captured: number; // rows actually inserted (new events)
  skipped: number; // changes seen but not captured (wrong field, unowned page, duplicate, or malformed) - includes reprocessed
  // Phase 13 - a redelivered leadgen_id (tenant_id + leadgen_id) whose
  // event was captured but never confirmed enqueued (see the "Check
  // duplicate" comment below) counts as reprocessed, not captured: no new
  // meta_lead_events row is created, but it IS added to toEnqueue for a
  // fresh publish attempt. toEnqueue.length is therefore captured +
  // reprocessed, not just captured.
  reprocessed: number;
  toEnqueue: CapturedLeadgenEvent[];
}

/**
 * THE fast, ack-blocking half of Phase 11's webhook flow. Validate request
 * happens in the HTTP handler (HMAC signature) before this is ever called;
 * everything from Identify Page through Store raw event happens here, and
 * nothing after it - no QStash call, no Meta Graph API call. Tolerant of
 * malformed/unexpected shapes (a bad payload should never crash the
 * receiver into a 500 that makes Meta retry-storm it) - anything that
 * doesn't parse as expected is just skipped, never thrown.
 *
 * Tenant identity is NEVER read from the payload - Meta's leadgen webhook
 * body carries no tenant/company field at all, only Meta's own ids
 * (page_id, form_id, ad_id, ...). The only tenant resolution this function
 * performs is via getSubscribedMetaPagesByPageId(metaPageId) - looking up
 * which tenant(s) this codebase itself recorded as owning that Page (Phase
 * 5's "Select Page" + Phase 7's webhook subscription), a relationship this
 * server chose and stored, never something the caller can influence.
 */
export async function captureLeadgenEvents(rawBody: string): Promise<CaptureLeadgenEventsResult> {
  let payload: LeadgenWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LeadgenWebhookPayload;
  } catch {
    return { captured: 0, skipped: 0, reprocessed: 0, toEnqueue: [] };
  }

  let captured = 0;
  let skipped = 0;
  let reprocessed = 0;
  const toEnqueue: CapturedLeadgenEvent[] = [];

  for (const entry of payload.entry ?? []) {
    // Identify Page - Meta's own Page id, the only identifier this entry
    // carries; everything downstream (tenant, event routing) is derived
    // from it, never trusted as-is.
    const metaPageId = entry.id;
    if (!metaPageId) {
      skipped += entry.changes?.length ?? 0;
      continue;
    }

    for (const change of entry.changes ?? []) {
      // Extract leadgen_id - also filters out any non-leadgen change field
      // Meta might one day include on the same subscription.
      if (change.field !== "leadgen" || !change.value?.leadgen_id) {
        skipped++;
        continue;
      }

      // Identify Tenant - resolved ONLY from the stored Page/Meta
      // connection relationship (see getSubscribedMetaPagesByPageId's own
      // comment for why this can, rarely, be more than one tenant).
      const owningPages = await getSubscribedMetaPagesByPageId(metaPageId);
      if (owningPages.length === 0) {
        // No tenant currently has this Page subscribed - e.g. a Page that
        // was later disconnected/unselected. Nothing to attribute this to.
        skipped++;
        continue;
      }

      for (const page of owningPages) {
        const leadgenId = change.value.leadgen_id;
        // Check duplicate + Store raw event - recordMetaLeadEvent's
        // onConflictDoNothing on the (tenant_id, leadgen_id) idempotency
        // key is what makes this safe against a redelivered Meta webhook
        // call ("Meta may retry webhook events - the same lead must never
        // create duplicate CRM leads"): a second delivery of the same
        // event never creates a second meta_lead_events row (eventId
        // comes back null), and never reaches a second leads row either -
        // insertLead/insertMetaSyncLead's own unique index on
        // leads.meta_lead_id is the second, authoritative backstop even
        // if two deliveries somehow raced past this check concurrently.
        const eventId = await recordMetaLeadEvent({
          tenantId: page.tenantId,
          leadgenId,
          pageId: change.value.page_id ?? metaPageId,
          formId: change.value.form_id ?? null,
          adId: change.value.ad_id ?? null,
          adsetId: change.value.adgroup_id ?? null,
          campaignId: change.value.campaign_id ?? null,
          rawPayload: change.value,
        });
        if (eventId) {
          captured++;
          toEnqueue.push({ eventId, leadgenId, tenantId: page.tenantId });
          continue;
        }

        // "Does leadgen_id already exist? YES -> safely ignore/reprocess."
        // This delivery didn't create a new row, but "ignore" and
        // "reprocess" are not the same outcome here - look at what the
        // existing row actually is before deciding which one applies:
        //   - still "received" (captured on an earlier delivery, but that
        //     delivery's enqueue never got confirmed - a QStash publish
        //     failure, or the process was cut off before it could try) ->
        //     REPROCESS: this redelivery is a free, immediate chance to
        //     self-heal it, rather than waiting up to 15 minutes for
        //     reconcile.ts's own getUnenqueuedMetaLeadEvents sweep.
        //   - anything further along (enqueued/processing/processed/
        //     duplicate/failed/dead_lettered) -> IGNORE: it's already
        //     being handled (or was already resolved) by the pipeline
        //     this exact idempotency key routed the first delivery to;
        //     reprocessing it here would only race that.
        skipped++;
        const existing = await getMetaLeadEventByTenantAndLeadgenId(page.tenantId, leadgenId);
        if (existing && existing.status === "received") {
          reprocessed++;
          toEnqueue.push({ eventId: existing.id, leadgenId, tenantId: page.tenantId });
        }
      }
    }
  }

  return { captured, skipped, reprocessed, toEnqueue };
}

/**
 * THE slower, post-ack half - Process lead asynchronously. Called by the
 * HTTP handler only AFTER it has already sent Meta its 200 response, so a
 * slow or failed QStash publish can never delay (let alone fail) the
 * webhook ack itself. Publishes "go fetch this lead's full details and
 * write it into the CRM" (processMetaLeadEvent.ts, via QStash) for every
 * newly-captured event; a publish failure is logged and the event is left
 * at status "received" - never thrown back into the handler (there is no
 * response left to fail) - so reconcile.ts's getUnenqueuedMetaLeadEvents
 * sweep picks it up and retries on its own schedule. This mirrors the
 * legacy per-campaign pipeline's ingestWebhookPayload "best-effort
 * publish, durability floor already met" contract.
 */
export async function enqueueCapturedLeadgenEvents(events: CapturedLeadgenEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await publishTenantLeadReceived({ leadEventId: event.eventId, metaLeadId: event.leadgenId, tenantId: event.tenantId });
      await markMetaLeadEventEnqueued(event.eventId);
    } catch (err) {
      console.error(`[meta-lead-event] Failed to enqueue processing for event ${event.eventId} (lead ${event.leadgenId}):`, err);
    }
  }
}
