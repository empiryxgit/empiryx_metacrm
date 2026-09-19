// RUTA WhatsApp query bot: Agency vs Individual client scoping. See
// claude/whatsapp-agency-vs-individual-query-scoping.md for the full design
// this implements, and rutaConversations.activeClientCompanyId's own schema
// comment for the column this reads/writes.
//
// This is the WhatsApp-side counterpart of the web app's "client switcher"
// (src/application/agencyClientContext.ts / agencyClientAccess.ts) - same
// authorization model (AGENCY_CLIENTS_VIEW_ALL -> every actively-claimed
// client; otherwise restricted to agency_client_assignments), same
// re-validate-on-every-use posture, deliberately NOT sharing code with the
// web version because that code takes a web AuthContext (a JWT-derived
// object this WhatsApp pipeline has no equivalent of - see
// rutaTools.ts/crmTools.ts's own header on why this pipeline resolves
// identity itself, from the verified phone->userId binding, rather than
// from any session/JWT). Writing a parallel resolver here - rather than
// bending agencyClientAccess.ts to accept a second identity shape - keeps
// that already-tested web-authorization code completely untouched.
//
// Deliberately gated everywhere by "is this the ASKING user's own company
// an Agency" (companies.accountType) - every function here is a no-op-safe
// default (empty list / null / not-agency) for anything else, so a bug here
// can only ever under-grant an agency user, never leak into or affect an
// Individual account's own behavior.

import { eq } from "drizzle-orm";
import { getDb } from "../../infrastructure/db/client";
import { companies } from "../../infrastructure/db/schema";
import { getUserRoleAndPermissions } from "../../infrastructure/db/repositories/whatsapp";
import { getUserAssignedClientIds } from "../../infrastructure/db/repositories/agencyClientAssignments";
import { listClaimedClientOrganizations } from "../../infrastructure/db/repositories/organizations";
import { setActiveClientCompanyId } from "../../infrastructure/db/repositories/rutaConversation";
import { PERMISSIONS } from "../../domain/permissions";

export interface AccessibleClient {
  clientCompanyId: string;
  clientName: string;
}

/** Whether `tenantId` (the ASKING user's own company - never a resolved
 * client) is an Agency account. The one gate every other function/branch in
 * this file, and every agency-specific branch in rutaTools.ts/
 * rutaAiAssistant.ts, sits behind - false (never a throw) for anything this
 * can't resolve, so a lookup failure degrades to "treat as Individual,"
 * never to a broken query. */
export async function isAgencyTenant(tenantId: string): Promise<boolean> {
  const db = await getDb();
  const [row] = await db.select({ accountType: companies.accountType }).from(companies).where(eq(companies.id, tenantId)).limit(1);
  return row?.accountType === "agency";
}

/**
 * Every client this specific agency USER may currently query over WhatsApp -
 * mirrors resolveAgencyClientAccess/canAccessClient's exact rule
 * (agencyClientAccess.ts): AGENCY_CLIENTS_VIEW_ALL -> every client this
 * agency has actively claimed (status "active" or "suspended" - same set
 * checkAgencyCanManageClient already uses); otherwise -> the subset of
 * those the user has an agency_client_assignments row for. An agency user
 * who holds neither sees an empty list - never every client by default -
 * same "assignment-scoped, no unrestricted fallback" posture the web app's
 * own permission comment insists on.
 */
export async function listAccessibleClientsForRutaUser(tenantId: string, userId: string): Promise<AccessibleClient[]> {
  const [roleInfo, claimed] = await Promise.all([getUserRoleAndPermissions(tenantId, userId), listClaimedClientOrganizations(tenantId)]);
  const activelyClaimed = claimed.filter((c) => c.relationshipStatus === "active" || c.relationshipStatus === "suspended");
  const viewAll = roleInfo?.permissions.includes(PERMISSIONS.AGENCY_CLIENTS_VIEW_ALL) ?? false;
  if (viewAll) return activelyClaimed.map((c) => ({ clientCompanyId: c.clientCompanyId, clientName: c.clientName }));

  const assignedIds = new Set(await getUserAssignedClientIds(userId));
  return activelyClaimed.filter((c) => assignedIds.has(c.clientCompanyId)).map((c) => ({ clientCompanyId: c.clientCompanyId, clientName: c.clientName }));
}

