import type { Account } from "../auth.js";
import type { RouteTable } from "../router.js";
import { canManage, ownPlayer, requireManage, requireModule } from "../auth.js";
import { query, queryOne, transaction } from "../db.js";
import { HttpError, decimal, integer, ok, oneOf, readJson, text } from "../http.js";
import { buildPreview } from "../roster-import.js";
import { MAX_SHEET_ROWS, parseDelimitedText, parseSpreadsheet } from "../sheets.js";
import { deleteUpload, fetchUpload, readMultipart } from "../uploads.js";
import { avatarUrl } from "./account.js";

export const SQUADS = ["AIR", "TANK", "MISSILE"] as const;
export type Squad = (typeof SQUADS)[number];

const ROSTER_LIMIT = 200;

const POWER_COLUMN: Record<Squad, string> = {
  AIR: "air_power",
  TANK: "tank_power",
  MISSILE: "missile_power",
};

type PlayerRow = {
  id: number;
  name: string;
  rank: string;
  main_squad: Squad;
  air_power: string;
  tank_power: string;
  missile_power: string;
  thp: string;
  user_id: number | null;
  avatar_blob_key: string | null;
  avatar_updated_at: string | null;
};

const PLAYER_COLUMNS = `
  p.id, p.name, p.rank, p.main_squad, p.air_power, p.tank_power, p.missile_power, p.thp, p.user_id,
  u.avatar_blob_key, u.avatar_updated_at
`;

function shape(row: PlayerRow) {
  const power = {
    AIR: Number(row.air_power),
    TANK: Number(row.tank_power),
    MISSILE: Number(row.missile_power),
  };
  return {
    id: row.id,
    name: row.name,
    rank: row.rank,
    mainSquad: row.main_squad,
    power,
    thp: Number(row.thp),
    totalPower: power.AIR + power.TANK + power.MISSILE,
    mainPower: power[row.main_squad] ?? 0,
    linked: row.user_id !== null,
    photoUrl:
      row.user_id === null
        ? null
        : avatarUrl({
            id: row.user_id,
            avatar_blob_key: row.avatar_blob_key,
            avatar_updated_at: row.avatar_updated_at,
          }),
  };
}

/** GET /api/roster — the roster, the caller's own row and the power history. */
async function list(account: Account) {
  requireModule(account, "squads");

  const players = await query<PlayerRow>(
    `SELECT ${PLAYER_COLUMNS}
     FROM players p
     LEFT JOIN users u ON u.id = p.user_id
     WHERE p.active = TRUE
     ORDER BY p.name`,
  );
  const mine = await ownPlayer(account);

  const progress = await query<{ player_id: number; squad: string; power: string; recorded_at: string }>(
    `SELECT player_id, squad, power, recorded_at
     FROM player_progress
     WHERE recorded_at > NOW() - INTERVAL '180 days'
     ORDER BY recorded_at ASC`,
  );

  const history: Record<number, { squad: string; power: number; at: string }[]> = {};
  for (const entry of progress) {
    const bucket = (history[entry.player_id] ??= []);
    bucket.push({ squad: entry.squad, power: Number(entry.power), at: entry.recorded_at });
  }

  return ok({
    players: players.map(shape),
    myPlayerId: mine.id,
    history,
    canManage: canManage(account),
    rosterLimit: ROSTER_LIMIT,
  });
}

/** Records a power reading so individual progress can be charted. */
async function logProgress(playerId: number, power: Record<Squad, number>, thp: number) {
  await query(
    `INSERT INTO player_progress (player_id, squad, power)
     VALUES ($1, 'AIR', $2), ($1, 'TANK', $3), ($1, 'MISSILE', $4), ($1, 'THP', $5)`,
    [playerId, power.AIR, power.TANK, power.MISSILE, thp],
  );
}

function readPower(body: Record<string, unknown>) {
  return {
    AIR: decimal(body.airPower ?? 0, "Air power"),
    TANK: decimal(body.tankPower ?? 0, "Tank power"),
    MISSILE: decimal(body.missilePower ?? 0, "Missile power"),
  };
}

function readThp(body: Record<string, unknown>) {
  return decimal(body.thp ?? 0, "THP");
}

