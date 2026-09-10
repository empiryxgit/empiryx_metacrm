import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "./verifySignature";

const SECRET = "test-secret";

describe("verifyMetaSignature", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const digest = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(verifyMetaSignature(body, `sha256=${digest}`, SECRET)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const digest = createHmac("sha256", "wrong-secret").update(body, "utf8").digest("hex");
    expect(verifyMetaSignature(body, `sha256=${digest}`, SECRET)).toBe(false);
  });

  it("rejects a missing signature header", () => {
    expect(verifyMetaSignature("{}", null, SECRET)).toBe(false);
  });

  it("rejects a malformed signature header", () => {
    expect(verifyMetaSignature("{}", "not-a-real-signature", SECRET)).toBe(false);
  });

  it("rejects a tampered body even with a header that was valid for the original body", () => {
    const original = JSON.stringify({ object: "page", entry: [1] });
    const tampered = JSON.stringify({ object: "page", entry: [1, 2] });
    const digest = createHmac("sha256", SECRET).update(original, "utf8").digest("hex");
    expect(verifyMetaSignature(tampered, `sha256=${digest}`, SECRET)).toBe(false);
  });

  it("rejects when verified against a different campaign's secret", () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const digest = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    expect(verifyMetaSignature(body, `sha256=${digest}`, "some-other-campaigns-secret")).toBe(false);
  });
});
