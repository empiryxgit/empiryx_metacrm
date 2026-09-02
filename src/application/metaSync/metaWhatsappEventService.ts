// WhatsApp Lead Capture feature - Phase 6 (WhatsApp Webhook) + Phase 7
// (Idempotent Ingestion). The WhatsApp-payload counterpart to
// metaLeadEventService.ts - parses an incoming WhatsApp Cloud API webhook
// payload (object === "whatsapp_business_account", delivered to the exact
// same Callback URL as the existing leadgen webhook - see
// api/webhooks/meta/handler.ts's handleMetaLeadgenWebhook, which branches on
// the payload's top-level `object` field before calling into this file) and
// implements the same durable-capture-then-enqueue split:
//   captureWhatsappEvents        - fast, ack-blocking half. Postgres only.
//   enqueueCapturedWhatsappEvents - slower half, one QStash publish per
//                                   newly-captured event, called AFTER the
//                                   handler has already responded to Meta.
//
// Payload shape (WhatsApp Cloud API, documented at
// developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples):
//   entry[].id                              -> the WABA id
//   entry[].changes[].field                 -> "messages" for inbound
//                                              messages; anything else (e.g.
//                                              "message_template_status") is
//                                              not a lead event and skipped
//   entry[].changes[].value.metadata.phone_number_id -> which of the
//                                              tenant's own numbers this
//                                              arrived on (Identify Tenant)
//   entry[].changes[].value.contacts[].profile.name / .wa_id
//   entry[].changes[].value.messages[]      -> the actual inbound message(s)
//     .id                                   -> wamid - the idempotency key
//     .from                                 -> sender's WhatsApp number
//     .type / .text.body
//     .referral                             -> present ONLY for a
//                                              Click-to-WhatsApp ad-originated
//                                              message; carries source_id
//                                              (the ad's Meta id) for Phase 9
//                                              attribution. Absent entirely
//                                              for an organic/direct message
//                                              - never guessed or synthesized.
//   entry[].changes[].value.statuses[]      -> delivery/read receipts, not
//                                              new messages - always skipped,
//                                              same "extract only what a
//                                              lead needs" posture the
//                                              leadgen parser applies to
//                                              non-"leadgen" change fields.
//
// Tenant identity, exactly like the leadgen pipeline, is NEVER read from the
// payload as a claim - it's resolved via
// getTenantsBySelectedWhatsappPhoneNumberId(phoneNumberId), the relationship
// THIS system recorded during WhatsApp asset discovery (Phase 2/5), never
// something the payload can assert on its own.

import { publishWhatsappMessageReceived } from "../../infrastructure/queue/qstash";
import { getTenantsBySelectedWhatsappPhoneNumberId, markWhatsappMessageEventEnqueued, recordWhatsappMessageEvent } from "../../infrastructure/db/repositories/whatsapp";

interface WhatsappContact {
  profile?: { name?: string };
  wa_id?: string;
}

interface WhatsappMessage {
  id?: string; // wamid - the idempotency key
  from?: string;
  type?: string;
  text?: { body?: string };
  referral?: Record<string, unknown>;
}

interface WhatsappChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: WhatsappContact[];
  messages?: WhatsappMessage[];
  // statuses[] (delivery/read receipts) deliberately not typed further -
  // never a lead event, always skipped below.
}

interface WhatsappChange {
  field?: string;
  value?: WhatsappChangeValue;
}

interface WhatsappEntry {
  id?: string; // the WABA id this entry is about
  changes?: WhatsappChange[];
}

interface WhatsappWebhookPayload {
  object?: string;
  entry?: WhatsappEntry[];
}

/** One newly-captured (never a duplicate) WhatsApp message event - mirrors
 * metaLeadEventService.ts's CapturedLeadgenEvent exactly. */
export interface CapturedWhatsappEvent {
  eventId: string;
  waMessageId: string;
  tenantId: string;
}

export interface CaptureWhatsappEventsResult {
  captured: number;
  skipped: number; // status receipts, non-"messages" change fields, unowned phone numbers, malformed entries, or already-recorded events
  toEnqueue: CapturedWhatsappEvent[];
}