/** Re-checks a PREVIOUSLY-resolved active client is still one this exact
 * user may currently query - re-derives the full accessible list rather
 * than trusting the conversation row alone, so a client removed from the
 * agency's roster, or an assignment revoked, drops out on the very next
 * message rather than being trusted stale (same posture
 * resolveActiveClientContext's own header describes for the web's cookie).
 * Cheap enough to call on every message that consults an existing active
 * client - the same query listAccessibleClientsForRutaUser always runs. */
export async function revalidateActiveClient(tenantId: string, userId: string, clientCompanyId: string): Promise<AccessibleClient | null> {
  const accessible = await listAccessibleClientsForRutaUser(tenantId, userId);
  return accessible.find((c) => c.clientCompanyId === clientCompanyId) ?? null;
}

/**
 * Pulls an explicit "for <client name>" / "at <client name>" trailing
 * phrase out of a message, e.g. "leads today for Acme Corp" -> "Acme Corp".
 * Deliberately simple (a fixed trailing-phrase regex, no NLU) - same
 * "cheapest thing that covers the example phrasing" bar the rest of this
 * pipeline's pattern matching already holds itself to (see rutaTools.ts's
 * own UPDATE_ON_RE). Returns null when the message contains no such phrase
 * at all - the normal case for every message an Individual account ever
 * sends, and for most of an Agency account's messages too once a client is
 * already active for the conversation.
 */
const CLIENT_MENTION_RE = /\b(?:for|at)\s+([a-z0-9][a-z0-9 &.'-]{1,60})\s*$/i;

export function extractClientMention(text: string): string | null {
  const match = CLIENT_MENTION_RE.exec(text.trim());
  return match ? match[1]!.trim() : null;
}

export type ClientMentionMatch = { kind: "one"; client: AccessibleClient } | { kind: "ambiguous"; candidates: AccessibleClient[] } | { kind: "none" };

/** Case-insensitive substring match against the accessible-client list -
 * same simplicity bar as the existing lead/teammate name lookups in
 * rutaTools.ts's updateOnXTool (ilike-style, no fuzzy-matching library).
 * "one" only when EXACTLY one candidate matches; two or more is
 * "ambiguous" even if one of them is an exact-name match and the other
 * isn't - keeps the rule simple and predictable rather than guessing which
 * match the person "really" meant. */
export function matchClientByName(candidates: AccessibleClient[], rawName: string): ClientMentionMatch {
  const needle = rawName.trim().toLowerCase();
  const hits = candidates.filter((c) => c.clientName.toLowerCase().includes(needle));
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "one", client: hits[0]! };
  return { kind: "ambiguous", candidates: hits };
}

/** Renders the standard numbered client-picker prompt, sharing the exact
 * "N. Label" shape rutaTools.ts's updateOnXTool disambiguation already
 * uses, so the reply LOOKS like every other numbered pick this bot ever
 * sends, not a second, different-looking UI pattern. */
export function formatClientPickerPrompt(candidates: AccessibleClient[], intro: string): string {
  const numbered = candidates.map((c, i) => `${i + 1}. ${c.clientName}`).join("\n");
  return `${intro}\n${numbered}`;
}

/**
 * Resolves a NUMBERED-PICK selection of kind "client" (see rutaTools.ts's
 * PendingOption.kind doc comment) - the counterpart of rutaTools.ts's own
 * resolveLeadPick/resolveTeammatePick, just living here instead, since it's
 * agency-client-scoping-specific rather than a general CRM lookup. Called
 * ONLY by rutaAiAssistant.ts's runResolvedPick, after the orchestrator has
 * already parsed a valid `__resolved__:client:id` selection out of session
 * state.
 *
 * Re-validates the pick (never trusts that a numbered choice made a few
 * seconds/minutes ago is still valid - the same posture
 * revalidateActiveClient's own comment describes) before persisting it as
 * this conversation's new activeClientCompanyId, so a client removed from
 * the roster between the picker being shown and the reply arriving is
 * caught here rather than silently switching into stale/inaccessible data.
 */
export async function resolveClientPick(tenantId: string, userId: string, conversationId: string, clientCompanyId: string): Promise<string> {
  const client = await revalidateActiveClient(tenantId, userId, clientCompanyId);
  if (!client) return "That client is no longer accessible to you - send \"switch client\" to see your current list.";
  await setActiveClientCompanyId(tenantId, userId, conversationId, client.clientCompanyId);
  return `Switched to *${client.clientName}*. Ask me anything about their leads, campaigns, or pipeline.`;
}
