import type { Account } from "../auth.js";
import { canManage, ownPlayer, requireManage, requireModule } from "../auth.js";
import { query, queryOne, transaction } from "../db.js";
import { HttpError, clockTime, integer, isoDate, ok, oneOf, readJson, text } from "../http.js";
import type { RouteTable } from "../router.js";
import { asClock, nextOccurrenceDate, serverWallClock, shiftServerDate, signupIsOpen, stormKindFromEvent } from "../../../shared/time.js";
import { syncStormSignupsToGenerator } from "../blo.js";
import { SQUADS } from "./roster.js";

const UPCOMING_SLOTS = 4;
const PAST_SLOTS = 6;
const SIGNUP_STATUSES = ["APPLIED", "APPROVED", "REJECTED"] as const;
const STORM_TEAMS = ["A", "B", "BOTH"] as const;

function applicantPower(row: {
  squad: string | null;
  main_squad: string;
  air_power: unknown;
  tank_power: unknown;
  missile_power: unknown;
}) {
  const squad = row.squad ?? row.main_squad;
  if (squad === "AIR") return Number(row.air_power) || 0;
  if (squad === "TANK") return Number(row.tank_power) || 0;
  if (squad === "MISSILE") return Number(row.missile_power) || 0;
  return (Number(row.air_power) || 0) + (Number(row.tank_power) || 0) + (Number(row.missile_power) || 0);
}

type WeeklyEventRow = {
  id: number;
  code: string;
  title: string;
  weekday: number;
  server_time: string;
  description: string;
  active: boolean;
};

/**
 * The storm slots this event will next run, plus the recent ones, expressed as
 * server calendar dates.
 */
function occurrences(event: WeeklyEventRow, now: Date) {
  const serverTime = asClock(event.server_time);
  const first = nextOccurrenceDate(event.weekday, serverTime, now);

  const upcoming: string[] = [];
  for (let index = 0; index < UPCOMING_SLOTS; index += 1) {
    upcoming.push(shiftServerDate(first, index * 7));
  }

  const past: string[] = [];
  for (let index = 1; index <= PAST_SLOTS; index += 1) {
    past.push(shiftServerDate(first, -index * 7));
  }

  return { upcoming, past };
}

function shapeEvent(row: WeeklyEventRow, now: Date) {
  const slots = occurrences(row, now);
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    weekday: row.weekday,
    serverTime: asClock(row.server_time),
    description: row.description,
    active: row.active,
    upcoming: slots.upcoming,
    past: slots.past,
  };
}

/** GET /api/events — storm slots, signups, teams and published plans. */
async function overview(account: Account) {
  requireModule(account, "events");
  const now = new Date();
  const today = serverWallClock(now).date;
  const manage = canManage(account);

  const rows = await query<WeeklyEventRow>(
    `SELECT id, code, title, weekday::int AS weekday, server_time::text AS server_time, description, active
     FROM weekly_events ORDER BY weekday, server_time`,
  );
  const events = rows.map((row) => shapeEvent(row, now));
  const mine = await ownPlayer(account);

  // Members see signups from today forward; managers also get the archive of
  // who applied to the slots that already ran.
  const earliest = manage
    ? events.reduce((oldest, event) => {
        const candidate = event.past[event.past.length - 1] ?? today;
        return candidate < oldest ? candidate : oldest;
      }, today)
    : today;

  const signups = await query(
    `SELECT s.id, s.weekly_event_id, s.player_id, s.occurrence_date::text AS occurrence_date, s.status, s.squad, s.storm_team, s.note,
            p.name AS player_name, p.main_squad, p.air_power, p.tank_power, p.missile_power
     FROM event_signups s
     JOIN players p ON p.id = s.player_id
     WHERE s.occurrence_date >= $1
     ORDER BY s.occurrence_date, p.name`,
    [earliest],
  );

  const teams = await query(
    `SELECT id, weekly_event_id, occurrence_date::text AS occurrence_date, team_name, member_names, notes
     FROM event_teams
     WHERE occurrence_date >= $1
     ORDER BY occurrence_date, team_name`,
    [earliest],
  );

  const plans = await query(
    `SELECT i.id, i.event_id, i.title, i.description, i.mime_type, i.created_at, u.player_name AS author
     FROM strategy_images i
     LEFT JOIN users u ON u.id = i.uploaded_by
     WHERE i.category = 'EVENT'
     ORDER BY i.created_at DESC
     LIMIT 60`,
  );

  return ok({
    events,
    myPlayerId: mine.id,
    myMainSquad: mine.main_squad ?? "AIR",
    canManage: manage,
    signups: signups.map((row) => ({
      id: row.id,
      weeklyEventId: row.weekly_event_id,
      playerId: row.player_id,
      playerName: row.player_name,
      occurrenceDate: row.occurrence_date,
      status: row.status,
      squad: row.squad ?? row.main_squad,
      stormTeam: row.storm_team === "A" || row.storm_team === "B" ? row.storm_team : "BOTH",
      note: row.note,
      power: applicantPower(row),
    })),
    teams: teams.map((row) => ({
      id: row.id,
      weeklyEventId: row.weekly_event_id,
      occurrenceDate: row.occurrence_date,
      teamName: row.team_name,
      members: Array.isArray(row.member_names) ? row.member_names : [],
      notes: row.notes,
    })),
    plans: plans.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      title: row.title,
      description: row.description,
      mimeType: row.mime_type,
      author: row.author,
      createdAt: row.created_at,
    })),
  });
}

