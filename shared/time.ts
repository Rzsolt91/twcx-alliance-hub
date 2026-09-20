/**
 * Server-clock arithmetic, shared by the API and the browser bundle.
 *
 * The game server clock runs three hours behind Lisbon. Lisbon itself moves
 * between WET and WEST, so the server clock cannot be treated as a fixed UTC
 * offset: every conversion resolves the Lisbon offset at the relevant instant.
 */

export const ANCHOR_ZONE = "Europe/Lisbon";
export const SERVER_HOURS_BEHIND_ANCHOR = 3;

const HOUR_MS = 3_600_000;
const SERVER_SHIFT_MS = SERVER_HOURS_BEHIND_ANCHOR * HOUR_MS;

export type WallClock = {
  /** Calendar date in the target zone, as YYYY-MM-DD. */
  date: string;
  /** Time of day in the target zone, as HH:MM. */
  time: string;
  /** 0 = Sunday … 6 = Saturday, in the target zone. */
  weekday: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string) {
  let formatter = formatterCache.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    formatterCache.set(zone, formatter);
  }
  return formatter;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

type ZoneParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

function partsInZone(zone: string, instantMs: number): ZoneParts {
  const bag: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(instantMs)) bag[part.type] = part.value;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour) % 24,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday: WEEKDAY_INDEX[bag.weekday] ?? 0,
  };
}

/** Offset of `zone` from UTC, in milliseconds, at a given instant. */
export function zoneOffsetMs(zone: string, instantMs: number) {
  const parts = partsInZone(zone, instantMs);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Wall clock reading of an instant in any IANA zone. */
export function wallClockIn(zone: string, instant: Date | number): WallClock {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  const parts = partsInZone(zone, ms);
  return {
    date: `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`,
    time: `${pad(parts.hour)}:${pad(parts.minute)}`,
    weekday: parts.weekday,
  };
}

/**
 * The UTC instant whose wall clock in `zone` is the given date and time.
 * Resolved by fixed-point iteration so DST transitions land correctly.
 */
export function instantFromWallClock(zone: string, date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);

  let instant = naive;
  for (let pass = 0; pass < 3; pass += 1) {
    const next = naive - zoneOffsetMs(zone, instant);
    if (next === instant) break;
    instant = next;
  }
  return new Date(instant);
}

/** Server wall clock reading of an instant. */
export function serverWallClock(instant: Date | number = Date.now()): WallClock {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  return wallClockIn(ANCHOR_ZONE, ms - SERVER_SHIFT_MS);
}

/** The instant at which the server clock reads the given date and time. */
export function instantFromServerClock(date: string, time: string): Date {
  return new Date(instantFromWallClock(ANCHOR_ZONE, date, time).getTime() + SERVER_SHIFT_MS);
}

/** Shifts a server calendar date by whole days, staying in the server calendar. */
export function shiftServerDate(date: string, days: number) {
  const [year, month, day] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return moved.toISOString().slice(0, 10);
}

/** Weekday (0-6) of a server calendar date. */
export function serverDateWeekday(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Server clock when storm signups close (15:00 UK / Lisbon). */
export const SIGNUP_DEADLINE_SERVER_TIME = "12:00";

export type StormKind = "desert-storm" | "canyon-storm";

/**
 * Desert Storm closes Wednesday 12:00 server; Canyon Storm the Monday before
 * at the same clock. Unknown titles follow the slot weekday (Thu → Canyon).
 */
export function stormKindFromEvent(title: string, weekday?: number): StormKind {
  const value = String(title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (value.includes("canyon")) return "canyon-storm";
  if (value.includes("desert")) return "desert-storm";
  return weekday === 4 ? "canyon-storm" : "desert-storm";
}

/** Most recent `weekday` on or before `date` in the server calendar. */
export function previousServerWeekdayOnOrBefore(date: string, weekday: number) {
  const day = ((Math.trunc(Number(weekday)) % 7) + 7) % 7;
  const gap = (serverDateWeekday(date) - day + 7) % 7;
  return shiftServerDate(date, -gap);
}

export function signupDeadlineWeekday(kind: StormKind) {
  return kind === "canyon-storm" ? 1 : 3;
}

export function signupDeadlineDate(occurrenceDate: string, kind: StormKind) {
  return previousServerWeekdayOnOrBefore(occurrenceDate, signupDeadlineWeekday(kind));
}

export function signupClosesAt(occurrenceDate: string, kind: StormKind) {
  return instantFromServerClock(signupDeadlineDate(occurrenceDate, kind), SIGNUP_DEADLINE_SERVER_TIME);
}

/** Apply is allowed strictly before the deadline instant. */
export function signupIsOpen(occurrenceDate: string, kind: StormKind, now: Date | number = Date.now()) {
  const ms = now instanceof Date ? now.getTime() : now;
  return ms < signupClosesAt(occurrenceDate, kind).getTime();
}

/** Monday that starts the server week containing `date`. */
export function serverWeekStart(date: string) {
  const weekday = serverDateWeekday(date);
  return shiftServerDate(date, -((weekday + 6) % 7));
}

/**
 * Next server date on or after `fromDate` whose weekday matches, skipping
 * today when today's slot has already passed.
 */
export function nextOccurrenceDate(weekday: number, time: string, now: Date = new Date()) {
  const today = serverWallClock(now);
  const day = Number(weekday);
  if (!Number.isFinite(day)) return today.date;
  const gap = ((((Math.trunc(day) % 7) + 7) % 7) - serverDateWeekday(today.date) + 7) % 7;
  const candidate = shiftServerDate(today.date, gap);
  if (gap === 0 && today.time >= time) return shiftServerDate(candidate, 7);
  return candidate;
}

/** Normalise a TIME / clock value from Postgres or an input to `HH:MM`. */
export function asClock(value: unknown) {
  const raw = String(value ?? "").trim();
  const match = raw.match(/(?:^|[T\s])(\d{1,2}):([0-5]\d)/) ?? raw.match(/^(\d{1,2}):([0-5]\d)/);
  if (!match) return "00:00";
  const hour = Number(match[1]);
  if (hour > 23) return "00:00";
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

/** Every date matching `weekday` inside an inclusive server-date range. */
export function occurrencesInRange(weekday: number, from: string, to: string) {
  const day = Number(weekday);
  if (!Number.isFinite(day)) return [];
  const gap = ((((Math.trunc(day) % 7) + 7) % 7) - serverDateWeekday(from) + 7) % 7;
  const dates: string[] = [];
  for (let date = shiftServerDate(from, gap); date <= to; date = shiftServerDate(date, 7)) {
    dates.push(date);
  }
  return dates;
}
