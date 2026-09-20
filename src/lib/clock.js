/**
 * Clock helpers for the browser. All server-time arithmetic comes from the
 * module shared with the API, so both sides agree to the minute.
 */

import {
  ANCHOR_ZONE,
  SERVER_HOURS_BEHIND_ANCHOR,
  instantFromServerClock,
  serverDateWeekday,
  serverWallClock,
  serverWeekStart,
  shiftServerDate,
  signupClosesAt,
  signupDeadlineDate,
  signupIsOpen,
  stormKindFromEvent,
  wallClockIn,
} from "../../shared/time.ts";
import { locale } from "./i18n.js";

export {
  ANCHOR_ZONE,
  SERVER_HOURS_BEHIND_ANCHOR,
  instantFromServerClock,
  serverDateWeekday,
  serverWallClock,
  serverWeekStart,
  shiftServerDate,
  signupClosesAt,
  signupDeadlineDate,
  signupIsOpen,
  stormKindFromEvent,
};

/** Every zone the runtime knows about — the brief asks for all of them. */
export function allTimezones() {
  if (typeof Intl.supportedValuesOf === "function") {
    try {
      return Intl.supportedValuesOf("timeZone");
    } catch {
      /* fall through to the short list */
    }
  }
  return [
    "Europe/Lisbon",
    "Europe/London",
    "Europe/Madrid",
    "Europe/Paris",
    "Europe/Berlin",
    "Europe/Moscow",
    "America/New_York",
    "America/Chicago",
    "America/Sao_Paulo",
    "America/Los_Angeles",
    "Asia/Seoul",
    "Asia/Tokyo",
    "Asia/Shanghai",
    "Asia/Kolkata",
    "Asia/Dubai",
    "Australia/Sydney",
    "UTC",
  ];
}

/** The viewer's own zone, used as the registration default. */
export function detectTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Europe/Lisbon";
  } catch {
    return "Europe/Lisbon";
  }
}

function asDate(value) {
  return value instanceof Date ? value : new Date(value);
}

/** UTC offset of a zone at an instant, as `UTC+02:00`. */
export function zoneLabel(zone, instant = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" })
    .formatToParts(asDate(instant))
    .find((part) => part.type === "timeZoneName");
  const raw = parts?.value ?? "GMT";
  return raw.replace("GMT", "UTC").replace(/^UTC$/, "UTC+00:00");
}

/** `14:05` in the given zone. */
/** `<select>` options for every zone, labelled with its current offset. */
export function timezoneOptions(selected) {
  const zones = allTimezones();
  const list = selected && !zones.includes(selected) ? [selected, ...zones] : zones;
  return list.map((zone) => ({ value: zone, label: `${zone.replace(/_/g, " ")} (${zoneLabel(zone)})` }));
}

export function timeIn(zone, instant) {
  return wallClockIn(zone, asDate(instant).getTime()).time;
}

/** `Thu 17 Sep, 14:05` in the given zone, in the active interface language. */
export function dateTimeIn(zone, instant, options = {}) {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: zone,
    weekday: options.weekday === false ? undefined : "short",
    day: "numeric",
    month: "short",
    year: options.year ? "numeric" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(asDate(instant));
}

/** `Thu 17 Sep` in the given zone. */
export function dateIn(zone, instant, options = {}) {
  return new Intl.DateTimeFormat(locale(), {
    timeZone: zone,
    weekday: options.weekday === false ? undefined : "short",
    day: "numeric",
    month: "short",
    year: options.year ? "numeric" : undefined,
  }).format(asDate(instant));
}

/** Formats a bare `YYYY-MM-DD` server date without any zone conversion. */
export function formatServerDate(date, options = {}) {
  const [year, month, day] = String(date).split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), {
    timeZone: "UTC",
    weekday: options.weekday === false ? undefined : "short",
    day: "numeric",
    month: "short",
    year: options.year ? "numeric" : undefined,
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

const WEEKDAY_BASE = Date.UTC(2024, 0, 7); // a Sunday

/** Localised weekday names, index 0 = Sunday, matching the database column. */
export function weekdayNames(style = "long") {
  const formatter = new Intl.DateTimeFormat(locale(), { timeZone: "UTC", weekday: style });
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(WEEKDAY_BASE + index * 86_400_000)),
  );
}

export function weekdayName(index, style = "long") {
  return weekdayNames(style)[((index % 7) + 7) % 7] ?? "";
}

/** `2d 04:12` / `04:12:07` / `now` — coarse far out, precise when close. */
export function countdown(instant, from = Date.now()) {
  const diff = asDate(instant).getTime() - (from instanceof Date ? from.getTime() : from);
  if (diff <= 0) return null;
  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hours)}:${pad(minutes)}`;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Calls `listener` immediately and then once per second with the current
 * instant. Returns a stop function. Used for the rail clocks and countdowns.
 */
export function everySecond(listener) {
  let stopped = false;
  let timer = 0;
  const tick = () => {
    if (stopped) return;
    listener(new Date());
    // Re-align to the next wall-clock second so the display never skips.
    timer = window.setTimeout(tick, 1000 - (Date.now() % 1000));
  };
  tick();
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

/* View-scoped tickers: the shell stops them all before rendering a new view,
   so countdowns and world clocks never pile up. */

const viewTickers = new Set();

export function viewTick(listener) {
  const stop = everySecond(listener);
  const dispose = () => {
    stop();
    viewTickers.delete(dispose);
  };
  viewTickers.add(dispose);
  return dispose;
}

export function stopViewTickers() {
  for (const dispose of [...viewTickers]) dispose();
}
