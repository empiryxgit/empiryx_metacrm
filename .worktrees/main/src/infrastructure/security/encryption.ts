// AES-256-GCM helpers for secrets-at-rest: each campaign's Meta app secret
// and access token are encrypted before being written to Postgres, keyed by
// a single server-side ENCRYPTION_KEY (32 bytes, base64) that never leaves
// Vercel's environment variables. Losing this key means those two fields
// become unrecoverable - back it up the same way you'd back up a database
// password.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getKey(): Buffer {
  const b64 = process.env.ENCRYPTION_KEY;
  if (!b64) {
    throw new Error(
      "ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

/** Returns `<iv>:<authTag>:<ciphertext>`, all base64, colon-joined. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12); // GCM standard IV size
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(encoded: string): string {
  const [ivB64, tagB64, dataB64] = encoded.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted value.");
  }
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plaintext.toString("utf8");
}

/** Last 4 characters only - safe to display in the UI so an admin can tell configs apart. */
export function maskSecret(plaintext: string): string {
  if (plaintext.length <= 4) return "****";
  return `${"*".repeat(Math.min(plaintext.length - 4, 12))}${plaintext.slice(-4)}`;
}
