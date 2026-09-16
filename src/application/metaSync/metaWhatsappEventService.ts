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
import {
  getTenantsBySelectedWhatsappPhoneNumberId,
  getUserWhatsappLinkByPhone,
  getUserWhatsappLinksByPhoneAnyTenant,
  markWhatsappMessageEventEnqueued,
  recordWhatsappMessageEvent,
} from "../../infrastructure/db/repositories/whatsapp";
import { getEnv } from "../../infrastructure/env";
import type { RutaAssistantInboundMessage } from "./rutaAiAssistant";

/** RUTA AI Assistant platform number (see rutaAiAssistant.ts's header) - the
 * ONE WhatsApp number, purchased and connected once, shared by every
 * tenant's users for Assistant chat + the onboarding welcome message. NEVER
 * a Lead Capture number, and never a tenant's own "selected" WhatsApp
 * account (meta_whatsapp_accounts) - a message arriving on this
 * phone_number_id is identified straight to a RUTA user by phone number
 * alone (getUserWhatsappLinksByPhoneAnyTenant), with no tenant pre-resolved
 * from the number itself, exactly the opposite of every tenant's own
 * numbers below. Its access token is a manually-generated, permanent Meta
 * System User token (see .env.example's own comment on these two vars) -
 * deliberately NOT stored in meta_connections/meta_whatsapp_accounts, which
 * model a tenant's own OAuth-authorized connection, not this shared one. */
function isRutaPlatformNumber(phoneNumberId: string): boolean {
  const platformPhoneNumberId = getEnv("RUTA_PLATFORM_WHATSAPP_PHONE_NUMBER_ID");
  return Boolean(platformPhoneNumberId) && phoneNumberId === platformPhoneNumberId;
}

/** A message routes to the RUTA AI Assistant instead of lead-capture when
 * the sender is already a verified linked RUTA teammate for this tenant -
 * mandatory and admin-provisioned from the user's profile phone number
 * (see api/admin/users/handler.ts), no LINK command involved anymore.
 * Checked BEFORE any whatsapp_message_events row is written - an
 * assistant-routed message never touches the lead pipeline at all, not
 * even as a durability record. */
