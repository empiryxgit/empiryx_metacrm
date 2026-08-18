// Dashboard summary - the single aggregation endpoint backing the CRM
// dashboard (public/dashboard.html). Everything here is derived from real
// rows in `leads`/`campaigns`/`users` for the caller's own company; nothing
// is fabricated, and no ingestion/webhook/retry internals are exposed -
// this is a business-facing view (see PIPELINES/leads for the operational
// one).
//
// METHODOLOGY (documented once, here, since several sections share it):
// There is no stage-change history table, so "how many leads reached
// Qualified/Won during this period" is answered cohort-style: take the
// leads CREATED in the period, then look at their CURRENT pipeline stage.
// This is honest (nothing is invented) and simple, at the cost of slightly
// under-reporting very recent periods, where a lead created yesterday
// hasn't had time to progress yet. That's a real, expected property of
// cohort funnels, not a bug.
//
// A lead's CURRENT stage index (position within template.stages) is what
// "has this lead reached at least Qualified/the milestone stage" is judged
// against - but a "lost" lead's stage sits at the END of the stages array
// (after Won), which would otherwise make every lost lead look like it had
// reached every stage. classify() below explicitly excludes lost leads
// from reached-Qualified/reached-milestone so that bug can't happen.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../../src/infrastructure/db/client";
import { leads } from "../../src/infrastructure/db/schema";
import { requirePermission } from "../../src/infrastructure/auth/context";
import { PERMISSIONS } from "../../src/domain/permissions";
import { getCompanyById, listUsers } from "../../src/infrastructure/db/repositories/tenancy";
import { listCampaigns } from "../../src/infrastructure/db/repositories/campaigns";
import { getIndustryTemplate, resolveStageKey, LEAD_SOURCES, type IndustryTemplate } from "../../src/domain/industryTemplates";

const DAY_MS = 24 * 60 * 60 * 1000;

