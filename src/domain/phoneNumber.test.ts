import { describe, expect, it } from "vitest";
import { isValidE164 } from "./phoneNumber";

describe("isValidE164", () => {
  it("accepts a plausible E.164 number", () => {
    expect(isValidE164("+14155238886")).toBe(true);
    expect(isValidE164("+919876543210")).toBe(true);
  });

  it("rejects a number missing the leading +", () => {
    expect(isValidE164("14155238886")).toBe(false);
  });

  it("rejects a number starting with 0 after the +", () => {
    expect(isValidE164("+0123456789")).toBe(false);
  });

  it("rejects non-digit characters", () => {
    expect(isValidE164("+1415523-8886")).toBe(false);
    expect(isValidE164("+1 415 523 8886")).toBe(false);
  });

  it("rejects too-short and too-long values", () => {
    expect(isValidE164("+123")).toBe(false);
    expect(isValidE164("+1234567890123456")).toBe(false);
  });

  it("rejects empty and whitespace-only values", () => {
    expect(isValidE164("")).toBe(false);
    expect(isValidE164("   ")).toBe(false);
  });
});
