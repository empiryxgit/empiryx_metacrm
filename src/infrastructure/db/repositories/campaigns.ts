import { and, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { getDb } from "../client";
import { campaigns, webhookConfigs } from "../schema";
import { firstOrThrow } from "../util";
import { decryptSecret, encryptSecret, maskSecret } from "../../security/encryption";

// ---- Campaigns ----------------------------------------------------------

export async function createCampaign(input: {
  companyId: string;
  name: string;
  platform: string;
  createdBy: string;
}) {
  const db = await getDb();
  const rows = await db.insert(campaigns).values(input).returning();
  return firstOrThrow(rows);
}

export async function listCampaigns(companyId: string) {
  const db = await getDb();
  return db.select().from(campaigns).where(eq(campaigns.companyId, companyId));
}

export async function getCampaign(companyId: string, campaignId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.companyId, companyId), eq(campaigns.id, campaignId)))
    .limit(1);
  return row ?? null;
}

export async function updateCampaign(
  companyId: string,
  campaignId: string,
  input: { name?: string; platform?: string; status?: string },
) {
  const db = await getDb();
  await db
    .update(campaigns)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(campaigns.companyId, companyId), eq(campaigns.id, campaignId)));
}

// ---- Webhook configuration ------------------------------------------------

function generateSlug(): string {
  return randomBytes(18).toString("base64url"); // unguessable routing segment, not a secret itself
}

function generateVerifyToken(): string {
  return randomBytes(24).toString("base64url");
}

export interface WebhookConfigView {
  id: string;
  campaignId: string;
  slug: string;
  webhookUrl: string;
  verifyToken: string;
  appSecretMasked: string;
  accessTokenMasked: string;
  pageId: string | null;
  formIds: string[];
  status: string;
  lastVerifiedAt: Date | null;
}

function toView(row: typeof webhookConfigs.$inferSelect, baseUrl: string): WebhookConfigView {
  return {
    id: row.id,
    campaignId: row.campaignId,
    slug: row.slug,
    webhookUrl: `${baseUrl.replace(/\/$/, "")}/api/webhooks/meta/${row.slug}`,
    verifyToken: row.verifyToken,
    appSecretMasked: maskSecret(decryptSecret(row.appSecretEncrypted)),
    accessTokenMasked: maskSecret(decryptSecret(row.accessTokenEncrypted)),
    pageId: row.pageId,
    formIds: (row.formIds as string[]) ?? [],
    status: row.status,
    lastVerifiedAt: row.lastVerifiedAt,
  };
}

export async function getWebhookConfigForCampaign(
  companyId: string,
  campaignId: string,
  baseUrl: string,
): Promise<WebhookConfigView | null> {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.companyId, companyId), eq(webhookConfigs.campaignId, campaignId)))
    .limit(1);
  return row ? toView(row, baseUrl) : null;
}

export interface UpsertWebhookConfigInput {
  companyId: string;
  campaignId: string;
  appSecret: string;
  accessToken: string;
  pageId?: string;
  formIds: string[];
}

/** Creates the config on first save (generating slug + verify token), or updates the
 * credentials/form list on subsequent saves while keeping the same slug/verify token -
 * changing those would break a URL already registered with Meta. */
export async function upsertWebhookConfig(input: UpsertWebhookConfigInput, baseUrl: string): Promise<WebhookConfigView> {
  const db = await getDb();
  const [existing] = await db
    .select()
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.companyId, input.companyId), eq(webhookConfigs.campaignId, input.campaignId)))
    .limit(1);

  const appSecretEncrypted = encryptSecret(input.appSecret);
  const accessTokenEncrypted = encryptSecret(input.accessToken);

  if (existing) {
    const rows = await db
      .update(webhookConfigs)
      .set({
        appSecretEncrypted,
        accessTokenEncrypted,
        pageId: input.pageId,
        formIds: input.formIds,
        status: "pending",
        updatedAt: new Date(),
      })
      .where(eq(webhookConfigs.id, existing.id))
      .returning();
    return toView(firstOrThrow(rows), baseUrl);
  }

  const rows = await db
    .insert(webhookConfigs)
    .values({
      campaignId: input.campaignId,
      companyId: input.companyId,
      slug: generateSlug(),
      verifyToken: generateVerifyToken(),
      appSecretEncrypted,
      accessTokenEncrypted,
      pageId: input.pageId,
      formIds: input.formIds,
      status: "pending",
    })
    .returning();
  return toView(firstOrThrow(rows), baseUrl);
}

/** Internal lookup used by the webhook receiver - returns decrypted credentials, never exposed
 * over an API response (only upsertWebhookConfig's masked view is). */
export async function getWebhookConfigBySlug(slug: string) {
  const db = await getDb();
  const [row] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.slug, slug)).limit(1);
  if (!row) return null;
  return {
    ...row,
    appSecret: decryptSecret(row.appSecretEncrypted),
    accessToken: decryptSecret(row.accessTokenEncrypted),
    formIds: (row.formIds as string[]) ?? [],
  };
}

/** Internal lookup used by the worker (process-lead) - returns the decrypted access
 * token for the campaign that raised this lead, never exposed over an API response. */
export async function getWebhookConfigByCampaignIdInternal(campaignId: string) {
  const db = await getDb();
  const [row] = await db.select().from(webhookConfigs).where(eq(webhookConfigs.campaignId, campaignId)).limit(1);
  if (!row) return null;
  return {
    ...row,
    appSecret: decryptSecret(row.appSecretEncrypted),
    accessToken: decryptSecret(row.accessTokenEncrypted),
    formIds: (row.formIds as string[]) ?? [],
  };
}

export async function markWebhookVerified(webhookConfigId: string) {
  const db = await getDb();
  await db
    .update(webhookConfigs)
    .set({ status: "verified", lastVerifiedAt: new Date(), updatedAt: new Date() })
    .where(eq(webhookConfigs.id, webhookConfigId));
}

export async function markWebhookActive(webhookConfigId: string) {
  const db = await getDb();
  await db
    .update(webhookConfigs)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(webhookConfigs.id, webhookConfigId));
}

/** Every campaign with a verified/active webhook, decrypted and ready for the
 * reconciliation sweep to iterate - one global QStash schedule covers every
 * tenant rather than provisioning a per-campaign schedule. */
export async function listActiveWebhookConfigs() {
  const db = await getDb();
  const rows = await db
    .select()
    .from(webhookConfigs)
    .where(inArray(webhookConfigs.status, ["verified", "active"]));
  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaignId,
    companyId: row.companyId,
    formIds: (row.formIds as string[]) ?? [],
    accessToken: decryptSecret(row.accessTokenEncrypted),
  }));
}
