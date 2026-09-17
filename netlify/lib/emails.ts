import { decryptEmail, encryptEmail, hashEmailForLookup, normaliseEmail } from "./crypto-email.js";
import { query } from "./db.js";

export type EmailColumns = {
  email: string | null;
  email_encrypted?: string | null;
};

/** Pack an address for INSERT/UPDATE. Plaintext column is left null on purpose. */
export function emailColumns(email: string | null | undefined) {
  const normalised = email ? normaliseEmail(email) : "";
  if (!normalised) {
    return { email: null as string | null, email_encrypted: null as string | null, email_lookup_hash: null as string | null };
  }
  return {
    email: null as string | null,
    email_encrypted: encryptEmail(normalised),
    email_lookup_hash: hashEmailForLookup(normalised),
  };
}

/** Decrypt for display to the owner or an admin. Never log the result. */
export function revealEmail(row: EmailColumns): string | null {
  if (row.email_encrypted) {
    try {
      return decryptEmail(row.email_encrypted);
    } catch {
      return null;
    }
  }
  return row.email ? normaliseEmail(row.email) : null;
}

/** One-shot move of leftover plaintext into the encrypted columns. */
export async function backfillPlaintextEmail(userId: number, plaintext: string | null | undefined) {
  if (!plaintext) return;
  const packed = emailColumns(plaintext);
  await query("UPDATE users SET email_encrypted = $1, email_lookup_hash = $2, email = NULL WHERE id = $3 AND email_encrypted IS NULL", [
    packed.email_encrypted,
    packed.email_lookup_hash,
    userId,
  ]).catch(() => {});
}