/** True when any reading moved, so the progress log stays free of no-ops. */
function readingChanged(before: PlayerRow, power: Record<Squad, number>, thp: number) {
  return (
    Number(before.air_power) !== power.AIR ||
    Number(before.tank_power) !== power.TANK ||
    Number(before.missile_power) !== power.MISSILE ||
    Number(before.thp) !== thp
  );
}

async function activeCount() {
  const total = await queryOne<{ count: number }>(
    "SELECT count(*)::int AS count FROM players WHERE active = TRUE",
  );
  return total?.count ?? 0;
}

/** POST /api/roster — R4/Master add a player. */
async function create(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const name = text(body.name, "Player name", { max: 30, required: true });
  const rank = oneOf(body.rank ?? "R3", ["R4", "R3"], "Rank");
  const mainSquad = oneOf(body.mainSquad ?? "AIR", SQUADS, "Main squad");
  const power = readPower(body);
  const thp = readThp(body);

  if ((await activeCount()) >= ROSTER_LIMIT) {
    throw new HttpError(`The roster is limited to ${ROSTER_LIMIT} players.`, 409);
  }

  const inserted = await query<{ id: number }>(
    `INSERT INTO players (name, rank, main_squad, air_power, tank_power, missile_power, thp, rank_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (name) DO UPDATE SET
       active = TRUE,
       rank = EXCLUDED.rank,
       main_squad = EXCLUDED.main_squad,
       air_power = EXCLUDED.air_power,
       tank_power = EXCLUDED.tank_power,
       missile_power = EXCLUDED.missile_power,
       thp = EXCLUDED.thp,
       rank_level = EXCLUDED.rank_level
     RETURNING id`,
    [name, rank, mainSquad, power.AIR, power.TANK, power.MISSILE, thp, rank === "R4" ? 4 : 3],
  );

  await logProgress(inserted[0].id, power, thp);
  return ok({ id: inserted[0].id });
}

/** PATCH /api/roster — R4/Master edit any player. */
async function update(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const id = integer(body.id, "Player id", { min: 1 });
  const name = text(body.name, "Player name", { max: 30, required: true });
  const rank = oneOf(body.rank ?? "R3", ["R4", "R3"], "Rank");
  const mainSquad = oneOf(body.mainSquad ?? "AIR", SQUADS, "Main squad");
  const power = readPower(body);
  const thp = readThp(body);

  const before = await queryOne<PlayerRow>("SELECT * FROM players WHERE id = $1 AND active = TRUE", [id]);
  if (!before) throw new HttpError("Player not found.", 404);

  const clash = await queryOne("SELECT 1 FROM players WHERE name = $1 AND id <> $2", [name, id]);
  if (clash) throw new HttpError("Another player already uses that name.", 409);

  await query(
    `UPDATE players SET name = $1, rank = $2, main_squad = $3,
       air_power = $4, tank_power = $5, missile_power = $6, thp = $7, rank_level = $8
     WHERE id = $9`,
    [name, rank, mainSquad, power.AIR, power.TANK, power.MISSILE, thp, rank === "R4" ? 4 : 3, id],
  );

  if (readingChanged(before, power, thp)) await logProgress(id, power, thp);
  return ok({ id });
}

/**
 * PATCH /api/roster/mine — a member updates their own squads and THP.
 *
 * Not gated on the roster module: a member's own readings belong to them even
 * when the Master has not opened the roster section for their rank.
 */
async function updateOwn(account: Account, req: Request) {
  const body = await readJson(req);
  const mainSquad = oneOf(body.mainSquad ?? "AIR", SQUADS, "Main squad");
  const power = readPower(body);
  const thp = readThp(body);
  const mine = (await ownPlayer(account)) as PlayerRow;

  await query(
    `UPDATE players SET main_squad = $1, air_power = $2, tank_power = $3, missile_power = $4, thp = $5
     WHERE id = $6`,
    [mainSquad, power.AIR, power.TANK, power.MISSILE, thp, mine.id],
  );

  if (readingChanged(mine, power, thp)) await logProgress(mine.id, power, thp);
  return ok({ id: mine.id });
}

