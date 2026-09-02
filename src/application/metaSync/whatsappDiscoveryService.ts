// WhatsApp Lead Capture feature - Phase 2 (Meta Asset Discovery) + Phase 5
// (WhatsApp Business Connection). Discovers the tenant's own WhatsApp
// Business Account(s) and phone number(s) through the SAME Meta connection
// already used for Pages/ad accounts - "the customer does not manually
// enter a WhatsApp Business Account ID, Phone Number ID, or webhook URL"
// (Phase 5 non-negotiable requirement). Mirrors metaPageService.ts's
// syncPagesAndInstagram shape exactly.
//
// Discovery hierarchy (Meta's own, not this app's invention):
//   Business Manager account -> owned WhatsApp Business Account(s) ->
//   phone number(s)
//
// Entirely best-effort by design (see metaOAuth.ts's completeMetaConnection,
// which calls this the same way it calls syncFormsForSelectedPage): a
// tenant/App without whatsapp_business_management granted (an OPTIONAL
// scope - see metaOAuth.ts OAUTH_SCOPES) simply discovers zero WhatsApp
// assets, never a broken Meta connection.

import {
  getUserBusinesses,
  getOwnedWhatsAppBusinessAccounts,
  getWhatsAppPhoneNumbers,
} from "../../infrastructure/meta/graphClient";
import {
  getSelectedMetaWhatsappAccount,
  listMetaWhatsappAccounts,
  replaceMetaWhatsappAccounts,
  selectMetaWhatsappAccount,
  type ReplaceMetaWhatsappAccountInput,
} from "../../infrastructure/db/repositories/whatsapp";
import { subscribeWhatsappWebhook } from "./metaWhatsappWebhookService";

export interface DiscoverWhatsappAssetsResult {
  businessesFound: number;
  wabasFound: number;
  phoneNumbersFound: number;
  // true when exactly one phone number was found and it was therefore
  // auto-selected (Phase 5: "the user selects a business asset only when a
  // selection is genuinely required").
  autoSelected: boolean;
}

/**
 * Walks Business Manager -> owned WhatsApp Business Accounts -> phone
 * numbers for every Business the connection's user token can see, and
 * upserts every phone number found into meta_whatsapp_accounts. Never
 * throws on a missing/declined scope or an empty result - an ordinary
 * Meta-only tenant (no WhatsApp Business Platform set up at all) simply
 * gets a zero-count result, exactly like a tenant with no Instagram
 * account linked to any Page today.
 */
export async function discoverWhatsappAssets(
  tenantId: string,
  connectionId: string,
  userAccessToken: string,
): Promise<DiscoverWhatsappAssetsResult> {
  let businesses: Awaited<ReturnType<typeof getUserBusinesses>> = [];
  try {
    businesses = await getUserBusinesses(userAccessToken);
  } catch (err) {
    // Expected, not exceptional, when whatsapp_business_management (or
    // even business_management on some token types) wasn't granted -
    // "Do not invent Meta API fields... implement a safe fallback rather
    // than guessing" extends here to "safe fallback rather than failing
    // the whole Meta connection over an optional capability".
    console.warn(`[whatsapp-discovery] Failed to list Business Manager accounts for tenant ${tenantId}, skipping WhatsApp discovery:`, err);
    return { businessesFound: 0, wabasFound: 0, phoneNumbersFound: 0, autoSelected: false };
  }

  const phoneNumberInputs: ReplaceMetaWhatsappAccountInput[] = [];
  let wabasFound = 0;

  for (const business of businesses) {
    let wabas: Awaited<ReturnType<typeof getOwnedWhatsAppBusinessAccounts>> = [];
    try {
      wabas = await getOwnedWhatsAppBusinessAccounts(business.id, userAccessToken);
    } catch (err) {
      console.warn(`[whatsapp-discovery] Failed to list WhatsApp Business Accounts for business ${business.id} (tenant ${tenantId}):`, err);
      continue;
    }
    wabasFound += wabas.length;

    for (const waba of wabas) {
      let phoneNumbers: Awaited<ReturnType<typeof getWhatsAppPhoneNumbers>> = [];
      try {
        phoneNumbers = await getWhatsAppPhoneNumbers(waba.id, userAccessToken);
      } catch (err) {
        console.warn(`[whatsapp-discovery] Failed to list phone numbers for WABA ${waba.id} (tenant ${tenantId}):`, err);
        continue;
      }
      for (const phoneNumber of phoneNumbers) {
        phoneNumberInputs.push({
          wabaId: waba.id,
          wabaName: waba.name,
          phoneNumberId: phoneNumber.id,
          displayPhoneNumber: phoneNumber.displayPhoneNumber,
          verifiedName: phoneNumber.verifiedName,
        });
      }
    }
  }

  if (phoneNumberInputs.length === 0) {
    return { businessesFound: businesses.length, wabasFound, phoneNumbersFound: 0, autoSelected: false };
  }

  const rows = await replaceMetaWhatsappAccounts(tenantId, connectionId, phoneNumberInputs);

  // "The user selects a business asset only when a selection is genuinely
  // required" - a tenant with exactly one WhatsApp number never sees a
  // picker at all; auto-select it, same convenience Meta Pages/ad accounts
  // do NOT get today (those genuinely can have several equally-plausible
  // choices) but is safe and obviously correct here since there's nothing
  // to choose between. Only auto-selects if nothing is already selected
  // (a re-sync must never silently flip an existing, deliberate choice).
  let autoSelected = false;
  if (rows.length === 1) {
    const existing = await listMetaWhatsappAccounts(tenantId);
    const alreadyHasSelection = existing.some((a) => a.isSelected);
    if (!alreadyHasSelection) {
      await selectMetaWhatsappAccount(tenantId, rows[0]!.id);
      autoSelected = true;
    }
  }

  // Discovering (and even selecting) a number only ever READS Meta's data -
  // it does not, by itself, make Meta start delivering that WABA's inbound
  // messages to this app's webhook. Whichever account ends up selected
  // (just now, or already selected from an earlier connect) gets its
  // webhook subscription (re)confirmed on every discovery run - idempotent,
  // same "safe to call before every subscribe" posture
  // subscribePageWebhook already has, and specifically what makes this
  // self-healing for a tenant who selected a number before this subscribe
  // step existed: their very next reconnect/resync subscribes them
  // retroactively, with no separate manual step required. Best-effort, like
  // every other step in this function - a subscribe failure must never fail
  // the whole Meta connection (it's recorded on the account row instead;
  // see metaWhatsappWebhookService.ts).
  try {
    const selectedAccount = await getSelectedMetaWhatsappAccount(tenantId);
    if (selectedAccount) {
      await subscribeWhatsappWebhook(tenantId, selectedAccount.id, userAccessToken);
    }
  } catch (err) {
    console.warn(`[whatsapp-discovery] Failed to subscribe WhatsApp webhook for tenant ${tenantId}:`, err);
  }

  return { businessesFound: businesses.length, wabasFound, phoneNumbersFound: phoneNumberInputs.length, autoSelected };
}
