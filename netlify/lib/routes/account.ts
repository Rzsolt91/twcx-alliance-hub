import type { Account } from "../auth.js";
import { assertPlayerName, canManage, ownPlayer, visibleModules } from "../auth.js";
import { query, queryOne, transaction } from "../db.js";
import { discordAuthorizeRedirect, discordOAuthConfigured } from "../discord.js";
import { generatorPublicUrl } from "../blo.js";
import { HttpError, integer, ok, oneOf, powerAmount, readJson, text } from "../http.js";
import type { RouteTable } from "../router.js";
import { deleteUpload, fetchUpload, readMultipart } from "../uploads.js";
import {
  ANCHOR_ZONE,
  SERVER_HOURS_BEHIND_ANCHOR,
  asClock,
  instantFromServerClock,
  occurrencesInRange,
  serverWallClock,
  serverWeekStart,
  shiftServerDate,
} from "../../../shared/time.js";

export const LANGUAGES = ["en", "ko"] as const;
const SQUADS = ["AIR", "TANK", "MISSILE"] as const;

/** Rejects anything the platform cannot resolve as an IANA time zone. */
export function normaliseTimezone(value: unknown) {
  const candidate = String(value ?? "").trim().slice(0, 64);
  if (!candidate) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    throw new HttpError("That time zone is not recognised.", 422);
  }
}

export function normaliseLanguage(value: unknown) {
  const candidate = String(value ?? "").trim().toLowerCase();
  const match = LANGUAGES.find((language) => language === candidate);
  if (!match) throw new HttpError(`Language must be one of: ${LANGUAGES.join(", ")}.`, 422);
  return match;
}

function clockPayload() {
  const now = new Date();
  const server = serverWallClock(now);
  return {
    now: now.toISOString(),
    serverDate: server.date,
    serverTime: server.time,
    serverWeekday: server.weekday,
    anchorZone: ANCHOR_ZONE,
    hoursBehindAnchor: SERVER_HOURS_BEHIND_ANCHOR,
  };
}

function sessionAccount(account: Account) {
  return {
    id: account.id,
    email: account.email,
    playerName: account.player_name,
    loginName: account.login_name,
    hasPassword: account.has_password,
    role: account.role,
    timezone: account.timezone,
    language: LANGUAGES.includes(account.language as (typeof LANGUAGES)[number]) ? account.language : "en",
    notifyEmail: account.notify_email ?? account.email,
    avatarUrl: avatarUrl(account),
    onboardingComplete: account.onboarding_complete,
    discordId: account.discord_id,
    discordUsername: String(account.player_stats.discordUsername ?? ""),
    playerStats: account.player_stats,
  };
}

/** GET /api/session — who the caller is and what they may open. */
async function session(account: Account) {
  return ok({
    authenticated: true,
    account: sessionAccount(account),
    modules: visibleModules(account),
    canManage: canManage(account),
    isMaster: account.role === "MASTER",
    clock: clockPayload(),
    languages: LANGUAGES,
    discordConnectAvailable: discordOAuthConfigured(),
    generatorUrl: canManage(account) ? generatorPublicUrl() : null,
  });
}

function readPowerStats(body: Record<string, unknown>) {
  const nested =
    body.powerStats && typeof body.powerStats === "object" && !Array.isArray(body.powerStats)
      ? (body.powerStats as Record<string, unknown>)
      : body;
  const mainSquad = oneOf(nested.mainSquad ?? nested.main_squad ?? "AIR", SQUADS, "Main squad");
  return {
    airPower: powerAmount(nested.airPower ?? nested.AIR ?? 0, "Air power"),
    tankPower: powerAmount(nested.tankPower ?? nested.TANK ?? 0, "Tank power"),
    missilePower: powerAmount(nested.missilePower ?? nested.MISSILE ?? 0, "Missile power"),
    thp: powerAmount(nested.thp ?? 0, "Total hero power"),
    mainSquad,
  };
}

function readDiscordId(value: unknown) {
  const raw = text(value, "Discord ID", { max: 32 });
  if (!raw) return null;
  if (!/^\d{5,32}$/.test(raw)) {
    throw new HttpError("Discord ID must be the numeric user id (enable Developer Mode, then Copy User ID).", 422);
  }
  return raw;
}

