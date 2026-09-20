import { sendDiscordDM } from "./discord.js";
import { query } from "./db.js";
import { asClock, instantFromServerClock, nextOccurrenceDate, shiftServerDate } from "../../shared/time.js";

/** DMs go out once, about five minutes before that event starts. */
const LEAD_MINUTES = 5;
/**
 * Send if the start is still in the future and at most this far away.
 * Wider than T-5 so a slightly late GitHub job still delivers.
 */
const SEND_WITHIN_MINUTES = 12;

type StormSignupRow = {
  signup_id: number;
  occurrence_date: string;
  title: string;
  server_time: string;
  discord_id: string;
  player_name: string | null;
};

type CalendarReminderRow = {
  reminder_user_id: number;
  event_id: number;
  event_date: string;
  title: string;
  server_time: string;
  discord_id: string;
  player_name: string | null;
};

type WeeklySlot = {
  weekday: number;
  server_time: string;
};

type CalendarSlot = {
  event_date: string;
  server_time: string;
};

function leadMs() {
  return LEAD_MINUTES * 60_000;
}

function sendWithinMs() {
  return SEND_WITHIN_MINUTES * 60_000;
}

function inSendWindow(startAt: number, now: number) {
  const until = startAt - now;
  return until > 0 && until <= sendWithinMs();
}

function fireAt(startAt: number) {
  return startAt - leadMs();
}

function considerWake(startAt: number, now: number, soonest: number | null) {
  if (inSendWindow(startAt, now)) return 0;
  const wake = fireAt(startAt);
  if (wake <= now) return soonest;
  const wait = wake - now;
  if (soonest === null || wait < soonest) return wait;
  return soonest;
}

async function ensureCalendarSentColumn() {
  await query("ALTER TABLE calendar_reminders ADD COLUMN IF NOT EXISTS discord_sent_at TIMESTAMPTZ");
}

/**
 * Milliseconds until the next T-5 wake for a storm slot or calendar event.
 * Null when nothing is upcoming. Does not send anything.
 */
export async function msUntilNextReminder(): Promise<number | null> {
  const now = Date.now();
  let soonest: number | null = null;

  const slots = await query<WeeklySlot>(
    "SELECT weekday, server_time::text AS server_time FROM weekly_events WHERE active = TRUE",
  );
  for (const slot of slots) {
    const time = asClock(slot.server_time);
    let date = nextOccurrenceDate(Number(slot.weekday), time, new Date(now));
    for (let week = 0; week < 6; week += 1) {
      const startAt = instantFromServerClock(date, time).getTime();
      const next = considerWake(startAt, now, soonest);
      if (next === 0) return 0;
      soonest = next;
      if (fireAt(startAt) > now) break;
      date = shiftServerDate(date, 7);
    }
  }

  const calendars = await query<CalendarSlot>(
    `SELECT event_date::text AS event_date, server_time::text AS server_time
     FROM calendar_events
     WHERE active = TRUE AND event_date >= (CURRENT_DATE - 1)`,
  );
  for (const event of calendars) {
    const date = String(event.event_date).slice(0, 10);
    const startAt = instantFromServerClock(date, asClock(event.server_time)).getTime();
    const next = considerWake(startAt, now, soonest);
    if (next === 0) return 0;
    soonest = next;
  }

  return soonest;
}

async function sendStormSignups(now: number) {
  const rows = await query<StormSignupRow>(
    `SELECT s.id AS signup_id, s.occurrence_date::text AS occurrence_date,
            e.title, e.server_time::text AS server_time,
            u.discord_id, u.player_name
     FROM event_signups s
     JOIN weekly_events e ON e.id = s.weekly_event_id
     JOIN players p ON p.id = s.player_id
     JOIN users u ON u.id = p.user_id
     WHERE s.reminder_sent_at IS NULL
       AND s.status IN ('APPLIED', 'APPROVED')
       AND e.active = TRUE
       AND u.discord_id IS NOT NULL
       AND u.discord_id <> ''`,
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;

  for (const row of rows) {
    const start = instantFromServerClock(row.occurrence_date.slice(0, 10), asClock(row.server_time));
    if (!inSendWindow(start.getTime(), now)) {
      skipped += 1;
      continue;
    }

    const clock = `${row.occurrence_date.slice(0, 10)} ${asClock(row.server_time)}`;
    const name = row.player_name || "commander";
    const message = `TWCX reminder: ${row.title} starts at ${clock} server time. You are signed up, ${name}.`;

    try {
      const ok = await sendDiscordDM(row.discord_id, message);
      await query("UPDATE event_signups SET reminder_sent_at = NOW() WHERE id = $1", [row.signup_id]);
      if (ok) sent += 1;
      else failed += 1;
    } catch (error) {
      deferred += 1;
      console.warn(`discord reminder deferred for signup ${row.signup_id}`, error instanceof Error ? error.message : error);
    }
  }

  return { sent, failed, skipped, deferred };
}

async function sendCalendarReminders(now: number) {
  await ensureCalendarSentColumn();
  const rows = await query<CalendarReminderRow>(
    `SELECT r.user_id AS reminder_user_id, r.event_id,
            e.event_date::text AS event_date, e.title, e.server_time::text AS server_time,
            u.discord_id, u.player_name
     FROM calendar_reminders r
     JOIN calendar_events e ON e.id = r.event_id
     JOIN users u ON u.id = r.user_id
     WHERE r.event_kind = 'CALENDAR'
       AND r.discord_sent_at IS NULL
       AND e.active = TRUE
       AND u.discord_id IS NOT NULL
       AND u.discord_id <> ''`,
  );

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let deferred = 0;

  for (const row of rows) {
    const date = String(row.event_date).slice(0, 10);
    const start = instantFromServerClock(date, asClock(row.server_time));
    if (!inSendWindow(start.getTime(), now)) {
      skipped += 1;
      continue;
    }

    const clock = `${date} ${asClock(row.server_time)}`;
    const name = row.player_name || "commander";
    const message = `TWCX reminder: ${row.title} starts at ${clock} server time, ${name}.`;

    try {
      const ok = await sendDiscordDM(row.discord_id, message);
      await query(
        `UPDATE calendar_reminders SET discord_sent_at = NOW()
         WHERE user_id = $1 AND event_kind = 'CALENDAR' AND event_id = $2`,
        [row.reminder_user_id, row.event_id],
      );
      if (ok) sent += 1;
      else failed += 1;
    } catch (error) {
      deferred += 1;
      console.warn(
        `discord reminder deferred for calendar ${row.event_id} user ${row.reminder_user_id}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return { sent, failed, skipped, deferred };
}

export async function runReminderPass() {
  const token = String(process.env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!token) {
    return { sent: 0, failed: 0, skipped: 0, deferred: 0 };
  }

  const now = Date.now();
  const storms = await sendStormSignups(now);
  const calendars = await sendCalendarReminders(now);
  const sent = storms.sent + calendars.sent;
  const failed = storms.failed + calendars.failed;
  const skipped = storms.skipped + calendars.skipped;
  const deferred = storms.deferred + calendars.deferred;

  if (sent || failed || deferred) {
    console.info(`discord reminders sent=${sent} failed=${failed} deferred=${deferred}`);
  }
  return { sent, failed, skipped, deferred, storms: storms.sent, calendar: calendars.sent };
}
