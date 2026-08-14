// Thin wrapper over the Meta Graph API. Every call takes the access token
// explicitly rather than reading a single global env var, because each
// campaign has its own Meta app/page and therefore its own access token
// (see webhook_configs). Every call also goes through `fetchWithRetry`, so
// a transient 5xx/network error is retried a couple of times locally before
// bubbling up - anything that still fails is thrown as MetaApiError, which
// the caller (process-lead handler) turns into a non-2xx HTTP response so
// QStash's own retry/backoff takes over for the larger retry budget.

import type { MetaLeadDetails } from "../../domain/types";

const GRAPH_VERSION = "v19.0";
const LEAD_FIELDS = [
  "id",
  "form_id",
  "created_time",
  "field_data",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
].join(",");

export class MetaApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "MetaApiError";
  }
}

function getBaseUrl(): string {
  return process.env.META_GRAPH_BASE_URL ?? `https://graph.facebook.com/${GRAPH_VERSION}`;
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      if (response.status < 500) return response; // don't retry client errors
      lastError = new MetaApiError(`Graph API returned ${response.status}`, response.status);
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250 * 2 ** i)); // 250ms, 500ms, 1000ms
  }
  throw lastError instanceof Error ? lastError : new MetaApiError("Graph API request failed");
}

interface GraphFieldData {
  name: string;
  values: string[];
}

interface GraphLeadResponse {
  id: string;
  form_id: string;
  created_time: string;
  field_data?: GraphFieldData[];
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  adset_name?: string;
  campaign_id?: string;
  campaign_name?: string;
}

function mapLead(raw: GraphLeadResponse): MetaLeadDetails {
  return {
    id: raw.id,
    formId: raw.form_id,
    createdTime: raw.created_time,
    adId: raw.ad_id,
    adName: raw.ad_name,
    adSetId: raw.adset_id,
    adSetName: raw.adset_name,
    campaignId: raw.campaign_id,
    campaignName: raw.campaign_name,
    fieldData: (raw.field_data ?? []).map((f) => ({ name: f.name, values: f.values })),
  };
}

export async function getLeadDetails(leadgenId: string, accessToken: string): Promise<MetaLeadDetails> {
  const url = `${getBaseUrl()}/${leadgenId}?fields=${LEAD_FIELDS}&access_token=${accessToken}`;
  const response = await fetchWithRetry(url);
  if (!response.ok) {
    throw new MetaApiError(`Failed to fetch lead ${leadgenId}: ${response.status}`, response.status);
  }
  const raw = (await response.json()) as GraphLeadResponse;
  return mapLead(raw);
}

/** Used by reconciliation to page through a form's recent leads independent of the webhook. */
export async function* getRecentLeadsForForm(
  formId: string,
  sinceUnixSeconds: number,
  accessToken: string,
): AsyncGenerator<MetaLeadDetails> {
  let after: string | undefined;

  do {
    const filtering = encodeURIComponent(
      JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: sinceUnixSeconds }]),
    );
    const url =
      `${getBaseUrl()}/${formId}/leads?fields=${LEAD_FIELDS}&filtering=${filtering}` +
      `&limit=100&access_token=${accessToken}` +
      (after ? `&after=${after}` : "");

    const response = await fetchWithRetry(url);
    if (!response.ok) {
      throw new MetaApiError(`Failed to list leads for form ${formId}: ${response.status}`, response.status);
    }
    const page = (await response.json()) as {
      data: GraphLeadResponse[];
      paging?: { cursors?: { after?: string } };
    };

    for (const raw of page.data) {
      yield mapLead(raw);
    }

    after = page.paging?.cursors?.after;
  } while (after);
}