/**
 * THE fast, ack-blocking half of the WhatsApp webhook flow - mirrors
 * captureLeadgenEvents' structure and error-tolerance exactly: never throws
 * on a malformed/unexpected payload shape, so a bad body can never turn into
 * a 500 that makes Meta retry-storm the shared webhook endpoint.
 */
export async function captureWhatsappEvents(rawBody: string): Promise<CaptureWhatsappEventsResult> {
  let payload: WhatsappWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as WhatsappWebhookPayload;
  } catch {
    return { captured: 0, skipped: 0, toEnqueue: [] };
  }

  let captured = 0;
  let skipped = 0;
  const toEnqueue: CapturedWhatsappEvent[] = [];

  for (const entry of payload.entry ?? []) {
    const wabaId = entry.id ?? null;

    for (const change of entry.changes ?? []) {
      // Only "messages" changes carry inbound messages - "message_template_status"
      // and other subscribed fields on the same WABA are not lead events.
      if (change.field !== "messages") {
        skipped += 1;
        continue;
      }

      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id ?? null;
      const messages = value?.messages ?? [];
      if (!phoneNumberId || messages.length === 0) {
        // Most commonly a pure status-receipt notification (value.statuses
        // present, value.messages absent) - not a lead event, skip quietly.
        skipped += messages.length > 0 ? 0 : 1;
        continue;
      }

      // Identify Tenant - resolved ONLY from the stored, selected
      // phone-number relationship (Phase 2/5 discovery), exactly like the
      // leadgen pipeline resolves tenant from its stored Page relationship.
      const owningTenants = await getTenantsBySelectedWhatsappPhoneNumberId(phoneNumberId);
      if (owningTenants.length === 0) {
        // No tenant currently has this number selected - e.g. discovered but
        // never selected, or since unselected/disconnected.
        skipped += messages.length;
        continue;
      }

      const contact = value?.contacts?.[0];
      const contactName = contact?.profile?.name ?? null;

      for (const message of messages) {
        if (!message.id || !message.from) {
          skipped++;
          continue;
        }

        for (const tenant of owningTenants) {
          // Check duplicate + Store raw event, in one insert -
          // recordWhatsappMessageEvent's onConflictDoNothing on
          // (tenantId, waMessageId) is the idempotency backstop, exactly
          // mirroring recordMetaLeadEvent's (tenantId, leadgenId) key.
          const row = await recordWhatsappMessageEvent({
            tenantId: tenant.tenantId,
            waMessageId: message.id,
            wabaId,
            phoneNumberId,
            fromPhoneNumber: message.from,
            contactName,
            messageType: message.type ?? null,
            messageText: message.text?.body ?? null,
            referral: message.referral ?? null,
            rawPayload: message,
          });

          if (row) {
            captured++;
            toEnqueue.push({ eventId: row.id, waMessageId: message.id, tenantId: tenant.tenantId });
          } else {
            // Already recorded (a redelivered webhook call) - unlike the
            // leadgen pipeline's "received vs further-along" distinction,
            // there is no cheap re-fetch-and-branch step here worth adding:
            // reconcile-by-time-window (getUnenqueuedWhatsappMessageEvents,
            // mirroring getUnenqueuedMetaLeadEvents) already recovers a
            // never-confirmed-enqueued row on its own schedule, so a
            // redelivery simply counts as skipped.
            skipped++;
          }
        }
      }
    }
  }

  return { captured, skipped, toEnqueue };
}

/**
 * THE slower, post-ack half - mirrors enqueueCapturedLeadgenEvents exactly:
 * called only after the HTTP handler has already sent Meta its 200, never
 * blocks or fails the ack, and a publish failure is simply logged (the row
 * is left at "received" for a future reconciliation sweep to pick up).
 */
export async function enqueueCapturedWhatsappEvents(events: CapturedWhatsappEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await publishWhatsappMessageReceived({ messageEventId: event.eventId, waMessageId: event.waMessageId, tenantId: event.tenantId });
      await markWhatsappMessageEventEnqueued(event.eventId);
    } catch (err) {
      console.error(`[whatsapp-event] Failed to enqueue processing for event ${event.eventId} (message ${event.waMessageId}):`, err);
    }
  }
}