function getQueryString(req: VercelRequest, key: string): string | undefined {
  const value = req.query[key];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function getRangeBounds(req: VercelRequest) {
  const now = new Date();
  const rangeKey = getQueryString(req, "range") || "30d";

  let start: Date;
  let end: Date = now;

  if (rangeKey === "custom") {
    const fromStr = getQueryString(req, "from");
    const toStr = getQueryString(req, "to");
    const from = fromStr ? new Date(fromStr) : null;
    const to = toStr ? new Date(toStr) : null;
    start = from && !Number.isNaN(from.getTime()) ? from : new Date(now.getTime() - 30 * DAY_MS);
    end = to && !Number.isNaN(to.getTime()) ? new Date(to.getTime() + DAY_MS - 1) : now;
  } else if (rangeKey === "today") {
    start = new Date(now.getTime() - DAY_MS);
  } else if (rangeKey === "7d") {
    start = new Date(now.getTime() - 7 * DAY_MS);
  } else {
    start = new Date(now.getTime() - 30 * DAY_MS);
  }
  if (end.getTime() <= start.getTime()) end = new Date(start.getTime() + DAY_MS);

  const lengthMs = end.getTime() - start.getTime();
  const prevEnd = start;
  const prevStart = new Date(start.getTime() - lengthMs);
  const days = Math.max(1, Math.round(lengthMs / DAY_MS));
  return { rangeKey, start, end, prevStart, prevEnd, days };
}

function deltaPct(curr: number, prev: number): number | null {
  if (prev === 0) return curr === 0 ? 0 : null; // null = "no prior baseline" (frontend shows "New")
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

type LeadRow = typeof leads.$inferSelect;

interface Classified {
  stageKey: string;
  stageLabel: string;
  idx: number;
  isLost: boolean;
  isWon: boolean;
  reachedQualified: boolean;
  reachedMilestone: boolean;
}

function buildClassifier(template: IndustryTemplate) {
  const byKey = new Map(template.stages.map((s, i) => [s.key, { ...s, idx: i }]));
  const qualifiedIdx = template.stages.findIndex((s) => s.isQualified);
  const milestoneIdx = template.stages.findIndex((s) => s.isMilestone);

  return function classify(row: LeadRow): Classified {
    const stageKey = resolveStageKey(template, row.pipelineStage);
    const def = byKey.get(stageKey)!;
    const isLost = Boolean(def.isClosed && !def.isWon);
    return {
      stageKey,
      stageLabel: def.label,
      idx: def.idx,
      isLost,
      isWon: Boolean(def.isWon),
      reachedQualified: qualifiedIdx >= 0 && def.idx >= qualifiedIdx && !isLost,
      reachedMilestone: milestoneIdx >= 0 && def.idx >= milestoneIdx && !isLost,
    };
  };
}

function inRange(date: Date | null, start: Date, end: Date): boolean {
  return Boolean(date && date >= start && date < end);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const auth = await requirePermission(req, res, PERMISSIONS.DASHBOARD_VIEW);
  if (!auth) return;

  const company = await getCompanyById(auth.companyId);
  if (!company) {
    res.status(401).json({ error: "Account no longer exists." });
    return;
  }
  const template = getIndustryTemplate(company.industryTemplate);
  const classify = buildClassifier(template);
  const { rangeKey, start, end, prevStart, prevEnd, days } = getRangeBounds(req);

  const db = await getDb();
  const [allLeads, campaigns, users] = await Promise.all([
    db.select().from(leads).where(eq(leads.companyId, auth.companyId)).orderBy(desc(leads.createdAt)),
    listCampaigns(auth.companyId),
    listUsers(auth.companyId),
  ]);

  const ownerNameById = new Map(users.map((u) => [u.id, u.fullName]));
  const campaignNameById = new Map(campaigns.map((c) => [c.id, c.name]));

  // ---- KPIs -----------------------------------------------------------
  const totalLeadsNow = allLeads.length;
  const totalLeadsBeforeRange = allLeads.filter((l) => l.createdAt < start).length;

  const cohort = (from: Date, to: Date) => allLeads.filter((l) => inRange(l.createdAt, from, to));
  const currentCohort = cohort(start, end);
  const previousCohort = cohort(prevStart, prevEnd);

  function summarize(rows: LeadRow[]) {
    let qualified = 0;
    let milestone = 0;
    let won = 0;
    for (const row of rows) {
      const c = classify(row);
      if (c.reachedQualified) qualified++;
      if (c.reachedMilestone) milestone++;
      if (c.isWon) won++;
    }
    return { newLeads: rows.length, qualified, milestone, won };
  }

  const curr = summarize(currentCohort);
  const prev = summarize(previousCohort);
  const currConversion = curr.newLeads > 0 ? Math.round((curr.won / curr.newLeads) * 1000) / 10 : 0;
  const prevConversion = prev.newLeads > 0 ? Math.round((prev.won / prev.newLeads) * 1000) / 10 : 0;

  const kpis = {
    totalLeads: {
      value: totalLeadsNow,
      previous: totalLeadsBeforeRange,
      deltaPct: deltaPct(totalLeadsNow, totalLeadsBeforeRange),
    },
    newLeads: { value: curr.newLeads, previous: prev.newLeads, deltaPct: deltaPct(curr.newLeads, prev.newLeads) },
    qualified: { value: curr.qualified, previous: prev.qualified, deltaPct: deltaPct(curr.qualified, prev.qualified) },
    milestone: {
      label: template.milestoneLabel,
      value: curr.milestone,
      previous: prev.milestone,
      deltaPct: deltaPct(curr.milestone, prev.milestone),
    },
    won: { value: curr.won, previous: prev.won, deltaPct: deltaPct(curr.won, prev.won) },
    conversionRate: { value: currConversion, previous: prevConversion, deltaPoints: Math.round((currConversion - prevConversion) * 10) / 10 },
  };

  // ---- Lead performance chart ------------------------------------------
  // Cohort methodology per-bucket: a bucket's "new" is leads created in
  // that bucket; "qualified"/"won" are, of THOSE SAME leads, how many have
  // (as of now) reached that stage - not a live event stream.
  const bucketMs = days > 60 ? 7 * DAY_MS : DAY_MS;
  const buckets: Array<{ date: string; new: number; qualified: number; won: number }> = [];
  for (let t = start.getTime(); t < end.getTime(); t += bucketMs) {
    const bucketStart = new Date(t);
    const bucketEnd = new Date(Math.min(t + bucketMs, end.getTime()));
    const rows = cohort(bucketStart, bucketEnd);
    const s = summarize(rows);
    buckets.push({ date: bucketStart.toISOString(), new: s.newLeads, qualified: s.qualified, won: s.won });
  }

  // ---- Pipeline overview (live snapshot, not date-filtered) ------------
  const stageCounts = new Map<string, number>();
  for (const row of allLeads) {
    const key = classify(row).stageKey;
    stageCounts.set(key, (stageCounts.get(key) ?? 0) + 1);
  }
  const funnel = template.stages.map((s) => ({
    key: s.key,
    label: s.label,
    count: stageCounts.get(s.key) ?? 0,
    isWon: Boolean(s.isWon),
    isClosed: Boolean(s.isClosed),
  }));

  // ---- Lead source (date-range scoped) ---------------------------------
  const sourceCounts = new Map<string, number>();
  for (const row of currentCohort) {
    sourceCounts.set(row.source, (sourceCounts.get(row.source) ?? 0) + 1);
  }
  const sourceLabel = (key: string) => LEAD_SOURCES.find((s) => s.key === key)?.label ?? key;
  const sources = [...sourceCounts.entries()]
    .map(([key, count]) => ({
      key,
      label: sourceLabel(key),
      count,
      percent: currentCohort.length > 0 ? Math.round((count / currentCohort.length) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // ---- Campaign performance (cohort: leads created in range, judged by
  // current stage) ------------------------------------------------------
  const byCampaign = new Map<string, LeadRow[]>();
  for (const row of currentCohort) {
    if (!row.crmCampaignId) continue;
    const list = byCampaign.get(row.crmCampaignId) ?? [];
    list.push(row);
    byCampaign.set(row.crmCampaignId, list);
  }
  const campaignRows = [...byCampaign.entries()]
    .map(([campaignId, rows]) => {
      const s = summarize(rows);
      return {
        id: campaignId,
        name: campaignNameById.get(campaignId) ?? "Unknown campaign",
        leads: s.newLeads,
        qualified: s.qualified,
        won: s.won,
        conversionRate: s.newLeads > 0 ? Math.round((s.won / s.newLeads) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.leads - a.leads);

  // ---- Recent activity (derived from createdAt/updatedAt - no separate
  // audit table exists, so this is the honest signal available) --------
  const lookback = new Date(Date.now() - 2 * DAY_MS);
  const recentlyCreated = allLeads.filter((l) => l.createdAt >= lookback);
  const activity: Array<{ text: string; timestamp: string }> = [];

  const newByCampaign = new Map<string, LeadRow[]>();
  const newDirect: LeadRow[] = [];
  for (const row of recentlyCreated) {
    if (row.crmCampaignId) {
      const list = newByCampaign.get(row.crmCampaignId) ?? [];
      list.push(row);
      newByCampaign.set(row.crmCampaignId, list);
    } else {
      newDirect.push(row);
    }
  }
  for (const [campaignId, rows] of newByCampaign) {
    if (rows.length >= 2) {
      const latest = rows.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      activity.push({
        text: `${campaignNameById.get(campaignId) ?? "A campaign"} generated ${rows.length} new leads`,
        timestamp: latest.createdAt.toISOString(),
      });
    } else if (rows[0]) {
      const row = rows[0];
      activity.push({ text: `${row.fullName || "A new lead"} came in via ${sourceLabel(row.source)}`, timestamp: row.createdAt.toISOString() });
    }
  }
  for (const row of newDirect) {
    activity.push({
      text: row.leadType === "manual_customer" ? `${row.fullName || "A customer"} added as customer` : `${row.fullName || "A new lead"} came in via ${sourceLabel(row.source)}`,
      timestamp: row.createdAt.toISOString(),
    });
  }
  // Stage-progress: updatedAt meaningfully after createdAt (more than a
  // minute) means the record was actually touched after being created,
  // not just written once.
  for (const row of allLeads) {
    if (!row.updatedAt || row.updatedAt < lookback) continue;
    if (row.updatedAt.getTime() - row.createdAt.getTime() < 60_000) continue;
    activity.push({ text: `${row.fullName || "A lead"} moved to ${classify(row).stageLabel}`, timestamp: row.updatedAt.toISOString() });
  }
  activity.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

  // ---- Upcoming follow-ups (not date-range scoped - always "what's
  // next", overdue items included and sorted first) --------------------
  const followUps = allLeads
    .filter((l) => l.nextFollowUpAt && !classify(l).isLost)
    .sort((a, b) => (a.nextFollowUpAt! < b.nextFollowUpAt! ? -1 : 1))
    .slice(0, 8)
    .map((l) => ({
      id: l.id,
      name: l.fullName || "Unnamed lead",
      stage: classify(l).stageLabel,
      nextFollowUpAt: l.nextFollowUpAt!.toISOString(),
      owner: l.ownerId ? ownerNameById.get(l.ownerId) ?? null : null,
    }));

  res.status(200).json({
    range: { key: rangeKey, start: start.toISOString(), end: end.toISOString(), days },
    template: {
      key: template.key,
      name: template.name,
      milestoneLabel: template.milestoneLabel,
      stages: template.stages.map((s) => ({ key: s.key, label: s.label, isWon: Boolean(s.isWon), isClosed: Boolean(s.isClosed) })),
    },
    kpis,
    chart: buckets,
    funnel,
    sources,
    campaigns: campaignRows,
    activity: activity.slice(0, 8),
    followUps,
  });
}
