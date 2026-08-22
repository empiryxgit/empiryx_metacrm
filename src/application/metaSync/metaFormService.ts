// MetaFormService (Phase 6 naming) - owns the "Loading Forms" sync step.
// Scoped to the tenant's SELECTED Page only, using that Page's own
// page-scoped access token (Meta's Leadgen Forms API requires a page
// token with leads_retrieval, not the connection's user token - see
// graphClient.getPageLeadForms).
//
// Phase 10: each form's own questions (see graphClient.MetaLeadFormSummary
// .questions) are now part of what this sync persists, and every question
// gets a starting field-mapping row seeded right after - see
// ensureDefaultFieldMappings's own comment for why a re-sync never touches
// a mapping that already exists.

import { getPageLeadForms } from "../../infrastructure/meta/graphClient";
import { getMetaPageInternal, getSelectedMetaPage } from "../../infrastructure/db/repositories/metaIntegration";
import { replaceMetaForms } from "../../infrastructure/db/repositories/metaSync";
import { ensureDefaultFieldMappings } from "../../infrastructure/db/repositories/metaFormMappings";

export interface SyncFormsResult {
  skipped: boolean;
  reason?: string;
  formsCount: number;
}

export async function syncFormsForSelectedPage(tenantId: string): Promise<SyncFormsResult> {
  const selectedPage = await getSelectedMetaPage(tenantId);
  if (!selectedPage) {
    return { skipped: true, reason: "No Page selected yet.", formsCount: 0 };
  }

  // Re-fetch with the decrypted page token - getSelectedMetaPage's row
  // still carries the encrypted column, never decrypted for a bare
  // "which page is selected" lookup.
  const pageInternal = await getMetaPageInternal(tenantId, selectedPage.id);
  if (!pageInternal) {
    return { skipped: true, reason: "Selected Page could not be loaded.", formsCount: 0 };
  }

  const forms = await getPageLeadForms(selectedPage.pageId, pageInternal.pageAccessToken);
  const formRows = await replaceMetaForms(
    tenantId,
    selectedPage.pageId,
    forms.map((f) => ({ formId: f.id, formName: f.name, status: f.status, questions: f.questions })),
  );

  // Seed a default field mapping for every question on every form just
  // synced - sequential (mirrors metaCampaignService.ts's own "simplest
  // and kindest to rate limits" reasoning, and this is a handful of local
  // DB writes, not Graph API calls, so there's no rate-limit concern -
  // just consistency with the pattern already established here).
  for (const formRow of formRows) {
    await ensureDefaultFieldMappings(tenantId, formRow.id, formRow.questions as { key: string; label: string; type: string }[]);
  }

  return { skipped: false, formsCount: forms.length };
}
