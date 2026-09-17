import type { Account } from "../auth.js";
import { canManage, requireManage, requireModule } from "../auth.js";
import { query, queryOne } from "../db.js";
import { HttpError, boolean, clockTime, integer, isoDate, ok, oneOf, readJson, text } from "../http.js";
import type { RouteTable } from "../router.js";
import {
  instantFromServerClock,
  occurrencesInRange,
  serverWallClock,
  shiftServerDate,
} from "../../../shared/time.js";

/** Matches the category check constraint on `calendar_events`. */
export const CATEGORIES = ["ALLIANCE", "VS", "GE", "GEW", "OTHER_GAME", "OTHER"] as const;

const MAX_RANGE_DAYS = 120;

/** Clamps a requested window to a sane size around today's server date. */
function resolveRange(url: URL) {
  const today = serverWallClock().date;
  const from = url.searchParams.get("from") ? isoDate(url.searchParams.get("from"), "From") : shiftServerDate(today, -14);
  const requested = url.searchParams.get("to") ? isoDate(url.searchParams.get("to"), "To") : shiftServerDate(today, 45);
  const ceiling = shiftServerDate(from, MAX_RANGE_DAYS);
  return { from, to: requested > ceiling ? ceiling : requested, today };
}

/** GET /api/calendar — manual events plus the recurring storms, in one list. */
async function list(account: Account, url: URL) {
  requireModule(account, "calendar");
  const { from, to, today } = resolveRange(url);

  const manual = await query(
    `SELECT c.id, c.title, c.event_date::text AS event_date, c.server_time, c.description, c.category, u.player_name AS author
     FROM calendar_events c
     LEFT JOIN users u ON u.id = c.created_by
     WHERE c.active = TRUE AND c.event_date BETWEEN $1 AND $2
     ORDER BY c.event_date, c.server_time`,
    [from, to],
  );

  const storms = await query<{
    id: number;
    title: string;
    weekday: number;
    server_time: string;
    description: string;
  }>(
    `SELECT id, title, weekday, server_time, description FROM weekly_events WHERE active = TRUE`,
  );

  const reminders = await query<{ event_kind: string; event_id: number }>(
    "SELECT event_kind, event_id FROM calendar_reminders WHERE user_id = $1",
    [account.id],
  );
  const reminded = new Set(reminders.map((row) => `${row.event_kind}:${row.event_id}`));

  const entries = manual.map((row) => {
    const serverTime = String(row.server_time).slice(0, 5);
    const date = String(row.event_date).slice(0, 10);
    return {
      key: `CALENDAR:${row.id}:${date}`,
      kind: "CALENDAR" as const,
      id: row.id,
      title: row.title,
      date,
      serverTime,
      instant: instantFromServerClock(date, serverTime).toISOString(),
      description: row.description,
      category: row.category,
      author: row.author,
      reminded: reminded.has(`CALENDAR:${row.id}`),
      editable: canManage(account),
      deletable: canManage(account),
    };
  });

  for (const storm of storms) {
    const serverTime = storm.server_time.slice(0, 5);
    for (const date of occurrencesInRange(storm.weekday, from, to)) {
      entries.push({
        key: `WEEKLY:${storm.id}:${date}`,
        kind: "WEEKLY" as any,
        id: storm.id,
        title: storm.title,
        date,
        serverTime,
        instant: instantFromServerClock(date, serverTime).toISOString(),
        description: storm.description,
        category: "STORM",
        author: null,
        reminded: reminded.has(`WEEKLY:${storm.id}`),
        editable: false,
        deletable: canManage(account),
      });
    }
  }

  entries.sort((left, right) => left.instant.localeCompare(right.instant));
  return ok({ from, to, today, entries, canManage: canManage(account) });
}

function readEventBody(body: Record<string, unknown>) {
  return {
    title: text(body.title, "Title", { max: 120, required: true }),
    eventDate: isoDate(body.date ?? body.eventDate, "Date"),
    serverTime: clockTime(body.serverTime, "Server time"),
    description: text(body.description, "Description", { max: 1500 }),
    category: oneOf(body.category ?? "OTHER", CATEGORIES, "Category"),
  };
}

/** POST /api/calendar — R4/Master add a daily event. */
async function create(account: Account, req: Request) {
  requireManage(account);
  const input = readEventBody(await readJson(req));

  const created = await query<{ id: number }>(
    `INSERT INTO calendar_events (title, event_date, server_time, description, category, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [input.title, input.eventDate, input.serverTime, input.description, input.category, account.id],
  );
  return ok({ id: created[0].id });
}

/** PATCH /api/calendar — R4/Master edit a daily event. */
async function update(account: Account, req: Request) {
  requireManage(account);
  const body = await readJson(req);
  const id = integer(body.id, "Event id", { min: 1 });
  const input = readEventBody(body);

  const updated = await query(
    `UPDATE calendar_events
     SET title = $1, event_date = $2, server_time = $3, description = $4, category = $5
     WHERE id = $6 AND active = TRUE RETURNING id`,
    [input.title, input.eventDate, input.serverTime, input.description, input.category, id],
  );
  if (!updated[0]) throw new HttpError("Event not found.", 404);
  return ok({ id });
}

/** DELETE /api/calendar?id= */
async function remove(account: Account, url: URL) {
  requireManage(account);
  const id = integer(url.searchParams.get("id"), "Event id", { min: 1 });
  const removed = await query("UPDATE calendar_events SET active = FALSE WHERE id = $1 RETURNING id", [id]);
  if (!removed[0]) throw new HttpError("Event not found.", 404);
  return ok({ id });
}

/** POST /api/calendar/reminder — turn a reminder on or off for the caller. */
async function toggleReminder(account: Account, req: Request) {
  requireModule(account, "calendar");
  const body = await readJson(req);
  const kind = oneOf(body.kind, ["WEEKLY", "CALENDAR"], "Kind");
  const eventId = integer(body.eventId, "Event id", { min: 1 });
  const wanted = boolean(body.on);

  const table = kind === "WEEKLY" ? "weekly_events" : "calendar_events";
  const exists = await queryOne(`SELECT 1 FROM ${table} WHERE id = $1`, [eventId]);
  if (!exists) throw new HttpError("Event not found.", 404);

  if (wanted) {
    await query(
      `INSERT INTO calendar_reminders (user_id, event_kind, event_id) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, event_kind, event_id) DO NOTHING`,
      [account.id, kind, eventId],
    );
  } else {
    await query("DELETE FROM calendar_reminders WHERE user_id = $1 AND event_kind = $2 AND event_id = $3", [
      account.id,
      kind,
      eventId,
    ]);
  }
  return ok({ kind, eventId, on: wanted });
}

export const calendarRoutes: RouteTable = {
  "GET calendar": ({ account, url }) => list(account, url),
  "POST calendar": ({ account, req }) => create(account, req),
  "PATCH calendar": ({ account, req }) => update(account, req),
  "DELETE calendar": ({ account, url }) => remove(account, url),
  "POST calendar/reminder": ({ account, req }) => toggleReminder(account, req),
};
