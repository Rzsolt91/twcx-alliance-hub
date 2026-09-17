import { randomBytes } from "node:crypto";
import { queryOne } from "./db.js";

const ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz";

export function randomInviteCode(length = 8) {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export async function activeInvite(code: string) {
  const normalised = code.trim();
  if (!normalised) return null;
  return queryOne<{ id: number; code: string }>(
    "SELECT id, code FROM invite_codes WHERE code = $1 AND active = TRUE",
    [normalised],
  );
}
