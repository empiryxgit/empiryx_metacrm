// Data access for the agency/client access audit trail - see
// agencyAuditLog's own doc comment in schema.ts and
// src/application/agencyAuditLog.ts for the full design. Same
// "repository trusts its caller, no auth/permission decisions of its own"
// split every other repository in this codebase follows - this file does
// not decide WHAT gets logged or validate that `detail` is secret-free;
// that contract is enforced one layer up, in recordAgencyAuditEvent, whose
// typed parameters are the only way any call site can reach this insert.

import { and, desc, eq, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../client";
import { agencyAuditLog, companies, users } from "../schema";
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

// ---------------------------------------------------------------------------
// Platform Admin "Customer Activity" - the cross-customer read of this same
// table (see this table's own doc comment above and in schema.ts). Every
// function above this point is scoped to ONE agency (the ordinary in-app
// "Audit Log" a tenant would eventually see for their own account, per this
// file's own header comment - never built as a UI); the function below is
// scoped to ALL customers at once, and is the one this feature's new
// public/admin/customer-activity.html page actually calls, joined to
// companies.name on both sides purely for display (the raw ids alone mean
// nothing to a platform admin reading the page). This is deliberately the
// ONLY cross-customer table this app's audit trail can surface - see this
// feature's own status-doc write-up for why (individual, non-agency
// accounts have no audit trail of their own to join in here; this table
// only ever records agency/client-relationship events, never general
// campaign/lead/user edits).
// ---------------------------------------------------------------------------

export interface CustomerActivityEntry {
  id: number;
  createdAt: Date;
  action: AgencyAuditAction;
  detail: string | null;
  agencyCompanyId: string;
  agencyCompanyName: string | null;
  agencyUserId: string | null;
  agencyUserEmail: string | null;
  clientCompanyId: string | null;
  clientCompanyName: string | null;
}

/** `companyId`, when given, matches a customer either as the acting AGENCY
 * or as the CLIENT the event concerns (a company can appear on either side
 * across different rows) - "show me everything involving this customer",
 * not "show me only rows where this customer was the actor". `limit` is
 * capped at 200 (matching the existing platform Audit Logs page's own cap
 * in listPlatformAuditLogs) with simple offset paging - this table is
 * write-light enough (agency/client relationship events only, never every
 * in-app action) that offset drift from concurrent inserts is not a real
 * concern the way it would be for a high-volume log. */
export async function listAllAgencyAuditLogAcrossCustomers(opts: {
  companyId?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ entries: CustomerActivityEntry[]; hasMore: boolean }> {
  const db = await getDb();
  const limit = Math.min(opts.limit ?? 50, 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const clientCompanies = alias(companies, "client_companies");

  const whereClause = opts.companyId
    ? or(eq(agencyAuditLog.agencyCompanyId, opts.companyId), eq(agencyAuditLog.clientCompanyId, opts.companyId))
    : undefined;

  const rows = await db
    .select({
      id: agencyAuditLog.id,
      createdAt: agencyAuditLog.createdAt,
      action: agencyAuditLog.action,
      detail: agencyAuditLog.detail,
      agencyCompanyId: agencyAuditLog.agencyCompanyId,
      agencyCompanyName: companies.name,
      agencyUserId: agencyAuditLog.agencyUserId,
      agencyUserEmail: users.email,
      clientCompanyId: agencyAuditLog.clientCompanyId,
      clientCompanyName: clientCompanies.name,
    })
    .from(agencyAuditLog)
    .leftJoin(companies, eq(companies.id, agencyAuditLog.agencyCompanyId))
    .leftJoin(clientCompanies, eq(clientCompanies.id, agencyAuditLog.clientCompanyId))
    .leftJoin(users, eq(users.id, agencyAuditLog.agencyUserId))
    .where(whereClause)
    .orderBy(desc(agencyAuditLog.createdAt))
    .limit(limit + 1)
    .offset(offset);

  const hasMore = rows.length > limit;
  const entries = rows.slice(0, limit).map((r) => ({ ...r, action: r.action as AgencyAuditAction }));
  return { entries, hasMore };
}
