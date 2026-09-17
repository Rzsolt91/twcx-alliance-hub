/** Small HTTP helpers shared by every API route. */

export type Json = Record<string, unknown>;

export function ok(data: unknown, status = 200) {
  return Response.json(data as Json, { status });
}

/** Same as `ok`, plus the `Set-Cookie` header a sign-in or sign-out needs. */
export function okWithCookie(data: unknown, setCookie: string, status = 200) {
  return Response.json(data as Json, { status, headers: { "set-cookie": setCookie } });
}

export function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Reads a JSON body, rejecting anything that is not an object. */
export async function readJson(req: Request): Promise<Json> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    throw new HttpError("Expected a JSON request body.", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError("Expected a JSON object.", 400);
  }
  return parsed as Json;
}

/** Trimmed string, capped in length. Throws when required and empty. */
export function text(value: unknown, field: string, { max = 200, required = false } = {}) {
  const out = String(value ?? "").trim().slice(0, max);
  if (required && !out) throw new HttpError(`${field} is required.`, 422);
  return out;
}

export function integer(value: unknown, field: string, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const out = Number(value);
  if (!Number.isFinite(out)) throw new HttpError(`${field} must be a number.`, 422);
  const rounded = Math.round(out);
  if (rounded < min || rounded > max) throw new HttpError(`${field} must be between ${min} and ${max}.`, 422);
  return rounded;
}

export function decimal(value: unknown, field: string, { min = 0, max = 1e12 } = {}) {
  const out = Number(value);
  if (!Number.isFinite(out)) throw new HttpError(`${field} must be a number.`, 422);
  if (out < min || out > max) throw new HttpError(`${field} must be between ${min} and ${max}.`, 422);
  return Math.round(out * 100) / 100;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  const out = String(value ?? "").trim().toUpperCase();
  const match = allowed.find((candidate) => candidate.toUpperCase() === out);
  if (!match) throw new HttpError(`${field} must be one of: ${allowed.join(", ")}.`, 422);
  return match;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isoDate(value: unknown, field: string) {
  const out = String(value ?? "").trim().slice(0, 10);
  if (!ISO_DATE.test(out) || Number.isNaN(Date.parse(`${out}T00:00:00Z`))) {
    throw new HttpError(`${field} must be a date as YYYY-MM-DD.`, 422);
  }
  return out;
}

/** Normalises "9:00", "09:00:00" and "09:00" to "09:00". */
export function clockTime(value: unknown, field: string) {
  const raw = String(value ?? "").trim();
  const padded = /^\d:\d\d/.test(raw) ? `0${raw}` : raw;
  const out = padded.slice(0, 5);
  if (!CLOCK.test(out)) throw new HttpError(`${field} must be a time as HH:MM.`, 422);
  return out;
}

export function boolean(value: unknown) {
  return value === true || value === "true" || value === 1 || value === "1";
}
