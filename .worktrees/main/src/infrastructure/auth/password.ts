// bcryptjs is a pure-JS implementation (no native bindings) - deliberately
// chosen over bcrypt/argon2 native modules, which are a common source of
// broken deploys on serverless platforms whose build/runtime environment
// doesn't match the one the binary was compiled for.
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

export function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, SALT_ROUNDS);
}

export function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

const TEMP_PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";

/** Used by the admin "create user" form to generate a temporary password shown once on screen. */
export function generateTempPassword(length = 14): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => TEMP_PASSWORD_CHARS[b % TEMP_PASSWORD_CHARS.length]).join("");
}