/** PATCH /api/roster/power — quick single-squad reading for the caller. */
async function updateOwnSquad(account: Account, req: Request) {
  const body = await readJson(req);
  const squad = oneOf(body.squad, SQUADS, "Squad");
  const value = decimal(body.power, "Power");
  const mine = await ownPlayer(account);

  await transaction(async (client) => {
    await client.query(`UPDATE players SET ${POWER_COLUMN[squad]} = $1 WHERE id = $2`, [value, mine.id]);
    await client.query("INSERT INTO player_progress (player_id, squad, power) VALUES ($1, $2, $3)", [
      mine.id,
      squad,
      value,
    ]);
  });

  return ok({ id: mine.id, squad, power: value });
}

/** DELETE /api/roster?id= — R4/Master remove a player from the roster. */
async function remove(account: Account, url: URL) {
  requireManage(account);
  const id = integer(url.searchParams.get("id"), "Player id", { min: 1 });
  const removed = await query("UPDATE players SET active = FALSE WHERE id = $1 RETURNING id", [id]);
  if (!removed[0]) throw new HttpError("Player not found.", 404);
  return ok({ id });
}

/* ---------------------------------------------------------------- import --- */

/**
 * POST /api/roster/preview — read a spreadsheet, a pasted block of rows or an
 * already-uploaded file from the library, and report what an import would do.
 *
 * Nothing is written: the R4 reviews the parsed rows and then posts them back
 * to `POST /api/roster/import`.
 */
async function preview(account: Account, req: Request) {
  requireManage(account);

  const type = req.headers.get("content-type") ?? "";
  let table;

  if (type.includes("multipart/form-data")) {
    const { file } = await readMultipart(req, "file", "sheet");
    if (!file) throw new HttpError("Choose a spreadsheet to read.", 422);
    if (file.mimeType.startsWith("image/")) {
      throw new HttpError("That is an image. Upload an .xlsx workbook or a .csv export.", 415);
    }
    const bytes = await fetchUpload(file.key);
    // The workbook is only needed for this one response, so it does not stay
    // in the store behind the preview.
    await deleteUpload(file.key);
    if (!bytes) throw new HttpError("The uploaded file could not be read back.", 500);
    table = parseSpreadsheet(bytes, file.fileName);
  } else {
    const body = await readJson(req);
    const pasted = String(body.text ?? "").slice(0, 200_000).trim();
    if (!pasted) throw new HttpError("Paste at least one row of players.", 422);
    table = parseDelimitedText(pasted);
  }

  const parsed = buildPreview(table, MAX_SHEET_ROWS);

  const existing = await query<{ id: number; name: string }>(
    "SELECT id, name FROM players WHERE active = TRUE",
  );
  const byName = new Map(existing.map((row) => [row.name.toLowerCase(), row]));

  let newPlayers = 0;
  const rows = parsed.rows.map((row) => {
    const match = row.skip ? undefined : byName.get(row.name.toLowerCase());
    if (!match && !row.skip) newPlayers += 1;
    const overLimit = !match && !row.skip && existing.length + newPlayers > ROSTER_LIMIT;
    return {
      ...row,
      action: row.skip ? "SKIP" : match ? "UPDATE" : "CREATE",
      existingId: match?.id ?? null,
      skip: row.skip || overLimit,
      issues: overLimit ? [...row.issues, `The roster is limited to ${ROSTER_LIMIT} players.`] : row.issues,
    };
  });

  return ok({
    sheetName: parsed.sheetName,
    headers: parsed.headers,
    mapping: parsed.mapping,
    usedHeaderRow: parsed.usedHeaderRow,
    rows,
    summary: {
      total: rows.length,
      create: rows.filter((row) => !row.skip && row.action === "CREATE").length,
      update: rows.filter((row) => !row.skip && row.action === "UPDATE").length,
      skip: rows.filter((row) => row.skip).length,
    },
  });
}

/**
 * POST /api/roster/import — write reviewed rows to the roster.
 *
 * Every value is validated again here; the reviewed payload from the browser
 * is treated as a request, not as trusted input. Players are matched by name
 * regardless of letter case, so a re-import updates instead of duplicating.
 */
