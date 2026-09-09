// Rule-based lead quality scoring (v1) - no framework or vendor imports
// belong in this file, same "keep it pure" convention as types.ts.
//
// Deliberately rule-based rather than an AI/LLM call for this first pass:
// every flag below is a concrete, verifiable fact (a phone number pattern,
// an email domain, a placeholder-looking name) a person can check for
// themselves, it costs nothing per lead, runs instantly, and needs no new
// API key/vendor dependency. A future pass can layer an LLM-based score on
// top of this without removing it - see leads.qualityFlags, which is
// designed to keep accumulating human-readable reasons regardless of what
// eventually computes them.
//
// The one signal this file cannot compute itself - whether another lead
// with the same phone/email was captured recently - needs a DB read, which
// would break the "no I/O" contract every other domain-layer file in this
// codebase keeps. The caller (see hasRecentLeadWithSameContact in
// repositories.ts) does that lookup and passes the answer in as a plain
// boolean via isRecentDuplicateSubmission below.
//
// A lead that fails to get scored (a DB error on the duplicate lookup, or
// any other failure) must never fail to be SAVED - scoring is enrichment,
// not a gate. Callers are expected to wrap this in their own try/catch and
// fall back to leaving qualityScore/qualityLabel/qualityFlags null (see
// scoreLeadSafely in repositories.ts) rather than ever losing a lead over
// a scoring failure - same "never lose a lead even if enrichment fails"
// principle every other enrichment step in this codebase already follows.

export type LeadQualityLabel = "hot" | "warm" | "cold" | "likely_fake";

export interface LeadQualityResult {
  score: number; // 0-100, higher is better
  label: LeadQualityLabel;
  flags: string[]; // human-readable reasons, shown as-is in the UI (see pipeline.html)
}

export interface LeadQualitySignals {
  fullName?: string | null;
  email?: string | null;
  phoneNumber?: string | null;
  formResponses?: unknown;
  // Whether this tenant already captured another lead with the same phone
  // number or email within the recent-duplicate window (see
  // hasRecentLeadWithSameContact) - a real bot/duplicate-submission signal,
  // though never decisive on its own: a genuine person re-submitting an ad
  // they saw twice is a normal, non-malicious reason this can happen too.
  isRecentDuplicateSubmission?: boolean;
}

// A short, fixed list of well-known disposable/throwaway email providers -
// not exhaustive (new ones appear constantly), just enough to catch the
// obvious, common cases without an external list/API dependency for a v1,
// rule-based feature.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "mailinator.com",
  "tempmail.com",
  "temp-mail.org",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "trashmail.com",
  "throwawaymail.com",
  "fakeinbox.com",
  "getnada.com",
  "sharklasers.com",
  "dispostable.com",
  "maildrop.cc",
  "mintemail.com",
  "moakt.com",
]);

const PLACEHOLDER_WORDS = new Set(["test", "fake", "asdf", "qwerty", "abc", "xxx", "none", "na", "notreal", "nomail", "sample", "demo"]);

function onlyDigits(value: string): string {
  return value.replace(/\D/g, "");
}

function isAllSameChar(value: string): boolean {
  return value.length > 0 && new Set(value).size === 1;
}

// e.g. "1234567890" or "9876543210" - every digit exactly one more/less
// than its neighbor, mod 10 so the 9->0 (and 0->9) wraparound still counts
// as sequential rather than breaking the run right at the classic
// "1234567890" spam pattern.
function isSequentialDigits(digits: string): boolean {
  if (digits.length < 6) return false;
  const values = digits.split("").map(Number);
  let ascending = true;
  let descending = true;
  for (let i = 1; i < values.length; i++) {
    const diff = ((values[i]! - values[i - 1]!) % 10 + 10) % 10;
    if (diff !== 1) ascending = false;
    if (diff !== 9) descending = false;
  }
  return ascending || descending;
}

interface CheckResult {
  flags: string[];
  penalty: number;
  hardFlag: boolean; // a near-certain bot/junk signal, decisive regardless of overall score
}

