// Domain-level types shared across the application and infrastructure layers.
// No framework or vendor imports belong in this file - keep it pure.

export enum LeadPlatform {
  Facebook = "facebook",
  Instagram = "instagram",
  Unknown = "unknown",
}

export enum LeadStatus {
  Pending = "pending",
  Processing = "processing",
  Processed = "processed",
  Failed = "failed",
  DeadLettered = "dead_lettered",
  Duplicate = "duplicate",
}

export enum RawEventStatus {
  Received = "received",
  Enqueued = "enqueued",
  EnqueueFailed = "enqueue_failed",
}

export interface MetaFieldData {
  name: string;
  values: string[];
}

/** Full lead detail as returned by GET /{leadgen_id} on the Meta Graph API. */
export interface MetaLeadDetails {
  id: string;
  formId: string;
  pageId?: string;
  adId?: string;
  adName?: string;
  adSetId?: string;
  adSetName?: string;
  campaignId?: string;
  campaignName?: string;
  createdTime: string; // ISO
  fieldData: MetaFieldData[];
}

export interface IntegrationCounts {
  received: number;
  processed: number;
  pending: number;
  failed: number;
  duplicate: number;
  deadLettered: number;
  retries: number;
  avgProcessingSeconds: number;
}
