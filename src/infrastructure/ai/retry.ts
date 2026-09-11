// Generic retry-with-backoff helper for the RUTA AI orchestration layer
// (src/application/metaSync/rutaAiAssistant.ts and its AI provider - see
// aiProvider.ts in this same directory). Mirrors the exact backoff shape
// src/infrastructure/meta/graphClient.ts's fetchWithRetry/fetchWithRetryJson
// already use elsewhere in this codebase (250ms * 2^attempt, capped attempt
// count) rather than inventing a different retry policy - kept here as its
// own small, reusable utility (instead of copy-pasted a third time) since
// the AI provider call is a genuinely separate call site from the Graph API
// ones those two already cover.
//
// Deliberately stateless - no module-level mutable state, no per-caller
// memory of past attempts kept anywhere. Every call to withRetry() is fully
// self-contained, so concurrent callers (e.g. two different tenants' users
// messaging RUTA at the same time, each running their own retry loop) can
// never observe or influence each other's attempt count/backoff.

export interface RetryOptions {
  /** Total attempts including the first (not "extra retries") - e.g. 3 means
   * "try, and if it fails retryably, try up to 2 more times." */
  attempts?: number;
  /** Base delay for the first retry; doubles on each subsequent one. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay, however high `attempts` goes. */
  maxDelayMs?: number;
  /** Decides whether a given error is worth retrying at all - e.g. a 4xx
   * "bad request" from an AI provider will never succeed on retry, but a
   * 429/5xx or a network/timeout error might. Defaults to "retry everything"
   * when omitted, since most callers only reach here for already-narrowed
   * transient failure modes. */
  shouldRetry?: (err: unknown) => boolean;
  /** Short label used only in the log line for a failed attempt - helps
   * distinguish "AI classify" retries from "WhatsApp send" retries etc. in
   * shared logs without threading a logger instance through this generic
   * helper. */
  label?: string;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 4000;

function backoffDelay(attemptIndex: number, baseDelayMs: number, maxDelayMs: number): number {
  return Math.min(baseDelayMs * 2 ** attemptIndex, maxDelayMs);
}

/**
 * Runs `fn`, retrying on failure per `opts`. Re-throws the LAST error once
 * every attempt is exhausted (or as soon as `shouldRetry` says an error
 * isn't retryable at all) - never swallows a failure silently; that's left
 * entirely to the caller (every call site in this codebase wraps this in
 * its own try/catch and decides what "give up" means for it).
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const shouldRetry = opts.shouldRetry ?? (() => true);

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === attempts - 1;
      if (isLastAttempt || !shouldRetry(err)) throw err;
      console.warn(`[retry]${opts.label ? ` ${opts.label}` : ""} attempt ${attempt + 1}/${attempts} failed, retrying:`, err);
      await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, baseDelayMs, maxDelayMs)));
    }
  }
  // Unreachable (the loop above always either returns or throws), but keeps
  // TypeScript's control-flow analysis happy without a non-null assertion.
  throw lastError;
}
