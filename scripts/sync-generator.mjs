/**
 * Push current hub storm applies into the live generator.
 * Used by GitHub Actions so existing Desert/Canyon signups land without a new Apply.
 */

import pg from "pg";

const origin = String(process.env.BLO_ORIGIN ?? "https://twcx-generator.netlify.app").trim().replace(/\/$/, "");
const token = String(process.env.HUB_SYNC_TOKEN ?? "").trim();
const url = String(process.env.DATABASE_URL ?? "").trim();

if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

function sslFor(connection) {
  if (/supabase|sslmode=require/i.test(connection)) return { rejectUnauthorized: false };
  return undefined;
}

function weekIdFromIsoDate(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function isoWeekDateRange(weekId) {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekId);
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

function squadPower(row) {
  if (row.squad === "AIR") return Number(row.air_power) || 0;
  if (row.squad === "TANK") return Number(row.tank_power) || 0;
  if (row.squad === "MISSILE") return Number(row.missile_power) || 0;
  return (Number(row.air_power) || 0) + (Number(row.tank_power) || 0) + (Number(row.missile_power) || 0);
}

const pool = new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 1 });

const slots = await pool.query(
  "SELECT title, occurrence_date::text AS occurrence_date FROM event_signups s JOIN weekly_events e ON e.id = s.weekly_event_id WHERE s.status IN ('APPLIED', 'APPROVED')",
);

const weeks = new Set();
for (const row of slots.rows) weeks.add(weekIdFromIsoDate(row.occurrence_date));
if (!weeks.size) {
  console.log("no hub applies");
  await pool.end();
  process.exit(0);
}

const headers = { "content-type": "application/json" };
if (token) headers["x-hub-token"] = token;

for (const weekId of [...weeks].sort()) {
  const range = isoWeekDateRange(weekId);
  if (!range) continue;
  for (const event of ["desert-storm", "canyon-storm"]) {
    const rows = await pool.query(
      `SELECT p.name AS player_name, s.storm_team, s.squad, p.air_power, p.tank_power, p.missile_power, s.created_at
       FROM event_signups s
       JOIN players p ON p.id = s.player_id
       JOIN weekly_events e ON e.id = s.weekly_event_id
       WHERE s.occurrence_date BETWEEN $1 AND $2
         AND s.status IN ('APPLIED', 'APPROVED')
         AND e.title ILIKE $3
       ORDER BY p.name, s.created_at DESC`,
      [range.from, range.to, event === "desert-storm" ? "%desert%" : "%canyon%"],
    );
    const seen = new Set();
    const entries = [];
    for (const row of rows.rows) {
      const key = String(row.player_name || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      entries.push({
        playerName: String(row.player_name).trim(),
        team: row.storm_team === "A" || row.storm_team === "B" ? row.storm_team : "Both",
        power: squadPower(row),
      });
    }
    if (!entries.length) {
      console.log(weekId, event, "skip empty");
      continue;
    }
    const response = await fetch(`${origin}/api/data/hub/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify({ weekId, event, entries }),
    });
    const body = await response.text().catch(() => "");
    console.log(weekId, event, "count", entries.length, "status", response.status, body.slice(0, 180));
    if (!response.ok) process.exitCode = 1;
  }
}

await pool.end();
