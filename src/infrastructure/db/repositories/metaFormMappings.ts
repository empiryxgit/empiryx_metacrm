// Phase 10 - persistence for the Meta Field -> CRM Field mapping (see
// src/infrastructure/db/schema.ts's metaFormFieldMappings table doc
// comment). Two distinct kinds of caller use this file:
//   1. The sync pipeline (metaFormService.ts) - ensureDefaultFieldMappings,
//      called right after a form's questions are (re)synced, to seed a row
//      for any question that doesn't have one yet. Never overwrites an
//      existing row.
//   2. Everything else - the admin mapping screen (list/get/save) and
//      ingestion's own resolver (resolveLeadFields.ts, read-only).

import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../client";
import { metaForms, metaFormFieldMappings } from "../schema";
import { suggestMetaFieldMapping } from "../../../domain/metaFieldDefaults";

export interface MetaFormQuestion {
  key: string;
  label: string;
  type: string;
}

/**
 * Seeds a mapping row for every question a form currently has that doesn't
 * already have one, using suggestMetaFieldMapping's best-guess default.
 * `onConflictDoNothing` on the (tenantId, metaFormId, metaFieldKey) unique
 * index is THE mechanism that guarantees an administrator's own edit is
 * never touched by a later re-sync - a row that already exists is left
 * completely alone, even its denormalized metaFieldLabel (an admin may
 * have deliberately kept the mapping despite Meta rewording the question).
 * Safe to call on every sync, including one that finds zero new questions.
 */
export async function ensureDefaultFieldMappings(tenantId: string, metaFormRowId: string, questions: MetaFormQuestion[]) {
  if (questions.length === 0) return;
  const db = await getDb();
  const rows = questions.map((q) => {
    const key = q.key.trim().toLowerCase();
    const suggestion = suggestMetaFieldMapping(key);
    return {
      tenantId,
      metaFormId: metaFormRowId,
      metaFieldKey: key,
      metaFieldLabel: q.label || q.key,
      mappingType: suggestion.mappingType,
      systemField: suggestion.mappingType === "system" ? suggestion.systemField : null,
      customFieldKey: suggestion.mappingType === "custom" ? suggestion.customFieldKey : null,
      customFieldLabel: suggestion.mappingType === "custom" ? suggestion.customFieldLabel : null,
    };
  });
  await db.insert(metaFormFieldMappings).values(rows).onConflictDoNothing({
    target: [metaFormFieldMappings.tenantId, metaFormFieldMappings.metaFormId, metaFormFieldMappings.metaFieldKey],
  });
}

/** Every field mapping for one synced Meta form - powers the Field Mapping
 * screen (paired with the form's own `questions` for anything asked that
 * somehow has no mapping row yet, e.g. a sync that hasn't run since this
 * question was added). */
export async function listFieldMappingsForForm(tenantId: string, metaFormRowId: string) {
  const db = await getDb();
  return db
    .select()
    .from(metaFormFieldMappings)
    .where(and(eq(metaFormFieldMappings.tenantId, tenantId), eq(metaFormFieldMappings.metaFormId, metaFormRowId)));
}

/**
 * THE ingestion-time lookup - every persisted mapping for the Meta form
 * identified by Meta's OWN form id (not our row id; that's all
 * resolveLeadFields.ts has at hand, the same value leads.formId already
 * stores), PLUS (Phase 12) that form's own display name - Meta's leadgen
 * API never returns a form's name on the lead object itself (only its
 * id), so this synced meta_forms.form_name (Phase 6's sync, refreshed by
 * every re-sync) is the one place a CRM Lead's human-readable form name
 * can come from without an extra Graph API call per lead. Returns
 * `{ formName: null, mappings: [] }` (never throws) when the tenant has
 * no metaForms row for this formId at all - a form the legacy
 * per-campaign pipeline was pointed at without ever going through the
 * sync, for instance - so resolveLeadFields's own per-field dictionary
 * fallback can still apply rather than the whole lead failing, just
 * without a form name to attach.
 */
export async function getFieldMappingsByMetaFormId(tenantId: string, metaFormId: string) {
  const db = await getDb();
  const [form] = await db
    .select({ id: metaForms.id, formName: metaForms.formName })
    .from(metaForms)
    .where(and(eq(metaForms.tenantId, tenantId), eq(metaForms.formId, metaFormId)))
    .limit(1);
  if (!form) return { formName: null as string | null, mappings: [] };
  const mappings = await db
    .select()
    .from(metaFormFieldMappings)
    .where(and(eq(metaFormFieldMappings.tenantId, tenantId), eq(metaFormFieldMappings.metaFormId, form.id)));
  return { formName: form.formName, mappings };
}