/** POST /api/account/onboarding — player name + power stats, then full access. */
async function completeOnboarding(account: Account, req: Request) {
  if (account.onboarding_complete) {
    return ok({ onboardingComplete: true, account: sessionAccount(account) });
  }

  const body = await readJson(req);
  const { name, key } = assertPlayerName(body.playerName ?? body.player_name ?? account.player_name);
  const stats = readPowerStats(body);

  const taken = await queryOne(
    "SELECT 1 FROM users WHERE lower(player_name) = $1 AND id <> $2",
    [key, account.id],
  );
  if (taken) throw new HttpError("That player name is already taken.", 409);

  const loginClash = await queryOne("SELECT 1 FROM users WHERE login_name = $1 AND id <> $2", [key, account.id]);
  const loginName = account.login_name ?? (loginClash ? null : key);
  const playerName = account.player_name || name;

  await transaction(async (client) => {
    await client.query(
      `UPDATE users
       SET player_name = $1, login_name = COALESCE(login_name, $2),
           player_stats = $3::jsonb, onboarding_complete = TRUE
       WHERE id = $4`,
      [playerName, loginName, JSON.stringify(stats), account.id],
    );
  });

  const updated: Account = {
    ...account,
    player_name: playerName,
    login_name: loginName,
    player_stats: stats,
    onboarding_complete: true,
  };
  const mine = await ownPlayer(updated);
  await query(
    `UPDATE players SET main_squad = $1, air_power = $2, tank_power = $3, missile_power = $4, thp = $5
     WHERE id = $6`,
    [stats.mainSquad, stats.airPower, stats.tankPower, stats.missilePower, stats.thp, mine.id],
  );

  return ok({ onboardingComplete: true, playerName, loginName, playerStats: stats });
}

/** PATCH /api/profile — the member's own time zone, language, contact and Discord. */
async function updateProfile(account: Account, req: Request) {
  const body = await readJson(req);
  const timezone = normaliseTimezone(body.timezone ?? account.timezone);
  const language = normaliseLanguage(body.language ?? account.language);
  const notifyEmail = text(body.notifyEmail, "Notification email", { max: 140 }) || account.email || null;
  const discordTouched = body.discordId !== undefined || body.discord_id !== undefined;

  await query("UPDATE users SET timezone = $1, language = $2, notify_email = $3 WHERE id = $4", [
    timezone,
    language,
    notifyEmail,
    account.id,
  ]);

  let discord = {
    discordId: account.discord_id,
    discordUsername: String(account.player_stats.discordUsername ?? ""),
  };
  if (discordTouched) {
    const discordId = readDiscordId(body.discordId ?? body.discord_id);
    const keepName = discordId && discordId === account.discord_id ? discord.discordUsername : "";
    discord = await linkDiscordAccount(account, discordId, keepName);
  }

  return ok({ timezone, language, notifyEmail, ...discord });
}

export async function linkDiscordAccount(account: Account, discordId: string | null, discordUsername = "") {
  const stats = { ...account.player_stats };
  if (discordId) stats.discordUsername = discordUsername;
  else delete stats.discordUsername;
  await query("UPDATE users SET discord_id = $1, player_stats = $2::jsonb WHERE id = $3", [
    discordId,
    JSON.stringify(stats),
    account.id,
  ]);
  return { discordId, discordUsername: discordId ? discordUsername : "" };
}

/** GET /api/account/discord/connect — send the member to Discord OAuth. */
async function connectDiscord(_account: Account, req: Request) {
  return discordAuthorizeRedirect(req);
}

/** POST /api/account/discord/disconnect — drop the linked Discord account. */
async function disconnectDiscord(account: Account) {
  return ok(await linkDiscordAccount(account, null, ""));
}

