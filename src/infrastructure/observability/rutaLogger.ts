// Structured logging for the RUTA AI orchestration layer only (see
// src/application/metaSync/rutaAiAssistant.ts) - deliberately scoped here
// rather than replacing every console.error in this codebase, which mostly
// already follows its own "[scope] message: err" convention and isn't part
// of this feature. RUTA's own log lines get a consistent, greppable JSON
// shape instead, since this is the one path in the app where a single
// inbound event (one WhatsApp message) fans out through several distinct
// stages - rate limit, session, authorization, AI classification, tool
// execution, reply - and being able to filter/aggregate by tenantId,
// userId, or waMessageId across all of them (in whatever log platform reads
// Vercel's stdout/stderr) matters more here than anywhere else in the app.
//
// Never throws, never blocks - logging a line is fire-and-forget by nature
// (console.log/console.error/console.warn are synchronous and can't fail in
// a way any caller needs to handle).

export type RutaLogLevel = "info" | "warn" | "error";

export interface RutaLogFields {
  tenantId?: string;
  userId?: string;
  waMessageId?: string;
  intent?: string;
  provider?: string;
  attempt?: number;
  durationMs?: number;
  [key: string]: unknown;
}

function write(level: RutaLogLevel, event: string, fields: RutaLogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, layer: "ruta-ai-orchestrator", event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** One logger per log line, not a stateful instance - there is deliberately
 * nothing here for a caller to hold onto and mutate across calls (no
 * "current request" object, no counters), so nothing about it can leak
 * between concurrently-handled messages from different users. */
export const rutaLog = {
  info: (event: string, fields: RutaLogFields = {}) => write("info", event, fields),
  warn: (event: string, fields: RutaLogFields = {}) => write("warn", event, fields),
  error: (event: string, fields: RutaLogFields = {}) => write("error", event, fields),
};
