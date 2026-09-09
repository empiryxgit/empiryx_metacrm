// Data access for the agency/client access audit trail - see
// agencyAuditLog's own doc comment in schema.ts and
// src/application/agencyAuditLog.ts for the full design. Same
// "repository trusts its caller, no auth/permission decisions of its own"
// split every other repository in this codebase follows - this file does
// not decide WHAT gets logged or validate that `detail` is secret-free;
// that contract is enforced one layer up, in recordAgencyAuditEvent, whose
// typed parameters are the only way any call site can reach this insert.

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../client";
import { agencyAuditLog } from "../schema";
import type { AgencyAuditAction } from "../../../domain/agencyAuditAction";

export interface AgencyAuditLogEntry {
  id: number;
  agencyCompanyId: string;
  agencyUserId: string | null;
  clientCompanyId: string | null;
  action: AgencyAuditAction;
  detail: string | null;
  createdAt: Date;
}

export async function insertAgencyAuditLogEntry(input: {
  agencyCompanyId: string;
  agencyUserId: string | null;
  clientCompanyId: string | null;
  action: AgencyAuditAction;
  detail: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.insert(agencyAuditLog).values({
    agencyCompanyId: input.agencyCompanyId,
    agencyUserId: input.agencyUserId ?? undefined,
    clientCompanyId: input.clientCompanyId ?? undefined,
    action: input.action,
    detail: input.detail ?? undefined,
  });
}

/** Newest-first audit trail for one agency, optionally narrowed to a single
 * client - the query side of "auditable": nothing in this feature currently
 * renders this in the UI (the user only asked that events be recorded), but
 * a repository-level read here makes that a pure frontend/API-route addition
 * later rather than requiring any further data-access work. `limit` is
 * capped at 500 so an unbounded agency history can never be pulled back in
 * one call. */
export async function listAgencyAuditLog(
  agencyCompanyId: string,
  opts: { clientCompanyId?: string; limit?: number } = {},
): Promise<AgencyAuditLogEntry[]> {
  const db = await getDb();
  const limit = Math.min(opts.limit ?? 100, 500);
  const conditions = [eq(agencyAuditLog.agencyCompanyId, agencyCompanyId)];
  if (opts.clientCompanyId) {
    conditions.push(eq(agencyAuditLog.clientCompanyId, opts.clientCompanyId));
  }
  const rows = await db
    .select()
    .from(agencyAuditLog)
    .where(and(...conditions))
    .orderBy(desc(agencyAuditLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    agencyCompanyId: r.agencyCompanyId,
    agencyUserId: r.agencyUserId,
    clientCompanyId: r.clientCompanyId,
    action: r.action as AgencyAuditAction,
    detail: r.detail,
    createdAt: r.createdAt,
  }));
}
