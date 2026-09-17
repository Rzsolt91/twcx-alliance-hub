/**
 * Invite-gated registration, player-name or email sign-in, logout, password.
 */

import { timingSafeEqual } from "node:crypto";
import { admin } from "@netlify/identity";
import type { Account } from "../auth.js";
import { ACCOUNT_COLUMNS, assertPlayerName, currentAccount, shapeAccount } from "../auth.js";
import { hashEmailForLookup, normaliseEmail } from "../crypto-email.js";
import { query, queryOne, transaction, type TxClient } from "../db.js";
import { finishDiscordOAuth, profileRedirect } from "../discord.js";
import { backfillPlaintextEmail, emailColumns } from "../emails.js";
import { HttpError, ok, okWithCookie, readJson, text } from "../http.js";
import { activeInvite } from "../invites.js";
import { assertPasswordStrength, hashPassword, verifyPassword } from "../passwords.js";
import { clientIp, rateLimit } from "../rate-limit.js";
import type { PublicTable, RouteTable } from "../router.js";
import { endAllSessions, endSession, pruneSessions, startSession } from "../sessions.js";
import { linkDiscordAccount, normaliseLanguage, normaliseTimezone } from "./account.js";

function readEmail(value: unknown) {
  const email = normaliseEmail(text(value, "Email", { max: 140, required: true }));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError("Enter a valid email address.", 422);
  return email;
}

