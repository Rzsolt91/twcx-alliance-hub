/**
 * Password hashing for player-name logins.
 *
 * PBKDF2-SHA256 through WebCrypto — available in the Functions runtime without
 * a native dependency. Stored as `pbkdf2$sha256$<iterations>$<salt>$<hash>`
 * with both blobs base64, so the work factor can be raised later without
 * invalidating existing hashes.
 */

import { HttpError } from "./http.js";

const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;

function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number) {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
    material,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

/** Rejects a password that is too short to be worth hashing. */
export function assertPasswordStrength(value: unknown, field = "Password") {
  const password = String(value ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new HttpError(`${field} must be at least ${MIN_PASSWORD_LENGTH} characters.`, 422);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new HttpError(`${field} must be under ${MAX_PASSWORD_LENGTH} characters.`, 422);
  }
  return password;
}

export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$sha256$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Length-independent comparison, so a mismatch leaks nothing by timing. */
function sameBytes(left: Uint8Array, right: Uint8Array) {
  let diff = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string | null) {
  if (!stored) return false;
  const [scheme, algorithm, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || algorithm !== "sha256") return false;

  const rounds = Number(iterations);
  if (!Number.isInteger(rounds) || rounds < 1000 || rounds > 2_000_000) return false;

  try {
    const candidate = await derive(password, fromBase64(salt), rounds);
    return sameBytes(candidate, fromBase64(hash));
  } catch {
    return false;
  }
}
