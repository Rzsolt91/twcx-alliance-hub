/**
 * Email at rest: AES-256-GCM ciphertext plus a separate HMAC for lookups.
 * Keys come from the environment only — never log them or the plaintext.
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function readKey(name: "EMAIL_ENCRYPTION_KEY" | "EMAIL_HMAC_KEY") {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) {
    throw new Error(`${name} is not set. Add it to the environment (see .env.example).`);
  }
  const buf = raw.length === 64 && /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) {
    throw new Error(`${name} must decode to 32 bytes (64 hex chars or 32-byte base64).`);
  }
  return buf;
}

export function normaliseEmail(value: string) {
  return String(value ?? "").trim().toLowerCase();
}

/** AES-256-GCM; stored as base64(iv + authTag + ciphertext). */
export function encryptEmail(email: string): string {
  const normalised = normaliseEmail(email);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, readKey("EMAIL_ENCRYPTION_KEY"), iv);
  const encrypted = Buffer.concat([cipher.update(normalised, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export function decryptEmail(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < IV_BYTES + TAG_BYTES + 1) throw new Error("Encrypted email blob is truncated.");
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const data = buf.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(ALGO, readKey("EMAIL_ENCRYPTION_KEY"), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Indexed lookup token — never query on the ciphertext or plaintext. */
export function hashEmailForLookup(email: string): string {
  return createHmac("sha256", readKey("EMAIL_HMAC_KEY")).update(normaliseEmail(email)).digest("hex");
}
