import { getUser } from "@netlify/identity";
import { query, transaction } from "./db.js";
import { backfillPlaintextEmail, revealEmail } from "./emails.js";
import { HttpError } from "./http.js";
import { sessionUserId } from "./sessions.js";

export const ROLES = ["MASTER", "R4", "R3"] as const;
export type Role = (typeof ROLES)[number];

/** Sections an R3 can be granted or denied by the Master. */
export const MODULES = ["home", "squads", "events", "calendar", "vs", "community"] as const;
export type Module = (typeof MODULES)[number];

export type Account = {
  id: number;
  /** Null for accounts created with a player name instead of an email. */
  email: string | null;
  player_name: string | null;
  /** Case-folded player name used to sign in. Null until one is reserved. */
  login_name: string | null;
  role: Role;
  allowed_modules: string[];
  timezone: string;
  language: string;
  notify_email: string | null;
  avatar_blob_key: string | null;
  avatar_mime: string | null;
  avatar_updated_at: string | null;
  onboarding_complete: boolean;
  discord_id: string | null;
  player_stats: Record<string, unknown>;
  /** True when the account can sign in with a player name and password. */
  has_password: boolean;
};

export const ACCOUNT_COLUMNS = `
  id, email, email_encrypted, player_name, login_name, role, allowed_modules, timezone, language, notify_email,
  avatar_blob_key, avatar_mime, avatar_updated_at, onboarding_complete, discord_id, player_stats,
  (password_hash IS NOT NULL) AS has_password
`;

type AccountRow = Account & { email_encrypted?: string | null };

export async function shapeAccount(row: AccountRow | null): Promise<Account | null> {
  if (!row) return null;
  if (row.email && !row.email_encrypted) await backfillPlaintextEmail(row.id, row.email);
  const stats =
    row.player_stats && typeof row.player_stats === "object" && !Array.isArray(row.player_stats)
      ? (row.player_stats as Record<string, unknown>)
      : {};
  return {
    ...row,
    email: revealEmail(row),
    player_name: row.player_name,
    onboarding_complete: row.onboarding_complete === true,
    discord_id: row.discord_id ?? null,
    player_stats: stats,
    has_password: row.has_password === true,
  };
}

const MIN_NAME = 3;
const MAX_NAME = 30;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._'’\-\[\]()]*$/u;

export function assertPlayerName(value: unknown) {
  const name = String(value ?? "").trim().slice(0, MAX_NAME);
  if (name.length < MIN_NAME) {
    throw new HttpError(`Player name must be at least ${MIN_NAME} characters.`, 422);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new HttpError("Player name can use letters, numbers, spaces and . _ - ' ( ) only.", 422);
  }
  return { name, key: name.toLowerCase() };
}

/**
 * The account behind a request.
 *
 * A player-name sign-in carries an opaque session cookie; an email sign-in
 * carries a Netlify Identity JWT. The cookie is checked first because it is
 * the cheaper lookup and the path most members use.
 */
export async function currentAccount(req?: Request): Promise<Account | null> {
  if (req) {
    const userId = await sessionUserId(req);
    if (userId) {
      const rows = await query<AccountRow>(
        `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE id = $1 AND active = TRUE`,
        [userId],
      );
      if (rows[0]) return shapeAccount(rows[0]);
    }
  }
  return identityAccount();
}

/**
 * The account for the current Identity session.
 * New portal rows are created only through invite registration (and the
 * Identity signup trigger), never by walking in with a JWT.
 */
async function identityAccount(): Promise<Account | null> {
  let identity: Awaited<ReturnType<typeof getUser>> = null;
  try {
    identity = await getUser();
  } catch {
    return null;
  }
  if (!identity) return null;

  const existing = await query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM users WHERE identity_id = $1 AND active = TRUE`,
    [identity.id],
  );
  if (existing[0]) return shapeAccount(existing[0]);
  return null;
}

export function isMaster(account: Account) {
  return account.role === "MASTER";
}

/** Master and R4 share the day-to-day management rights. */
export function canManage(account: Account) {
  return account.role === "MASTER" || account.role === "R4";
}

export function requireManage(account: Account) {
  if (!canManage(account)) throw new HttpError("Master or R4 access is required.", 403);
}

export function requireMaster(account: Account) {
  if (!isMaster(account)) throw new HttpError("Master access is required.", 403);
}

export function requireOnboarded(account: Account) {
  if (!account.onboarding_complete) throw new HttpError("Finish onboarding to continue.", 403);
}

/** Modules the account may open. Master and R4 always see everything. */
export function visibleModules(account: Account): Module[] {
  if (canManage(account)) return [...MODULES];
  const granted = Array.isArray(account.allowed_modules) ? account.allowed_modules : [];
  const allowed = MODULES.filter((module) => granted.includes(module));
  return allowed.includes("home") ? allowed : (["home", ...allowed] as Module[]);
}

/** Blocks an R3 from reading a section the Master has not granted. */
export function requireModule(account: Account, module: Module) {
  if (!visibleModules(account).includes(module)) {
    throw new HttpError("This section is not enabled for your account.", 403);
  }
}

/**
 * The roster row belonging to an account, created on demand so every member
 * can record their own squad power.
 */
export async function ownPlayer(account: Account) {
  const linked = await query(`SELECT * FROM players WHERE user_id = $1`, [account.id]);
  if (linked[0]) return linked[0];
  if (!account.player_name) throw new HttpError("Finish onboarding to continue.", 403);

  const claimed = await query(
    `UPDATE players SET user_id = $1, active = TRUE
     WHERE user_id IS NULL AND lower(name) = lower($2)
     RETURNING *`,
    [account.id, account.player_name],
  );
  if (claimed[0]) return claimed[0];

  const name = await uniqueRosterName(account.player_name);
  const created = await query(
    `INSERT INTO players (name, rank, main_squad, rank_level, user_id)
     VALUES ($1, $2, 'AIR', $3, $4)
     RETURNING *`,
    [name, account.role === "R4" ? "R4" : "R3", account.role === "R4" ? 4 : 3, account.id],
  );
  return created[0];
}

async function uniqueRosterName(preferred: string) {
  const base = preferred.slice(0, 30) || "Player";
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base.slice(0, 26)} ${attempt + 1}`;
    const clash = await query("SELECT 1 FROM players WHERE name = $1", [candidate]);
    if (!clash[0]) return candidate;
  }
  return `${base.slice(0, 22)}-${Date.now().toString(36).slice(-6)}`;
}