/** GET /api/dashboard — the command-center summary. */
async function dashboard(account: Account) {
  const clock = clockPayload();
  const today = clock.serverDate;
  const horizon = shiftServerDate(today, 21);
  const weekStart = serverWeekStart(today);

  const mine = await ownPlayer(account);
  const myPower = {
    AIR: Number(mine.air_power),
    TANK: Number(mine.tank_power),
    MISSILE: Number(mine.missile_power),
  };

  const totals = await queryOne<{ players: number; total_power: string | null; top_power: string | null }>(
    `SELECT count(*)::int AS players,
            COALESCE(SUM(air_power + tank_power + missile_power), 0) AS total_power,
            COALESCE(MAX(air_power + tank_power + missile_power), 0) AS top_power
     FROM players WHERE active = TRUE`,
  );

  const squadSplit = await query<{ main_squad: string; count: number }>(
    `SELECT main_squad, count(*)::int AS count FROM players WHERE active = TRUE GROUP BY main_squad`,
  );

  const storms = await query<{
    id: number;
    title: string;
    weekday: number;
    server_time: string;
  }>("SELECT id, title, weekday::int AS weekday, server_time::text AS server_time FROM weekly_events WHERE active = TRUE");

  const manual = await query(
    `SELECT id, title, event_date::text AS event_date, server_time::text AS server_time, category
     FROM calendar_events
     WHERE active = TRUE AND event_date BETWEEN $1 AND $2
     ORDER BY event_date, server_time`,
    [today, horizon],
  );

  type Upcoming = {
    kind: "WEEKLY" | "CALENDAR";
    id: number;
    title: string;
    date: string;
    serverTime: string;
    instant: string;
    category: string;
  };

  const upcoming: Upcoming[] = [];
  for (const storm of storms) {
    const serverTime = asClock(storm.server_time);
    for (const date of occurrencesInRange(Number(storm.weekday), today, horizon)) {
      upcoming.push({
        kind: "WEEKLY",
        id: storm.id,
        title: storm.title,
        date,
        serverTime,
        instant: instantFromServerClock(date, serverTime).toISOString(),
        category: "STORM",
      });
    }
  }
  for (const row of manual) {
    const date = String(row.event_date).slice(0, 10);
    const serverTime = asClock(row.server_time);
    upcoming.push({
      kind: "CALENDAR",
      id: row.id,
      title: row.title,
      date,
      serverTime,
      instant: instantFromServerClock(date, serverTime).toISOString(),
      category: row.category,
    });
  }

  const nowIso = clock.now;
  const nextUp = upcoming
    .filter((entry) => entry.instant >= nowIso)
    .sort((left, right) => left.instant.localeCompare(right.instant))
    .slice(0, 6);

  const vsWeek = await queryOne(
    `SELECT v.week_type, v.opponent,
            COALESCE(SUM(pt.points), 0) AS alliance_points,
            COALESCE(SUM(CASE WHEN pt.player_id = $2 THEN pt.points ELSE 0 END), 0) AS my_points
     FROM vs_weeks v
     LEFT JOIN vs_points pt ON pt.vs_week_id = v.id
     WHERE v.week_start = $1
     GROUP BY v.week_type, v.opponent`,
    [weekStart, mine.id],
  );

  const topMeme = await queryOne(
    `SELECT p.id, p.title, p.likes, u.player_name AS author
     FROM community_posts p
     JOIN users u ON u.id = p.user_id
     WHERE p.active = TRUE AND p.week_start = $1
     ORDER BY p.likes DESC, p.created_at DESC
     LIMIT 1`,
    [weekStart],
  );

  const openReports = canManage(account)
    ? await queryOne<{ count: number }>(
        "SELECT count(*)::int AS count FROM community_feedback WHERE status = 'OPEN'",
      )
    : null;

  const myApplications = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM event_signups
     WHERE player_id = $1 AND occurrence_date >= $2`,
    [mine.id, today],
  );

  return ok({
    clock,
    me: {
      playerName: account.player_name,
      role: account.role,
      timezone: account.timezone,
      mainSquad: mine.main_squad,
      power: myPower,
      thp: Number(mine.thp ?? 0),
      totalPower: myPower.AIR + myPower.TANK + myPower.MISSILE,
      applications: myApplications?.count ?? 0,
    },
    alliance: {
      players: totals?.players ?? 0,
      totalPower: Number(totals?.total_power ?? 0),
      topPower: Number(totals?.top_power ?? 0),
      squadSplit: Object.fromEntries(squadSplit.map((row) => [row.main_squad, Number(row.count)])),
    },
    upcoming: nextUp,
    vs: vsWeek
      ? {
          weekStart,
          weekType: vsWeek.week_type,
          opponent: vsWeek.opponent,
          alliancePoints: Number(vsWeek.alliance_points),
          myPoints: Number(vsWeek.my_points),
        }
      : { weekStart, weekType: null, opponent: null, alliancePoints: 0, myPoints: 0 },
    topMeme: topMeme
      ? { id: topMeme.id, title: topMeme.title, likes: Number(topMeme.likes), author: topMeme.author }
      : null,
    openReports: openReports?.count ?? null,
  });
}

/* ---------------------------------------------------------- profile photo --- */

/** Cache-busting URL for an account photo, or null when none is set. */
export function avatarUrl(account: {
  id: number;
  avatar_blob_key: string | null;
  avatar_updated_at: string | null;
}) {
  if (!account.avatar_blob_key) return null;
  const version = account.avatar_updated_at ? Date.parse(account.avatar_updated_at) || 0 : 0;
  return `/api/avatar?userId=${account.id}&v=${version}`;
}

/** POST /api/profile/photo — replace the member's own profile photo. */
async function uploadPhoto(account: Account, req: Request) {
  const { file } = await readMultipart(req, "photo", "image");
  if (!file) throw new HttpError("Choose an image to upload.", 422);

  const previous = await queryOne<{ avatar_blob_key: string | null }>(
    "SELECT avatar_blob_key FROM users WHERE id = $1",
    [account.id],
  );

  await query(
    "UPDATE users SET avatar_blob_key = $1, avatar_mime = $2, avatar_updated_at = NOW() WHERE id = $3",
    [file.key, file.mimeType, account.id],
  );
  if (previous?.avatar_blob_key) await deleteUpload(previous.avatar_blob_key);

  const updated = await queryOne<{ id: number; avatar_blob_key: string; avatar_updated_at: string }>(
    "SELECT id, avatar_blob_key, avatar_updated_at FROM users WHERE id = $1",
    [account.id],
  );
  return ok({ avatarUrl: updated ? avatarUrl(updated) : null });
}

/** DELETE /api/profile/photo — drop the photo and its stored bytes. */
async function removePhoto(account: Account) {
  const current = await queryOne<{ avatar_blob_key: string | null }>(
    "SELECT avatar_blob_key FROM users WHERE id = $1",
    [account.id],
  );
  await query(
    "UPDATE users SET avatar_blob_key = NULL, avatar_mime = NULL, avatar_updated_at = NOW() WHERE id = $1",
    [account.id],
  );
  if (current?.avatar_blob_key) await deleteUpload(current.avatar_blob_key);
  return ok({ avatarUrl: null });
}

/** GET /api/avatar?userId= — stream a member photo to a signed-in member. */
async function readPhoto(url: URL) {
  const userId = integer(url.searchParams.get("userId"), "Account id", { min: 1 });
  const row = await queryOne<{ avatar_blob_key: string | null; avatar_mime: string | null }>(
    "SELECT avatar_blob_key, avatar_mime FROM users WHERE id = $1 AND active = TRUE",
    [userId],
  );
  if (!row?.avatar_blob_key) throw new HttpError("That member has no photo.", 404);

  const bytes = await fetchUpload(row.avatar_blob_key);
  if (!bytes) throw new HttpError("That photo is no longer available.", 404);

  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": row.avatar_mime ?? "application/octet-stream",
      // The URL carries a version, so a hit can be held for a long while.
      "cache-control": "private, max-age=86400",
    },
  });
}

export const accountRoutes: RouteTable = {
  "GET session": ({ account }) => session(account),
  "POST account/onboarding": ({ account, req }) => completeOnboarding(account, req),
  "GET account/discord/connect": ({ account, req }) => connectDiscord(account, req),
  "POST account/discord/disconnect": ({ account }) => disconnectDiscord(account),
  "PATCH profile": ({ account, req }) => updateProfile(account, req),
  "GET dashboard": ({ account }) => dashboard(account),
  "POST profile/photo": ({ account, req }) => uploadPhoto(account, req),
  "DELETE profile/photo": ({ account }) => removePhoto(account),
  "GET avatar": ({ url }) => readPhoto(url),
};
