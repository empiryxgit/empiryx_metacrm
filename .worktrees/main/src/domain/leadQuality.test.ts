import { describe, expect, it } from "vitest";
import { computeLeadQuality } from "./leadQuality";

describe("computeLeadQuality", () => {
  it("scores a fully complete, plausible lead as hot", () => {
    const result = computeLeadQuality({
      fullName: "Priya Sharma",
      email: "priya.sharma@gmail.com",
      phoneNumber: "+91 98765 43210",
      formResponses: [{ name: "budget", values: ["7500000"] }],
    });
    expect(result.label).toBe("hot");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.flags).toHaveLength(0);
  });

  it("flags a repeated-digit phone number as likely fake regardless of other fields", () => {
    const result = computeLeadQuality({
      fullName: "Priya Sharma",
      email: "priya.sharma@gmail.com",
      phoneNumber: "1111111111",
      formResponses: [{ name: "budget", values: ["7500000"] }],
    });
    expect(result.label).toBe("likely_fake");
    expect(result.score).toBeLessThanOrEqual(30);
    expect(result.flags.some((f) => f.includes("repeated-digit"))).toBe(true);
  });

  it("flags a sequential-digit phone number as likely fake", () => {
    const result = computeLeadQuality({ phoneNumber: "1234567890" });
    expect(result.label).toBe("likely_fake");
    expect(result.flags.some((f) => f.includes("sequential-digit"))).toBe(true);
  });

  it("flags a disposable email domain as likely fake", () => {
    const result = computeLeadQuality({
      fullName: "John Doe",
      email: "someone@mailinator.com",
      phoneNumber: "9847562130",
    });
    expect(result.label).toBe("likely_fake");
    expect(result.flags.some((f) => f.includes("disposable"))).toBe(true);
  });

  it("flags placeholder-looking text in the name field", () => {
    const result = computeLeadQuality({
      fullName: "test",
      email: "real.person@gmail.com",
      phoneNumber: "9847562130",
    });
    expect(result.label).toBe("likely_fake");
    expect(result.flags.some((f) => f.includes("placeholder"))).toBe(true);
  });

  it("never produces a hard fake flag for missing (not invalid) contact info - just a softer score", () => {
    const result = computeLeadQuality({ fullName: "John Doe" });
    expect(result.label).not.toBe("likely_fake");
    expect(result.flags).toContain("No phone number provided");
    expect(result.flags).toContain("No email address provided");
  });

  it("factors in a recent-duplicate-submission signal without forcing likely_fake by itself", () => {
    const withoutDup = computeLeadQuality({
      fullName: "Priya Sharma",
      email: "priya.sharma@gmail.com",
      phoneNumber: "9847562130",
    });
    const withDup = computeLeadQuality({
      fullName: "Priya Sharma",
      email: "priya.sharma@gmail.com",
      phoneNumber: "9847562130",
      isRecentDuplicateSubmission: true,
    });
    expect(withDup.score).toBeLessThan(withoutDup.score);
    expect(withDup.label).not.toBe("likely_fake");
    expect(withDup.flags.some((f) => f.includes("submitted another lead recently"))).toBe(true);
  });

  it("flags an empty form-responses submission", () => {
    const result = computeLeadQuality({
      fullName: "Priya Sharma",
      email: "priya.sharma@gmail.com",
      phoneNumber: "9847562130",
      formResponses: [],
    });
    expect(result.flags).toContain("Form was submitted with no additional responses");
  });

  it("always returns a score clamped to [0, 100]", () => {
    const result = computeLeadQuality({
      fullName: "x",
      email: "test@mailinator.com",
      phoneNumber: "111",
      formResponses: [],
      isRecentDuplicateSubmission: true,
    });
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