function checkPhoneNumber(phoneNumber: string | null | undefined): CheckResult {
  const trimmed = (phoneNumber ?? "").trim();
  if (!trimmed) {
    return { flags: ["No phone number provided"], penalty: 15, hardFlag: false };
  }
  const digits = onlyDigits(trimmed);
  if (digits.length < 7) {
    return { flags: ["Phone number is too short to be valid"], penalty: 30, hardFlag: true };
  }
  if (isAllSameChar(digits)) {
    return { flags: ["Phone number is a repeated-digit pattern (e.g. 1111111111)"], penalty: 40, hardFlag: true };
  }
  if (isSequentialDigits(digits)) {
    return { flags: ["Phone number is a sequential-digit pattern (e.g. 1234567890)"], penalty: 40, hardFlag: true };
  }
  return { flags: [], penalty: 0, hardFlag: false };
}

function checkEmail(email: string | null | undefined): CheckResult {
  const trimmed = (email ?? "").trim().toLowerCase();
  if (!trimmed) {
    return { flags: ["No email address provided"], penalty: 10, hardFlag: false };
  }
  const match = trimmed.match(/^([^@\s]+)@([^@\s]+\.[^@\s]+)$/);
  if (!match) {
    return { flags: ["Email address is not validly formatted"], penalty: 25, hardFlag: true };
  }
  const localPart = match[1] ?? "";
  const domain = match[2] ?? "";
  const flags: string[] = [];
  let penalty = 0;
  let hardFlag = false;
  if (DISPOSABLE_EMAIL_DOMAINS.has(domain)) {
    flags.push(`Email uses a disposable/throwaway domain (${domain})`);
    penalty += 35;
    hardFlag = true;
  }
  if (PLACEHOLDER_WORDS.has(localPart) || isAllSameChar(localPart)) {
    flags.push("Email address looks like placeholder text");
    penalty += 30;
    hardFlag = true;
  }
  return { flags, penalty, hardFlag };
}

function checkName(fullName: string | null | undefined): CheckResult {
  const trimmed = (fullName ?? "").trim();
  if (!trimmed) {
    return { flags: ["No name provided"], penalty: 10, hardFlag: false };
  }
  const lower = trimmed.toLowerCase();
  const collapsed = trimmed.replace(/\s/g, "");
  if (trimmed.length <= 2 || isAllSameChar(collapsed) || PLACEHOLDER_WORDS.has(lower) || /^\d+$/.test(collapsed)) {
    return { flags: ["Name looks like placeholder text"], penalty: 25, hardFlag: true };
  }
  return { flags: [], penalty: 0, hardFlag: false };
}

function checkFormResponses(formResponses: unknown): { flags: string[]; penalty: number } {
  const isEmptyArray = Array.isArray(formResponses) && formResponses.length === 0;
  const isEmptyObject =
    formResponses != null && typeof formResponses === "object" && !Array.isArray(formResponses) && Object.keys(formResponses).length === 0;
  if (formResponses == null || isEmptyArray || isEmptyObject) {
    return { flags: ["Form was submitted with no additional responses"], penalty: 10 };
  }
  return { flags: [], penalty: 0 };
}

/** Scores one lead's contact-quality signals. Pure and synchronous other
 * than the pre-computed isRecentDuplicateSubmission flag - see this file's
 * header comment for why that one check has to live outside this
 * function. A hard flag (an invalid/patterned phone, a disposable email
 * domain, placeholder-looking text) caps the score at 30 and forces the
 * "likely_fake" label regardless of the numeric total, so one strong
 * signal is never diluted/hidden by otherwise-complete form data. */
export function computeLeadQuality(signals: LeadQualitySignals): LeadQualityResult {
  const phone = checkPhoneNumber(signals.phoneNumber);
  const email = checkEmail(signals.email);
  const name = checkName(signals.fullName);
  const form = checkFormResponses(signals.formResponses);

  const flags = [...phone.flags, ...email.flags, ...name.flags, ...form.flags];
  let penalty = phone.penalty + email.penalty + name.penalty + form.penalty;

  if (signals.isRecentDuplicateSubmission) {
    flags.push("Same phone number or email submitted another lead recently");
    penalty += 20;
  }

  const hardFlag = phone.hardFlag || email.hardFlag || name.hardFlag;
  let score = Math.max(0, Math.min(100, 100 - penalty));

  let label: LeadQualityLabel;
  if (hardFlag) {
    score = Math.min(score, 30);
    label = "likely_fake";
  } else if (score >= 80) {
    label = "hot";
  } else if (score >= 50) {
    label = "warm";
  } else {
    label = "cold";
  }

  return { score, label, flags };
}