export interface SaveFieldMappingInput {
  id: string; // existing meta_form_field_mappings row id
  mappingType: "system" | "custom";
  systemField?: "fullName" | "phoneNumber" | "email" | null;
  // The DISPLAY label only - the underlying leads.customFields key is
  // deliberately never client-editable (see saveFieldMappings' own
  // comment for why), so a rename can never orphan or split data that's
  // already been written under the old key.
  customFieldLabel?: string | null;
}

/**
 * THE "Save Mapping" action - bulk-updates a set of existing mapping rows
 * (never creates/deletes rows itself; the row set is entirely owned by
 * ensureDefaultFieldMappings above). Every row is re-checked against
 * tenantId AND metaFormRowId so a request can never cross-tenant or
 * cross-form edit. Returns the ids that were actually updated, so the
 * caller can tell a stale/foreign id apart from a real save.
 *
 * customFieldKey is intentionally NEVER taken from the caller - it is
 * either kept exactly as it already was (the common case: the admin is
 * just renaming the label, or flipping mappingType back and forth) or, the
 * first time a row ever becomes "custom" (it was "system" and had no
 * customFieldKey yet), derived once from the row's own metaFieldKey. This
 * guarantees the SAME Meta question always writes to the SAME
 * leads.customFields key for the life of the form, even across repeated
 * relabeling - a rename must never fragment historical lead data across
 * two different keys.
 */
export async function saveFieldMappings(tenantId: string, metaFormRowId: string, updates: SaveFieldMappingInput[]) {
  const db = await getDb();
  const updatedIds: string[] = [];
  for (const update of updates) {
    const [existing] = await db
      .select()
      .from(metaFormFieldMappings)
      .where(
        and(
          eq(metaFormFieldMappings.id, update.id),
          eq(metaFormFieldMappings.tenantId, tenantId),
          eq(metaFormFieldMappings.metaFormId, metaFormRowId),
        ),
      )
      .limit(1);
    if (!existing) continue; // stale/foreign id - silently skipped, not an error

    const customFieldKey = update.mappingType === "custom" ? existing.customFieldKey ?? existing.metaFieldKey : null;

    const rows = await db
      .update(metaFormFieldMappings)
      .set({
        mappingType: update.mappingType,
        systemField: update.mappingType === "system" ? update.systemField ?? null : null,
        customFieldKey,
        customFieldLabel: update.mappingType === "custom" ? update.customFieldLabel ?? customFieldKey : null,
        updatedAt: new Date(),
      })
      .where(eq(metaFormFieldMappings.id, existing.id))
      .returning();
    if (rows[0]) updatedIds.push(rows[0].id);
  }
  return updatedIds;
}

/** Lead counts aren't tracked per-form today (leads only carry formId as
 * Meta's raw text id, same denormalization campaignId uses) - listing
 * helper for the Meta Forms table, joined with a mapped/total question
 * count so the admin screen can show "4 of 5 fields mapped" without a
 * second round trip per form. */
export async function listMetaFormsWithMappingCounts(tenantId: string) {
  const db = await getDb();
  const forms = await db.select().from(metaForms).where(eq(metaForms.tenantId, tenantId));
  if (forms.length === 0) return [];
  const mappings = await db
    .select({ metaFormId: metaFormFieldMappings.metaFormId, mappingType: metaFormFieldMappings.mappingType })
    .from(metaFormFieldMappings)
    .where(
      and(
        eq(metaFormFieldMappings.tenantId, tenantId),
        inArray(
          metaFormFieldMappings.metaFormId,
          forms.map((f) => f.id),
        ),
      ),
    );
  const mappedCountByForm = new Map<string, number>();
  for (const m of mappings) {
    mappedCountByForm.set(m.metaFormId, (mappedCountByForm.get(m.metaFormId) ?? 0) + 1);
  }
  return forms.map((f) => ({
    ...f,
    questionCount: (f.questions as MetaFormQuestion[]).length,
    mappedCount: mappedCountByForm.get(f.id) ?? 0,
  }));
}

export async function getMetaFormById(tenantId: string, metaFormRowId: string) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(metaForms)
    .where(and(eq(metaForms.tenantId, tenantId), eq(metaForms.id, metaFormRowId)))
    .limit(1);
  return row ?? null;
}
