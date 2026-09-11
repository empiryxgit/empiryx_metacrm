// Phase 20 test support - the in-memory "queue" the global QStash mock
// (vitest.setup.ts) writes into instead of calling the real Upstash
// client. Tests assert on `publishedMessages` to verify something WAS
// enqueued (or, for "worker unavailable" scenarios, deliberately never
// call the corresponding processor and assert the message just sits here
// - nothing was lost, it simply hasn't been picked up yet).
//
// A separate module (not part of qstash.ts itself) so mocking
// src/infrastructure/queue/qstash.ts can add these without changing that
// module's real, production-typed exports - see vitest.setup.ts.

export interface CapturedLegacyPublish {
  kind: "legacy";
  rawEventId: string;
  metaLeadId: string;
  objectType: string;
  companyId: string;
  campaignId: string;
}

export interface CapturedTenantPublish {
  kind: "tenant";
  leadEventId: string;
  metaLeadId: string;
  tenantId: string;
}

// WhatsApp Lead Capture feature (Phase 6/7) - mirrors CapturedTenantPublish
// for src/infrastructure/queue/qstash.ts's publishWhatsappMessageReceived.
export interface CapturedWhatsappPublish {
  kind: "whatsapp";
  messageEventId: string;
  waMessageId: string;
  tenantId: string;
}

// RUTA Insight/Alert Engine (Phase E) - mirrors CapturedTenantPublish for
// src/infrastructure/queue/qstash.ts's publishInsightNotification.
export interface CapturedRutaNotificationPublish {
  kind: "ruta_notification";
  queueId: string;
  tenantId: string;
  notBefore?: number;
}

export type CapturedPublish = CapturedLegacyPublish | CapturedTenantPublish | CapturedWhatsappPublish | CapturedRutaNotificationPublish;

export const publishedMessages: CapturedPublish[] = [];

export function resetPublishedMessages(): void {
  publishedMessages.length = 0;
}