/** PATCH /api/events — R4/Master retime or relabel a storm slot. */
async function updateEvent(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const id = integer(body.id, "Event id", { min: 1 });
  const title = text(body.title, "Title", { max: 80, required: true });
  const weekday = integer(body.weekday, "Weekday", { min: 0, max: 6 });
  const serverTime = clockTime(body.serverTime, "Server time");
  const description = text(body.description, "Description", { max: 600 });
  const active = body.active !== false;

  const updated = await query(
    `UPDATE weekly_events SET title = $1, weekday = $2, server_time = $3, description = $4, active = $5
     WHERE id = $6 RETURNING id`,
    [title, weekday, serverTime, description, active, id],
  );
  if (!updated[0]) throw new HttpError("Storm slot not found.", 404);
  return ok({ id });
}

/** POST /api/events — R4/Master add another recurring storm slot. */
async function createEvent(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const title = text(body.title, "Title", { max: 80, required: true });
  const weekday = integer(body.weekday, "Weekday", { min: 0, max: 6 });
  const serverTime = clockTime(body.serverTime, "Server time");
  const description = text(body.description, "Description", { max: 600 });
  const code = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}-${weekday}${serverTime.replace(":", "")}`;

  const created = await query<{ id: number }>(
    `INSERT INTO weekly_events (code, title, weekday, server_time, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, active = TRUE
     RETURNING id`,
    [code, title, weekday, serverTime, description],
  );
  return ok({ id: created[0].id });
}

/**
 * DELETE /api/events?id= — R4/Master delete a storm slot for good.
 *
 * Signups and teams are owned by the slot and cascade away with it. Reminders
 * carry no foreign key, so they are cleared here; published plans outlive the
 * slot and are only detached, so nothing an R4 uploaded is lost by mistake.
 */
async function removeEvent(account: Account, url: URL) {
  requireManage(account);
  const id = integer(url.searchParams.get("id"), "Event id", { min: 1 });

  return transaction(async (client) => {
    const existing = await client.query<{ title: string }>(
      "SELECT title FROM weekly_events WHERE id = $1",
      [id],
    );
    if (!existing.rows[0]) throw new HttpError("Storm slot not found.", 404);

    await client.query("UPDATE strategy_images SET event_id = NULL WHERE event_id = $1 AND category = 'EVENT'", [id]);
    await client.query("DELETE FROM calendar_reminders WHERE event_kind = 'WEEKLY' AND event_id = $1", [id]);
    await client.query("DELETE FROM weekly_events WHERE id = $1", [id]);

    return ok({ id, title: existing.rows[0].title });
  });
}

/** POST /api/events/signup — apply for a storm slot. */
async function signUp(account: Account, req: Request) {
  requireModule(account, "events");
  const body = await readJson(req);
  const weeklyEventId = integer(body.weeklyEventId, "Event id", { min: 1 });
  const occurrenceDate = isoDate(body.occurrenceDate, "Occurrence date");
  const note = text(body.note, "Note", { max: 200 });
  const mine = await ownPlayer(account);
  const squad = oneOf(body.squad ?? mine.main_squad ?? "AIR", SQUADS, "Squad");
  const stormTeam = oneOf(body.stormTeam ?? body.storm_team ?? "BOTH", STORM_TEAMS, "Storm team");

  const event = await queryOne<WeeklyEventRow>(
    `SELECT id, code, title, weekday::int AS weekday, server_time::text AS server_time, description, active
     FROM weekly_events WHERE id = $1 AND active = TRUE`,
    [weeklyEventId],
  );
  if (!event) throw new HttpError("Storm slot not found.", 404);

  const slots = occurrences(event, new Date());
  if (!slots.upcoming.includes(occurrenceDate)) {
    throw new HttpError(
      slots.past.includes(occurrenceDate) ? "That storm has already run." : "That date is not a slot for this storm.",
      409,
    );
  }
  if (!signupIsOpen(occurrenceDate, stormKindFromEvent(event.title, event.weekday))) {
    throw new HttpError("Signups for this storm have closed.", 409);
  }

  await query(
    `INSERT INTO event_signups (weekly_event_id, player_id, occurrence_date, squad, storm_team, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (weekly_event_id, player_id, occurrence_date)
     DO UPDATE SET squad = EXCLUDED.squad, storm_team = EXCLUDED.storm_team, note = EXCLUDED.note, status = 'APPLIED'`,
    [weeklyEventId, mine.id, occurrenceDate, squad, stormTeam, note],
  );
  await syncStormSignupsToGenerator(weeklyEventId, occurrenceDate);
  return ok({ applied: true, squad, stormTeam });
}

/** DELETE /api/events/signup — withdraw, or an R4/Master removes an applicant. */
async function withdraw(account: Account, url: URL) {
  requireModule(account, "events");
  const id = integer(url.searchParams.get("id"), "Signup id", { min: 1 });

  const signup = await queryOne<{ player_id: number; weekly_event_id: number; occurrence_date: string }>(
    "SELECT player_id, weekly_event_id, occurrence_date::text AS occurrence_date FROM event_signups WHERE id = $1",
    [id],
  );
  if (!signup) throw new HttpError("Signup not found.", 404);

  if (!canManage(account)) {
    const mine = await ownPlayer(account);
    if (signup.player_id !== mine.id) throw new HttpError("You can only withdraw your own signup.", 403);
  }

  await query("DELETE FROM event_signups WHERE id = $1", [id]);
  await syncStormSignupsToGenerator(signup.weekly_event_id, signup.occurrence_date);
  return ok({ id });
}

/** PATCH /api/events/signup — R4/Master approve or reject an applicant. */
async function reviewSignup(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const id = integer(body.id, "Signup id", { min: 1 });
  const status = oneOf(body.status, SIGNUP_STATUSES, "Status");

  const updated = await query<{ id: number; weekly_event_id: number; occurrence_date: string }>(
    `UPDATE event_signups SET status = $1 WHERE id = $2
     RETURNING id, weekly_event_id, occurrence_date::text AS occurrence_date`,
    [status, id],
  );
  if (!updated[0]) throw new HttpError("Signup not found.", 404);
  await syncStormSignupsToGenerator(updated[0].weekly_event_id, updated[0].occurrence_date);
  return ok({ id, status });
}

/** POST /api/events/teams — R4/Master publish a team for an occurrence. */
async function saveTeam(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const weeklyEventId = integer(body.weeklyEventId, "Event id", { min: 1 });
  const occurrenceDate = isoDate(body.occurrenceDate, "Occurrence date");
  const teamName = text(body.teamName, "Team name", { max: 60, required: true });
  const notes = text(body.notes, "Notes", { max: 1000 });
  const members = Array.isArray(body.members)
    ? body.members.map((member) => String(member).trim().slice(0, 40)).filter(Boolean).slice(0, 60)
    : [];

  if (body.id) {
    const id = integer(body.id, "Team id", { min: 1 });
    const updated = await query(
      `UPDATE event_teams SET team_name = $1, member_names = $2, notes = $3 WHERE id = $4 RETURNING id`,
      [teamName, JSON.stringify(members), notes, id],
    );
    if (!updated[0]) throw new HttpError("Team not found.", 404);
    return ok({ id });
  }

  const created = await query<{ id: number }>(
    `INSERT INTO event_teams (weekly_event_id, occurrence_date, team_name, member_names, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [weeklyEventId, occurrenceDate, teamName, JSON.stringify(members), notes, account.id],
  );
  return ok({ id: created[0].id });
}

/** DELETE /api/events/teams?id= */
async function removeTeam(account: Account, url: URL) {
  requireManage(account);
  const id = integer(url.searchParams.get("id"), "Team id", { min: 1 });
  const removed = await query("DELETE FROM event_teams WHERE id = $1 RETURNING id", [id]);
  if (!removed[0]) throw new HttpError("Team not found.", 404);
  return ok({ id });
}

export const eventRoutes: RouteTable = {
  "GET events": ({ account }) => overview(account),
  "POST events": ({ account, req }) => createEvent(account, req),
  "PATCH events": ({ account, req }) => updateEvent(account, req),
  "DELETE events": ({ account, url }) => removeEvent(account, url),
  "POST events/signup": ({ account, req }) => signUp(account, req),
  "PATCH events/signup": ({ account, req }) => reviewSignup(account, req),
  "DELETE events/signup": ({ account, url }) => withdraw(account, url),
  "POST events/teams": ({ account, req }) => saveTeam(account, req),
  "DELETE events/teams": ({ account, url }) => removeTeam(account, url),
};
