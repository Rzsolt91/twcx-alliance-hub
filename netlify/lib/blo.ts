/**
 * Pushes alliance-hub storm applies into the BLO generator, the same
 * shape Generate Teams expects after an Excel import. Failures are logged and
 * never block Apply on the portal.
 */

import { query, queryOne } from "./db.js";
import { asClock, nextOccurrenceDate } from "../../shared/time.js";

type BloEvent = "desert-storm" | "canyon-storm";

const WEEK_ID_RE = /^(\d{4})-W(\d{2})$/;
const BLO_EVENTS: BloEvent[] = ["desert-storm", "canyon-storm"];

function bloOrigin() {
  return String(process.env.BLO_ORIGIN ?? "").trim().replace(/\/$/, "");
}

export function generatorPublicUrl() {
  const url = String(process.env.BLO_PUBLIC_URL ?? process.env.BLO_ORIGIN ?? "").trim().replace(/\/$/, "");
  return url || null;
}

export function bloEventFromTitle(title: string): BloEvent | null {
  const value = title.trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (value.includes("desert")) return "desert-storm";
  if (value.includes("canyon")) return "canyon-storm";
  return null;
}

export function weekIdFromIsoDate(isoDate: string) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function isoWeekDateRange(weekId: string) {
  const match = WEEK_ID_RE.exec(weekId);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

function squadPower(row: { air_power: unknown; tank_power: unknown; missile_power: unknown; squad: string | null }) {
  if (row.squad === "AIR") return Number(row.air_power) || 0;
  if (row.squad === "TANK") return Number(row.tank_power) || 0;
  if (row.squad === "MISSILE") return Number(row.missile_power) || 0;
  return (Number(row.air_power) || 0) + (Number(row.tank_power) || 0) + (Number(row.missile_power) || 0);
}

function stormTeamLabel(value: string | null) {
  if (value === "A" || value === "B") return value;
  return "Both";
}

async function entriesForWeek(bloEvent: BloEvent, weekId: string) {
  const range = isoWeekDateRange(weekId);
  if (!range) return [];

  const rows = await query<{
    player_name: string;
    storm_team: string | null;
    squad: string | null;
    air_power: unknown;
    tank_power: unknown;
    missile_power: unknown;
    created_at: string;
  }>(
    `SELECT p.name AS player_name, s.storm_team, s.squad, p.air_power, p.tank_power, p.missile_power, s.created_at
     FROM event_signups s
     JOIN players p ON p.id = s.player_id
     JOIN weekly_events e ON e.id = s.weekly_event_id
     WHERE s.occurrence_date BETWEEN $1 AND $2
       AND s.status IN ('APPLIED', 'APPROVED')
       AND e.title ILIKE $3
     ORDER BY p.name, s.created_at DESC`,
    [range.from, range.to, bloEvent === "desert-storm" ? "%desert%" : "%canyon%"],
  );

  const seen = new Set<string>();
  const entries = [];
  for (const row of rows) {
    const key = row.player_name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    entries.push({
      playerName: row.player_name.trim(),
      team: stormTeamLabel(row.storm_team),
      power: squadPower(row),
    });
  }
  return entries;
}

async function pushEventWeek(bloEvent: BloEvent, weekId: string, options: { allowEmpty: boolean }) {
  const origin = bloOrigin();
  if (!origin) return { ok: false, skipped: "no-origin" as const, count: 0 };

  const entries = await entriesForWeek(bloEvent, weekId);
  if (!entries.length && !options.allowEmpty) {
    return { ok: true, skipped: "empty" as const, count: 0 };
  }

  const token = String(process.env.HUB_SYNC_TOKEN ?? "").trim();
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["x-hub-token"] = token;

  try {
    const response = await fetch(`${origin}/api/data/hub/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ weekId, event: bloEvent, entries }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`[blo] hub sync ${bloEvent} ${weekId} ${response.status} ${body.slice(0, 300)}`);
      return { ok: false, skipped: null, count: entries.length };
    }
    return { ok: true, skipped: null, count: entries.length };
  } catch (error) {
    console.warn("[blo] hub sync failed", error instanceof Error ? error.message : error);
    return { ok: false, skipped: null, count: entries.length };
  }
}

/** Push this storm’s week, and the other storm for the same ISO week if it has applies. */
export async function syncStormSignupsToGenerator(weeklyEventId: number, occurrenceDate: string) {
  const event = await queryOne<{ title: string }>("SELECT title FROM weekly_events WHERE id = $1", [weeklyEventId]);
  if (!event) return;
  const bloEvent = bloEventFromTitle(event.title);
  if (!bloEvent) return;

  const weekId = weekIdFromIsoDate(occurrenceDate);
  await pushEventWeek(bloEvent, weekId, { allowEmpty: true });
  const other = bloEvent === "desert-storm" ? "canyon-storm" : "desert-storm";
  await pushEventWeek(other, weekId, { allowEmpty: false });
}

/** Push every upcoming storm week that already has hub applies. */
export async function syncUpcomingStormsToGenerator() {
  if (!bloOrigin()) return [];

  const slots = await query<{ title: string; weekday: number; server_time: string }>(
    `SELECT title, weekday::int AS weekday, server_time::text AS server_time
     FROM weekly_events WHERE active = TRUE`,
  );
  const weekIds = new Set<string>();
  const now = new Date();
  for (const slot of slots) {
    if (!bloEventFromTitle(slot.title)) continue;
    weekIds.add(weekIdFromIsoDate(nextOccurrenceDate(Number(slot.weekday), asClock(slot.server_time), now)));
  }

  const results = [];
  for (const weekId of weekIds) {
    for (const bloEvent of BLO_EVENTS) {
      results.push({ weekId, event: bloEvent, ...(await pushEventWeek(bloEvent, weekId, { allowEmpty: false })) });
    }
  }
  return results;
}