async function importRows(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const incoming = Array.isArray(body.rows) ? body.rows : [];
  if (!incoming.length) throw new HttpError("There are no rows to import.", 422);
  if (incoming.length > ROSTER_LIMIT) {
    throw new HttpError(`Import at most ${ROSTER_LIMIT} rows at a time.`, 422);
  }

  const wanted = incoming
    .filter((row) => row && typeof row === "object" && !(row as any).skip)
    .map((row) => {
      const entry = row as Record<string, unknown>;
      return {
        name: text(entry.name, "Player name", { max: 30, required: true }),
        rank: oneOf(entry.rank ?? "R3", ["R4", "R3"], "Rank"),
        mainSquad: oneOf(entry.mainSquad ?? "AIR", SQUADS, "Main squad"),
        power: readPower(entry),
        thp: readThp(entry),
      };
    });
  if (!wanted.length) throw new HttpError("Every row in that import was skipped.", 422);

  const result = await transaction(async (client) => {
    const existing = await client.query<PlayerRow>(
      "SELECT id, name, air_power, tank_power, missile_power, thp FROM players WHERE active = TRUE",
    );
    const byName = new Map(existing.rows.map((row) => [row.name.toLowerCase(), row]));
    let room = ROSTER_LIMIT - existing.rows.length;

    const created: string[] = [];
    const updated: string[] = [];
    const skipped: string[] = [];
    const readings: { id: number; power: Record<Squad, number>; thp: number }[] = [];
    const handled = new Set<string>();

    for (const row of wanted) {
      const key = row.name.toLowerCase();
      if (handled.has(key)) {
        skipped.push(row.name);
        continue;
      }
      handled.add(key);

      const match = byName.get(key);
      const rankLevel = row.rank === "R4" ? 4 : 3;

      if (match) {
        await client.query(
          `UPDATE players SET rank = $1, main_squad = $2, air_power = $3, tank_power = $4,
             missile_power = $5, thp = $6, rank_level = $7
           WHERE id = $8`,
          [row.rank, row.mainSquad, row.power.AIR, row.power.TANK, row.power.MISSILE, row.thp, rankLevel, match.id],
        );
        updated.push(row.name);
        if (readingChanged(match, row.power, row.thp)) {
          readings.push({ id: match.id, power: row.power, thp: row.thp });
        }
        continue;
      }

      if (room <= 0) {
        skipped.push(row.name);
        continue;
      }
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO players (name, rank, main_squad, air_power, tank_power, missile_power, thp, rank_level)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (name) DO UPDATE SET
           active = TRUE,
           rank = EXCLUDED.rank,
           main_squad = EXCLUDED.main_squad,
           air_power = EXCLUDED.air_power,
           tank_power = EXCLUDED.tank_power,
           missile_power = EXCLUDED.missile_power,
           thp = EXCLUDED.thp,
           rank_level = EXCLUDED.rank_level
         RETURNING id`,
        [row.name, row.rank, row.mainSquad, row.power.AIR, row.power.TANK, row.power.MISSILE, row.thp, rankLevel],
      );
      room -= 1;
      created.push(row.name);
      readings.push({ id: inserted.rows[0].id, power: row.power, thp: row.thp });
    }

    // One statement for the whole progress log rather than four per player.
    if (readings.length) {
      const values: unknown[] = [];
      const tuples = readings
        .flatMap((reading) => [
          ["AIR", reading.power.AIR],
          ["TANK", reading.power.TANK],
          ["MISSILE", reading.power.MISSILE],
          ["THP", reading.thp],
        ].map(([squad, power]) => {
          values.push(reading.id, squad, power);
          return `($${values.length - 2}, $${values.length - 1}, $${values.length})`;
        }))
        .join(", ");
      await client.query(
        `INSERT INTO player_progress (player_id, squad, power) VALUES ${tuples}`,
        values,
      );
    }

    return { created, updated, skipped };
  });

  return ok({
    created: result.created.length,
    updated: result.updated.length,
    skipped: result.skipped.length,
    names: { created: result.created.slice(0, 50), skipped: result.skipped.slice(0, 50) },
  });
}

export const rosterRoutes: RouteTable = {
  "GET roster": ({ account }) => list(account),
  "POST roster": ({ account, req }) => create(account, req),
  "PATCH roster": ({ account, req }) => update(account, req),
  "DELETE roster": ({ account, url }) => remove(account, url),
  "PATCH roster/mine": ({ account, req }) => updateOwn(account, req),
  "PATCH roster/power": ({ account, req }) => updateOwnSquad(account, req),
  "POST roster/preview": ({ account, req }) => preview(account, req),
  "POST roster/import": ({ account, req }) => importRows(account, req),
};
