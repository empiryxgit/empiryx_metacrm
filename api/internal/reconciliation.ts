// Two trigger sources are accepted:
//  1. A QStash Schedule (see scripts/setup-schedules.ts) - the PRIMARY
//     trigger, POSTing here every 15 minutes (configurable) with a QStash
//     signature. Not bound by Vercel's own cron limits.
//  2. Vercel's own daily Cron Job (see vercel.json) - a low-frequency
//     fallback in case the QStash schedule is ever deleted or misconfigured.
//     Vercel invokes this via GET and, when CRON_SECRET is set, attaches
//     `Authorization: Bearer <CRON_SECRET>` - see
//     https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs.
//
// Either path is independently sufficient to authenticate the request; if
// neither credential matches, the request is rejected.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Receiver } from "@upstash/qstash";
import { runReconciliation } from "../../src/application/reconcile";

export const config = {
  api: { bodyParser: false },
};

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isAuthorizedVercelCron(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;
  return req.headers.authorization === `Bearer ${cronSecret}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (req.method === "GET") {
    if (!isAuthorizedVercelCron(req)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
  } else {
    const rawBody = await readRawBody(req);
    const signature = req.headers["upstash-signature"];
    const signatureHeader = Array.isArray(signature) ? signature[0] : signature;

    const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
    const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
    if (!currentSigningKey || !nextSigningKey) {
      res.status(500).json({ error: "QStash signing keys are not configured" });
      return;
    }
    try {
      const isValid = await new Receiver({ currentSigningKey, nextSigningKey }).verify({
        signature: signatureHeader ?? "",
        body: rawBody,
      });
      if (!isValid) {
        res.status(401).json({ error: "Invalid QStash signature" });
        return;
      }
    } catch {
      res.status(401).json({ error: "Invalid QStash signature" });
      return;
    }
  }

  try {
    const summary = await runReconciliation();
    console.log("[reconciliation] Completed:", summary);
    res.status(200).json(summary);
  } catch (err) {
    console.error("[reconciliation] Run failed:", err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
}