async function identityAdminAvailable() {
  try {
    await admin.listUsers({ perPage: 1 });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------- register --- */

/** POST /api/auth/register — email + password + a live invite code. */
async function register(req: Request) {
  if (!rateLimit(`register:${clientIp(req)}`, { limit: 10, windowMs: 10 * 60_000 })) {
    throw new HttpError("Too many registration attempts. Try again in a few minutes.", 429);
  }

  const body = await readJson(req);
  const inviteCode = text(body.inviteCode ?? body.invite, "Invite code", { max: 32 });
  const email = readEmail(body.email);
  const password = assertPasswordStrength(body.password);
  const timezone = normaliseTimezone(body.timezone ?? "UTC");
  const language = normaliseLanguage(body.language ?? "en");

  const occupied = await queryOne("SELECT 1 FROM users WHERE active = TRUE");
  if (occupied) {
    const invite = await activeInvite(inviteCode);
    if (!invite) throw new HttpError("Invalid or inactive invite link.", 403);
  } else if (inviteCode) {
    const invite = await activeInvite(inviteCode);
    if (!invite) throw new HttpError("Invalid or inactive invite link.", 403);
  }

  const lookup = hashEmailForLookup(email);
  const existing = await queryOne("SELECT 1 FROM users WHERE email_lookup_hash = $1", [lookup]);
  if (existing) throw new HttpError("That email is already registered.", 409);

  let identityId: string | null = null;
  const identityOn = await identityAdminAvailable();
  if (identityOn) {
    try {
      const created = await admin.createUser({
        email,
        password,
        data: {
          user_metadata: { invite_code: invite.code },
          app_metadata: { invite: true },
        },
      });
      identityId = created.id;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Identity signup failed.";
      if (/already|exist|duplicate/i.test(message)) throw new HttpError("That email is already registered.", 409);
      throw new HttpError("Could not create the email account.", 502);
    }
  }

  const packed = emailColumns(email);
  const passwordHash = await hashPassword(password);

  const account = await transaction(async (client) => {
    await client.query("LOCK TABLE users IN SHARE ROW EXCLUSIVE MODE");

    const raced = await client.query("SELECT 1 FROM users WHERE email_lookup_hash = $1", [lookup]);
    if (raced.rows[0]) throw new HttpError("That email is already registered.", 409);

    const linked = identityId
      ? await client.query<Account>(
          `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE identity_id = $1 AND active = TRUE`,
          [identityId],
        )
      : { rows: [] as Account[] };
    if (linked.rows[0]) {
      await client.query(
        `UPDATE users
         SET email_encrypted = $1, email_lookup_hash = $2, email = NULL,
             password_hash = COALESCE(password_hash, $3), password_set_at = COALESCE(password_set_at, NOW()),
             timezone = $4, language = $5, onboarding_complete = FALSE
         WHERE id = $6`,
        [packed.email_encrypted, packed.email_lookup_hash, passwordHash, timezone, language, linked.rows[0].id],
      );
      const updated = await client.query<Account>(`SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = $1`, [
        linked.rows[0].id,
      ]);
      return updated.rows[0];
    }

    const isFirst = (await client.query("SELECT NOT EXISTS (SELECT 1 FROM users) AS first")).rows[0].first;
    const created = await client.query<Account>(
      `INSERT INTO users (
         email, email_encrypted, email_lookup_hash, player_name, login_name, identity_id,
         password_hash, password_set_at, role, timezone, language, onboarding_complete
       ) VALUES (NULL, $1, $2, NULL, NULL, $3, $4, NOW(), $5, $6, $7, $8)
       RETURNING ${ACCOUNT_COLUMNS}`,
      [
        packed.email_encrypted,
        packed.email_lookup_hash,
        identityId,
        passwordHash,
        isFirst ? "MASTER" : "R3",
        timezone,
        language,
        false,
      ],
    );
    return created.rows[0];
  });

  const shaped = await shapeAccount(account);
  void pruneSessions();
  return okWithCookie(
    {
      id: shaped!.id,
      playerName: shaped!.player_name,
      role: shaped!.role,
      onboardingComplete: shaped!.onboarding_complete,
    },
    await startSession(shaped!.id),
    201,
  );
}

async function findByEmail(raw: string) {
  const lookup = hashEmailForLookup(raw);
  const hashed = await queryOne<{ id: number; password_hash: string | null; player_name: string | null; role: string }>(
    `SELECT id, password_hash, player_name, role
     FROM users
     WHERE active = TRUE AND email_lookup_hash = $1
     LIMIT 1`,
    [lookup],
  );
  if (hashed) return hashed;

  const leftover = await queryOne<{
    id: number;
    password_hash: string | null;
    player_name: string | null;
    role: string;
    email: string | null;
  }>(
    `SELECT id, password_hash, player_name, role, email
     FROM users
     WHERE active = TRUE AND lower(email) = $1
     LIMIT 1`,
    [normaliseEmail(raw)],
  );
  if (leftover?.email) await backfillPlaintextEmail(leftover.id, leftover.email);
  return leftover;
}

/* ----------------------------------------------------------------- login --- */

/** POST /api/auth/login — player name or email + password. */
async function login(req: Request) {
  const body = await readJson(req);
  const raw = text(body.playerName ?? body.name ?? body.email, "Sign-in", { max: 140, required: true });
  const password = String(body.password ?? "");
  const looksEmail = raw.includes("@");

  const found = looksEmail
    ? await findByEmail(raw)
    : await queryOne<{ id: number; password_hash: string | null; player_name: string | null; role: string }>(
        `SELECT id, password_hash, player_name, role
         FROM users
         WHERE active = TRUE AND (login_name = $1 OR lower(player_name) = $1)
         ORDER BY (login_name = $1) DESC
         LIMIT 1`,
        [raw.toLowerCase()],
      );

  const valid = found
    ? await verifyPassword(password, found.password_hash)
    : await hashPassword(password).then(() => false);
  if (!valid) throw new HttpError("Wrong player name or password.", 401);

  return okWithCookie(
    { id: found.id, playerName: found.player_name, role: found.role },
    await startSession(found.id),
  );
}

/** POST /api/auth/logout — drop this session and clear the cookie. */
async function logout(req: Request) {
  return okWithCookie({ signedOut: true }, await endSession(req));
}

/** GET /api/auth/bootstrap — what the sign-in screen needs before any session. */
async function bootstrap() {
  const any = await queryOne<{ any: boolean }>("SELECT EXISTS (SELECT 1 FROM users WHERE active = TRUE) AS any");
  const hasAccounts = Boolean(any?.any);
  return ok({ hasAccounts, inviteRequired: hasAccounts });
}

function sameSecret(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

async function applyLiveSchema(client: TxClient) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS invite_codes (
       id BIGSERIAL PRIMARY KEY,
       code TEXT NOT NULL UNIQUE,
       active BOOLEAN NOT NULL DEFAULT TRUE,
       created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       note TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE INDEX IF NOT EXISTS idx_invite_codes_active ON invite_codes(active, created_at DESC)`,
    `ALTER TABLE users ALTER COLUMN player_name DROP NOT NULL`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS player_stats JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_encrypted TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_lookup_hash TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS discord_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lookup ON users(email_lookup_hash) WHERE email_lookup_hash IS NOT NULL`,
    `ALTER TABLE event_signups ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`,
  ];
  for (const sql of statements) {
    await client.query(sql);
  }
}

/**
 * POST /api/auth/live-setup — one-shot production seed.
 * Disabled unless TWCX_BOOTSTRAP_TOKEN is set; remove that env after go-live.
 */
async function liveSetup(req: Request) {
  const expected = String(process.env.TWCX_BOOTSTRAP_TOKEN ?? "").trim();
  const provided = String(req.headers.get("x-twcx-bootstrap") ?? "");
  if (!expected || !sameSecret(expected, provided)) {
    throw new HttpError("Unknown endpoint.", 404);
  }

  const email = readEmail(process.env.TWCX_BOOTSTRAP_EMAIL);
  const password = assertPasswordStrength(process.env.TWCX_BOOTSTRAP_PASSWORD);
  const { name, key } = assertPlayerName(process.env.TWCX_BOOTSTRAP_PLAYER_NAME || "Andr33a");
  const packed = emailColumns(email);
  const passwordHash = await hashPassword(password);

  await transaction(async (client) => {
    await applyLiveSchema(client);
    await client.query(`
      TRUNCATE TABLE
        user_sessions,
        invite_codes,
        event_signups,
        event_teams,
        calendar_reminders,
        calendar_events,
        player_progress,
        vs_points,
        vs_weeks,
        community_likes,
        community_scores,
        community_contest_winners,
        community_posts,
        community_feedback,
        strategy_images,
        alliance_events,
        players,
        users
      RESTART IDENTITY CASCADE
    `);
    const created = await client.query<{ id: number }>(
      `INSERT INTO users (
         email, email_encrypted, email_lookup_hash, player_name, login_name, identity_id,
         password_hash, password_set_at, role, timezone, language, onboarding_complete, player_stats
       ) VALUES (NULL, $1, $2, $3, $4, NULL, $5, NOW(), 'MASTER', 'UTC', 'en', TRUE, '{}'::jsonb)
       RETURNING id`,
      [packed.email_encrypted, packed.email_lookup_hash, name, key, passwordHash],
    );
    await client.query(
      `INSERT INTO players (name, rank, main_squad, rank_level, user_id, air_power, tank_power, missile_power, thp)
       VALUES ($1, 'R4', 'AIR', 4, $2, 0, 0, 0, 0)`,
      [name, created.rows[0].id],
    );
  });

  return ok({ ready: true, playerName: name, role: "MASTER" });
}

/* -------------------------------------------------------------- password --- */

async function changePassword(account: Account, req: Request) {
  const body = await readJson(req);
  const next = assertPasswordStrength(body.password, "New password");

  if (account.has_password) {
    const stored = await queryOne<{ password_hash: string | null }>(
      "SELECT password_hash FROM users WHERE id = $1",
      [account.id],
    );
    const valid = await verifyPassword(String(body.currentPassword ?? ""), stored?.password_hash ?? null);
    if (!valid) throw new HttpError("That is not your current password.", 403);
  }

  let loginName = account.login_name;
  if (!loginName && account.player_name) {
    const key = account.player_name.toLowerCase();
    const clash = await queryOne("SELECT 1 FROM users WHERE login_name = $1 AND id <> $2", [key, account.id]);
    loginName = clash ? null : key;
  }

  await query("UPDATE users SET password_hash = $1, password_set_at = NOW(), login_name = $2 WHERE id = $3", [
    await hashPassword(next),
    loginName,
    account.id,
  ]);

  await endAllSessions(account.id, req);

  return ok({ loginName, hasPassword: true });
}

function redirectProfile(req: Request, result: "connected" | "denied" | "error" | "signin", extra: HeadersInit = {}) {
  return new Response(null, {
    status: 302,
    headers: { location: profileRedirect(req, result), ...extra },
  });
}

/** GET /api/auth/discord/callback — OAuth return from Discord. */
async function discordCallback(req: Request, url: URL) {
  const result = await finishDiscordOAuth(req, url);
  const account = await currentAccount(req);
  if (!account) return redirectProfile(req, "signin", result.headers);
  if (!result.ok) return redirectProfile(req, result.reason, result.headers);
  await linkDiscordAccount(account, result.discordId, result.discordUsername);
  return redirectProfile(req, "connected", result.headers);
}

export const publicAuthRoutes: PublicTable = {
  "POST auth/register": ({ req }) => register(req),
  "POST auth/login": ({ req }) => login(req),
  "POST auth/logout": ({ req }) => logout(req),
  "GET auth/bootstrap": () => bootstrap(),
  "POST auth/live-setup": ({ req }) => liveSetup(req),
  "GET auth/discord/callback": ({ req, url }) => discordCallback(req, url),
};

export const authRoutes: RouteTable = {
  "PATCH auth/password": ({ account, req }) => changePassword(account, req),
};
