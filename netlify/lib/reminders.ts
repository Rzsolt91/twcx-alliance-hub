import { sendDiscordDM } from "./discord.js";
import { query } from "./db.js";
import { instantFromServerClock, nextOccurrenceDate, shiftServerDate } from "../../shared/time.js";

/** DMs go out once, five minutes before that event starts — not on a 24/7 poll. */
const LEAD_MINUTES = 5;
/** Timer/clock skew around T-5. Send only if the start is 4–6 minutes away. */
const WINDOW_MINUTES = 1;

type ReminderRow = {
  signup_id: number;
  occurrence_date: string;
  title: string;
  server_time: string;
  discord_id: string;
  player_name: string | null;
};

type WeeklySlot = {
  weekday: number;
  server_time: string;
};

function leadMs() {
  return LEAD_MINUTES * 60_000;
}

function windowMs() {
  return WINDOW_MINUTES * 60_000;
}

function inSendWindow(startAt: number, now: number) {
  const until = startAt - now;
  return until >= leadMs() - windowMs() && until <= leadMs() + windowMs();
}

function fireAt(startAt: number) {
  return startAt - leadMs();
}

/**
 * Milliseconds until the next T-5 wake for an active weekly event.
 * Null when there is no upcoming slot. Does not send anything.
 */
export async function msUntilNextReminder(): Promise<number | null> {
  const slots = await query<WeeklySlot>(
    "SELECT weekday, server_time::text AS server_time FROM weekly_events WHERE active = TRUE",
  );
  if (!slots.length) return null;

  const now = Date.now();
  let soonest: number | null = null;

  for (const slot of slots) {
    const time = String(slot.server_time).slice(0, 5);
    let date = nextOccurrenceDate(Number(slot.weekday), time, new Date(now));
    for (let week = 0; week < 3; week += 1) {
      const startAt = instantFromServerClock(date, time).getTime();
      if (inSendWindow(startAt, now)) return 0;
      const wake = fireAt(startAt);
      if (wake > now) {
        const wait = wake - now;
        if (soonest === null || wait < soonest) soonest = wait;
        break;
      }
      date = shiftServerDate(date, 7);
    }
  }

  return soonest;
}

export async function runReminderPass() {
  const token = String(process.env.DISCORD_BOT_TOKEN ?? "").trim();
  if (!token) {
    return { sent: 0, failed: 0, skipped: 0, deferred: 0 };
  }

  const now = Date.now();
  const rows = await query<ReminderRow>(
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
    const start = instantFromServerClock(row.occurrence_date.slice(0, 10), String(row.server_time).slice(0, 5));
    if (!inSendWindow(start.getTime(), now)) {
      skipped += 1;
      continue;
    }

    const clock = `${row.occurrence_date.slice(0, 10)} ${String(row.server_time).slice(0, 5)}`;
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

  if (sent || failed || deferred) {
    console.info(`discord reminders sent=${sent} failed=${failed} deferred=${deferred}`);
  }
  return { sent, failed, skipped, deferred };
}