async function isRutaAssistantMessage(tenantId: string, fromPhoneNumber: string, _text: string | null): Promise<boolean> {
  const link = await getUserWhatsappLinkByPhone(tenantId, fromPhoneNumber);
  // DEBUG (temporary, requested for onboarding-welcome-message diagnosis) -
  // logs the exact routing decision for every inbound message: whether the
  // raw `fromPhoneNumber` Meta sent matched a userWhatsappLinks row for
  // this tenant. getUserWhatsappLinkByPhone matches by last-10-digits
  // (whatsapp.ts's phoneNumbersMatch), not a byte-for-byte string - fixed
  // after a real production incident where a stored 10-digit number
  // ("8128806852", no country code, the common admin-entry shape) never
  // matched WhatsApp's own always-country-coded "918128806852" under the
  // old exact match. A "matched: false" now means something more
  // substantive - a genuinely different number, or a country other than
  // India (see phoneNumbersMatch's own comment on that fixed 10-digit
  // assumption). When "matched: false", the message silently falls through
  // to Lead Capture instead of the Assistant (see caller below).
  console.log("[whatsapp-event] isRutaAssistantMessage check", {
    tenantId,
    fromPhoneNumber,
    matched: link !== null,
    matchedUserId: link?.userId ?? null,
  });
  return link !== null;
}

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
  // RUTA AI Assistant - messages routed here NEVER get a
  // whatsapp_message_events row and never reach the lead pipeline at all.
  toHandleAsAssistant: RutaAssistantInboundMessage[];
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
  } catch (err) {
    // DEBUG (temporary) - a malformed body from Meta should never happen in
    // practice; logged so a genuinely broken payload is visible instead of
    // silently returning zero counts.
    console.error("[whatsapp-event] Failed to JSON.parse rawBody - returning zero counts", err);
    return { captured: 0, skipped: 0, toEnqueue: [], toHandleAsAssistant: [] };
  }

  // DEBUG (temporary, requested for onboarding-welcome-message diagnosis) -
  // proves the webhook actually reached this function at all (i.e. passed
  // signature verification in api/webhooks/meta/handler.ts) and shows the
  // raw entry/change shape Meta sent.
  console.log("[whatsapp-event] captureWhatsappEvents entry", {
    entryCount: payload.entry?.length ?? 0,
    wabaIds: (payload.entry ?? []).map((e) => e.id ?? null),
  });

  let captured = 0;
  let skipped = 0;
  const toEnqueue: CapturedWhatsappEvent[] = [];
  const toHandleAsAssistant: RutaAssistantInboundMessage[] = [];

  for (const entry of payload.entry ?? []) {
    const wabaId = entry.id ?? null;

    for (const change of entry.changes ?? []) {
      // Only "messages" changes carry inbound messages - "message_template_status"
      // and other subscribed fields on the same WABA are not lead events.
      if (change.field !== "messages") {
        // DEBUG (temporary) - e.g. "message_template_status" changes land
        // here; logged so a change field you weren't expecting is visible
        // rather than an unexplained skip.
        console.log("[whatsapp-event] Skipping non-'messages' change field", { field: change.field });
        skipped += 1;
        continue;
      }

      const value = change.value;
      const phoneNumberId = value?.metadata?.phone_number_id ?? null;
      const messages = value?.messages ?? [];
      // DEBUG (temporary, requested for onboarding-welcome-message
      // diagnosis) - the phone_number_id this arrived ON (which of the
      // tenant's WhatsApp numbers) and how many messages/statuses are in
      // this change.
      console.log("[whatsapp-event] Change value parsed", {
        phoneNumberId,
        messagesCount: messages.length,
        hasStatuses: Boolean((value as { statuses?: unknown[] })?.statuses?.length),
      });
      if (!phoneNumberId || messages.length === 0) {
        // Most commonly a pure status-receipt notification (value.statuses
        // present, value.messages absent) - not a lead event, skip quietly.
        skipped += messages.length > 0 ? 0 : 1;
        continue;
      }

      if (isRutaPlatformNumber(phoneNumberId)) {
        // RUTA AI Assistant platform number - see isRutaPlatformNumber's own
        // comment above. There is no tenant to pre-resolve from the number
        // itself (every tenant's users share this one number), so each
        // message's sender is looked up directly by phone number across ALL
        // tenants (getUserWhatsappLinksByPhoneAnyTenant) - and this never
        // falls through to Lead Capture, since that pipeline only exists for
        // a TENANT'S OWN selected number, which this one, by design, never
        // is.
        for (const message of messages) {
          if (!message.id || !message.from) {
            console.warn("[whatsapp-event] Message missing id or from - skipped", { hasId: Boolean(message.id), hasFrom: Boolean(message.from) });
            skipped++;
            continue;
          }
          const links = await getUserWhatsappLinksByPhoneAnyTenant(message.from);
          // DEBUG (temporary, requested for onboarding-welcome-message
          // diagnosis) - the platform-number counterpart of the "Tenant
          // resolution for phoneNumberId" log below: zero matched tenants
          // here means this sender isn't a provisioned RUTA user
          // (userWhatsappLinks row) in ANY tenant - matched via
          // phoneNumbersMatch's last-10-digits comparison (see its own
          // comment in whatsapp.ts), not a byte-for-byte match, so a zero
          // result now means either a genuine stranger who messaged the
          // number, or a country other than India (see that comment's fixed
          // 10-digit assumption) - same normalization isRutaAssistantMessage
          // below uses.
          console.log("[whatsapp-event] Platform-number tenant resolution by phone", {
            fromPhoneNumber: message.from,
            matchedTenantCount: links.length,
            matchedTenantIds: links.map((l) => l.tenantId),
          });
          if (links.length === 0) {
            console.warn("[whatsapp-event] Platform number: no RUTA user linked to this phone number in any tenant - message dropped", { fromPhoneNumber: message.from });
            skipped++;
            continue;
          }
          for (const link of links) {
            console.log("[whatsapp-event] Routed to RUTA Assistant (platform number)", { tenantId: link.tenantId, fromPhoneNumber: message.from, waMessageId: message.id });
            toHandleAsAssistant.push({ tenantId: link.tenantId, fromPhoneNumber: message.from, waMessageId: message.id, messageText: message.text?.body ?? null });
          }
        }
        continue; // this change is fully handled above - never reaches the per-tenant resolution below
      }

      // Identify Tenant - resolved ONLY from the stored, selected
      // phone-number relationship (Phase 2/5 discovery), exactly like the
      // leadgen pipeline resolves tenant from its stored Page relationship.
      const owningTenants = await getTenantsBySelectedWhatsappPhoneNumberId(phoneNumberId);
      // DEBUG (temporary, requested for onboarding-welcome-message
      // diagnosis) - THE key check for "message never triggers anything at
      // all" reports: zero owningTenants means this phoneNumberId is not
      // currently marked isSelected=true for ANY tenant (see
      // getTenantsBySelectedWhatsappPhoneNumberId's own comment) - the
      // message is dropped right here, before Assistant OR Lead Capture.
      console.log("[whatsapp-event] Tenant resolution for phoneNumberId", {
        phoneNumberId,
        owningTenantCount: owningTenants.length,
        owningTenantIds: owningTenants.map((t) => t.tenantId),
      });
      if (owningTenants.length === 0) {
        // No tenant currently has this number selected - e.g. discovered but
        // never selected, or since unselected/disconnected.
        console.warn("[whatsapp-event] No tenant has this phone_number_id selected - message dropped entirely", { phoneNumberId });
        skipped += messages.length;
        continue;
      }

      const contact = value?.contacts?.[0];
      const contactName = contact?.profile?.name ?? null;

      for (const message of messages) {
        if (!message.id || !message.from) {
          // DEBUG (temporary)
          console.warn("[whatsapp-event] Message missing id or from - skipped", { hasId: Boolean(message.id), hasFrom: Boolean(message.from) });
          skipped++;
          continue;
        }

        for (const tenant of owningTenants) {
          // RUTA AI Assistant - check BEFORE any durability write. A
          // verified linked teammate (or a LINK/UNLINK command) never
          // becomes a whatsapp_message_events row and never enters the lead
          // pipeline; it's queued for post-ack handling by
          // rutaAiAssistant.ts's handleRutaAssistantMessages instead (same
          // "durable half here, slower half after ack" split the lead path
          // uses - the assistant's own idempotency is a much lighter
          // concern than lead creation, so no separate durable table is
          // needed for it).
          if (await isRutaAssistantMessage(tenant.tenantId, message.from, message.text?.body ?? null)) {
            // DEBUG (temporary, requested for onboarding-welcome-message
            // diagnosis) - confirms this message was queued for
            // handleRutaAssistantMessages, NOT lead-capture.
            console.log("[whatsapp-event] Routed to RUTA Assistant", { tenantId: tenant.tenantId, fromPhoneNumber: message.from, waMessageId: message.id });
            toHandleAsAssistant.push({ tenantId: tenant.tenantId, fromPhoneNumber: message.from, waMessageId: message.id, messageText: message.text?.body ?? null });
            continue;
          }

          // DEBUG (temporary, requested for onboarding-welcome-message
          // diagnosis) - if you expected this message to reach the
          // Assistant but see this instead, isRutaAssistantMessage's log
          // just above will show `matched: false` - almost always a
          // phone-number format mismatch between userWhatsappLinks and
          // what Meta sent as message.from.
          console.log("[whatsapp-event] Routed to Lead Capture (no matching RUTA user link)", { tenantId: tenant.tenantId, fromPhoneNumber: message.from, waMessageId: message.id });

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
            console.log("[whatsapp-event] Lead-capture event recorded (new)", { tenantId: tenant.tenantId, waMessageId: message.id, eventId: row.id });
            toEnqueue.push({ eventId: row.id, waMessageId: message.id, tenantId: tenant.tenantId });
          } else {
            // Already recorded (a redelivered webhook call) - unlike the
            // leadgen pipeline's "received vs further-along" distinction,
            // there is no cheap re-fetch-and-branch step here worth adding:
            // reconcile-by-time-window (getUnenqueuedWhatsappMessageEvents,
            // mirroring getUnenqueuedMetaLeadEvents) already recovers a
            // never-confirmed-enqueued row on its own schedule, so a
            // redelivery simply counts as skipped.
            console.log("[whatsapp-event] Lead-capture event already recorded (redelivery) - skipped", { tenantId: tenant.tenantId, waMessageId: message.id });
            skipped++;
          }
        }
      }
    }
  }

  // DEBUG (temporary, requested for onboarding-welcome-message diagnosis) -
  // the final tally for this webhook call, before the handler acks Meta.
  console.log("[whatsapp-event] captureWhatsappEvents result", {
    captured,
    skipped,
    toEnqueueCount: toEnqueue.length,
    toHandleAsAssistantCount: toHandleAsAssistant.length,
  });

  return { captured, skipped, toEnqueue, toHandleAsAssistant };
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
