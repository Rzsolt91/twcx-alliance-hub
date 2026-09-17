/**
 * Sign-in sessions for player-name logins.
 *
 * The browser holds an opaque random token in an HttpOnly cookie; the database
 * only ever stores its SHA-256, so the session table cannot be replayed.
 */

import { query } from "./db.js";

const COOKIE = "twcx_session";
const TOKEN_BYTES = 32;
const LIFETIME_DAYS = 30;
/** Refresh `last_seen_at` at most once a day to keep writes off the hot path. */
const TOUCH_AFTER_HOURS = 24;

function base64url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function tokenHash(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads our cookie out of the request, ignoring every other cookie. */
export function sessionCookie(req: Request) {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("=")) || null;
  }
  return null;
}

function cookieHeader(value: string, maxAgeSeconds: number) {
  const attributes = [
    `${COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  // Chrome treats http://localhost as a secure context, but skip Secure on the
  // local Node server so the session cookie still lands on 127.0.0.1.
  const local = process.env.TWCX_LOCAL === "1" || process.env.NETLIFY_DEV === "true";
  if (!local) attributes.splice(4, 0, "Secure");
  return attributes.join("; ");
}

/** Creates a session row and returns the `Set-Cookie` header value for it. */
export async function startSession(userId: number) {
  const token = base64url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
  await query(
    `INSERT INTO user_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3 || ' days')::INTERVAL)`,
    [await tokenHash(token), userId, String(LIFETIME_DAYS)],
  );
  return cookieHeader(token, LIFETIME_DAYS * 24 * 60 * 60);
}

/** The account id behind a request's cookie, or null when there is none. */
export async function sessionUserId(req: Request) {
  const token = sessionCookie(req);
  if (!token) return null;

  const hash = await tokenHash(token);
  const rows = await query<{ user_id: number; stale: boolean }>(
    `SELECT user_id, last_seen_at < NOW() - ($2 || ' hours')::INTERVAL AS stale
     FROM user_sessions WHERE token_hash = $1 AND expires_at > NOW()`,
    [hash, String(TOUCH_AFTER_HOURS)],
  );
  const found = rows[0];
  if (!found) return null;

  if (found.stale) {
    await query(
      `UPDATE user_sessions
       SET last_seen_at = NOW(), expires_at = NOW() + ($2 || ' days')::INTERVAL
       WHERE token_hash = $1`,
      [hash, String(LIFETIME_DAYS)],
    ).catch(() => {});
  }
  return found.user_id;
}

/** Drops the session behind this request, if any, and clears the cookie. */
export async function endSession(req: Request) {
  const token = sessionCookie(req);
  if (token) {
    await query("DELETE FROM user_sessions WHERE token_hash = $1", [await tokenHash(token)]).catch(() => {});
  }
  return cookieHeader("", 0);
}

/** Signs an account out everywhere — used after a password change. */
export async function endAllSessions(userId: number, keepRequest?: Request) {
  const keep = keepRequest ? sessionCookie(keepRequest) : null;
  await query("DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2", [
    userId,
    keep ? await tokenHash(keep) : "",
  ]);
}

/** Occasional housekeeping so expired rows do not accumulate. */
export async function pruneSessions() {
  await query("DELETE FROM user_sessions WHERE expires_at < NOW() - INTERVAL '7 days'").catch(() => {});
}
