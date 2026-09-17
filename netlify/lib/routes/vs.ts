import type { Account } from "../auth.js";
import { canManage, requireManage, requireModule } from "../auth.js";
import { query, queryOne, transaction } from "../db.js";
import { HttpError, decimal, integer, isoDate, ok, oneOf, readJson, text } from "../http.js";
import type { RouteTable } from "../router.js";
import { serverWeekStart, serverWallClock, shiftServerDate } from "../../../shared/time.js";

export const WEEK_TYPES = ["PUSH", "SAVE"] as const;

/** The Monday of the requested VS week, defaulting to the current one. */
function resolveWeek(url: URL) {
  const requested = url.searchParams.get("week");
  return serverWeekStart(requested ? isoDate(requested, "Week") : serverWallClock().date);
}

/** GET /api/vs?week= — the duel week, its scores and the surrounding weeks. */
async function overview(account: Account, url: URL) {
  requireModule(account, "vs");
  const weekStart = resolveWeek(url);

  const week = await queryOne(
    `SELECT v.id, v.week_start::text AS week_start, v.week_type, v.opponent, v.strategy_notes, v.strategy_image_id,
            i.title AS strategy_title, i.mime_type AS strategy_mime
     FROM vs_weeks v
     LEFT JOIN strategy_images i ON i.id = v.strategy_image_id
     WHERE v.week_start = $1`,
    [weekStart],
  );

  const players = await query(
    `SELECT p.id, p.name, p.main_squad, p.rank,
            COALESCE(pt.points, 0) AS points
     FROM players p
     LEFT JOIN vs_points pt ON pt.player_id = p.id AND pt.vs_week_id = $1
     WHERE p.active = TRUE
     ORDER BY COALESCE(pt.points, 0) DESC, p.name`,
    [week?.id ?? null],
  );

  const known = await query<{ week_start: string; week_type: string; opponent: string | null }>(
    `SELECT week_start::text AS week_start, week_type, opponent FROM vs_weeks ORDER BY week_start DESC LIMIT 26`,
  );

  const scored = players.map((row) => ({
    playerId: row.id,
    name: row.name,
    rank: row.rank,
    mainSquad: row.main_squad,
    points: Number(row.points),
  }));

  return ok({
    weekStart,
    previousWeek: shiftServerDate(weekStart, -7),
    nextWeek: shiftServerDate(weekStart, 7),
    currentWeek: serverWeekStart(serverWallClock().date),
    week: week
      ? {
          id: week.id,
          weekStart: String(week.week_start).slice(0, 10),
          weekType: week.week_type,
          opponent: week.opponent,
          strategyNotes: week.strategy_notes,
          strategyImageId: week.strategy_image_id,
          strategyTitle: week.strategy_title,
        }
      : null,
    players: scored,
    totalPoints: scored.reduce((sum, row) => sum + row.points, 0),
    weeks: known.map((row) => ({
      weekStart: String(row.week_start).slice(0, 10),
      weekType: row.week_type,
      opponent: row.opponent,
    })),
    canManage: canManage(account),
  });
}

/** POST /api/vs — R4/Master set the week type, opponent and strategy. */
async function saveWeek(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const weekStart = serverWeekStart(isoDate(body.weekStart, "Week start"));
  const weekType = oneOf(body.weekType, WEEK_TYPES, "Week type");
  const opponent = text(body.opponent, "Opponent", { max: 80 });
  const strategyNotes = text(body.strategyNotes, "Strategy notes", { max: 4000 });
  const strategyImageId = body.strategyImageId ? integer(body.strategyImageId, "Strategy image", { min: 1 }) : null;

  if (strategyImageId) {
    const image = await queryOne("SELECT 1 FROM strategy_images WHERE id = $1", [strategyImageId]);
    if (!image) throw new HttpError("Strategy image not found.", 404);
  }

  const saved = await query<{ id: number }>(
    `INSERT INTO vs_weeks (week_start, week_type, opponent, strategy_notes, strategy_image_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (week_start) DO UPDATE SET
       week_type = EXCLUDED.week_type,
       opponent = EXCLUDED.opponent,
       strategy_notes = EXCLUDED.strategy_notes,
       strategy_image_id = EXCLUDED.strategy_image_id
     RETURNING id`,
    [weekStart, weekType, opponent || null, strategyNotes, strategyImageId],
  );

  // Keep the opponent visible on the calendar, as the brief asks.
  if (opponent) {
    await query(
      `INSERT INTO calendar_events (title, event_date, server_time, description, category, created_by)
       SELECT $1, $2, '00:00', $3, 'VS', $4
       WHERE NOT EXISTS (
         SELECT 1 FROM calendar_events
         WHERE category = 'VS' AND event_date = $2 AND active = TRUE
       )`,
      [`VS week vs ${opponent}`, weekStart, `${weekType} week against ${opponent}.`, account.id],
    );
  }

  return ok({ id: saved[0].id, weekStart });
}

/** POST /api/vs/points — R4/Master record the points a player scored. */
async function savePoints(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const weekStart = serverWeekStart(isoDate(body.weekStart, "Week start"));
  const entries = Array.isArray(body.points) ? body.points : [body];

  if (entries.length === 0) throw new HttpError("No points to record.", 422);
  if (entries.length > 300) throw new HttpError("Too many rows in one request.", 413);

  const parsed = entries.map((entry: any) => ({
    playerId: integer(entry.playerId, "Player id", { min: 1 }),
    points: decimal(entry.points, "Points", { min: 0, max: 1e10 }),
  }));

  await transaction(async (client) => {
    const week = await client.query<{ id: number }>(
      `INSERT INTO vs_weeks (week_start, week_type) VALUES ($1, 'PUSH')
       ON CONFLICT (week_start) DO UPDATE SET week_start = EXCLUDED.week_start
       RETURNING id`,
      [weekStart],
    );
    const weekId = week.rows[0].id;

    for (const entry of parsed) {
      await client.query(
        `INSERT INTO vs_points (vs_week_id, player_id, points) VALUES ($1, $2, $3)
         ON CONFLICT (vs_week_id, player_id) DO UPDATE SET points = EXCLUDED.points`,
        [weekId, entry.playerId, entry.points],
      );
    }
  });

  return ok({ weekStart, saved: parsed.length });
}

export const vsRoutes: RouteTable = {
  "GET vs": ({ account, url }) => overview(account, url),
  "POST vs": ({ account, req }) => saveWeek(account, req),
  "POST vs/points": ({ account, req }) => savePoints(account, req),
};
