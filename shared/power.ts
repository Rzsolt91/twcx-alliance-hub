/**
 * Alliance power readings as commanders actually type them:
 * `65000000`, `65M`, `65,32M`, `1.234.567`, `40kk`.
 */

const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  kk: 1e6,
  m: 1e6,
  mi: 1e6,
  b: 1e9,
  bi: 1e9,
  g: 1e9,
};

/**
 * Parses a power string. Empty input is 0. Junk that cannot be read is NaN
 * so a form can reject it instead of silently storing zero.
 */
export function parsePower(raw: unknown) {
  const original = String(raw ?? "").trim();
  if (!original) return 0;

  let value = original.replace(/[\s\u00a0\u202f]/g, "").replace(/[^0-9.,kKmMbBgGiI+-]/g, "");
  if (!value) return Number.NaN;

  const suffix = /(kk|k|mi|m|bi|b|g)$/i.exec(value);
  const multiplier = suffix ? (MULTIPLIERS[suffix[1].toLowerCase()] ?? 1) : 1;
  if (suffix) value = value.slice(0, -suffix[1].length);
  if (!value) return Number.NaN;

  const lastDot = value.lastIndexOf(".");
  const lastComma = value.lastIndexOf(",");

  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? "." : ",";
    const thousands = decimal === "." ? "," : ".";
    value = value.split(thousands).join("").replace(decimal, ".");
  } else if (lastComma >= 0) {
    const tail = value.length - lastComma - 1;
    value = tail === 3 && !suffix ? value.split(",").join("") : value.replace(/,/g, ".");
  } else if (lastDot >= 0) {
    const tail = value.length - lastDot - 1;
    if (tail === 3 && !suffix) value = value.split(".").join("");
  }

  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return Number.NaN;
  return Math.round(Math.min(number * multiplier, 1e12) * 100) / 100;
}

/** Compact label for display and for putting a saved reading back into an input. */
export function formatPower(raw: unknown) {
  const value = typeof raw === "number" ? raw : parsePower(raw);
  if (!Number.isFinite(value) || value === 0) return "0";
  if (value >= 1e6) {
    const millions = Math.round((value / 1e6) * 100) / 100;
    return `${stripTrailingZeros(millions)}M`;
  }
  return new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }).format(Math.round(value));
}

function stripTrailingZeros(value: number) {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
