/**
 * Turns a spreadsheet (or a pasted block of rows) into roster entries.
 *
 * The alliance keeps its rosters in whatever shape the exporting tool produced,
 * so columns are matched by header name in English and Portuguese rather than
 * by position, and only fall back to a fixed order when no header is
 * recognised. Nothing is written here — the caller reviews the result first.
 */

import { parsePower } from "../../shared/power.js";
import type { SheetTable } from "./sheets.js";

export const IMPORT_SQUADS = ["AIR", "TANK", "MISSILE"] as const;
export type ImportSquad = (typeof IMPORT_SQUADS)[number];

export type ImportField = "name" | "rank" | "squad" | "air" | "tank" | "missile" | "thp";

export type ImportRow = {
  /** Row number in the source file, counting the header as row 1. */
  line: number;
  name: string;
  rank: "R4" | "R3";
  mainSquad: ImportSquad;
  airPower: number;
  tankPower: number;
  missilePower: number;
  thp: number;
  /** Why this row will be skipped, or notes worth showing before importing. */
  issues: string[];
  skip: boolean;
};

export type ImportPreview = {
  sheetName: string;
  headers: string[];
  /** Which source column feeds each field, by header index. */
  mapping: Partial<Record<ImportField, number>>;
  usedHeaderRow: boolean;
  rows: ImportRow[];
};

/** Case, accent and punctuation insensitive key for header matching. */
function headerKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const ALIASES: Record<ImportField, string[]> = {
  name: [
    "name", "playername", "player", "nome", "nomedojogador", "nomejogador", "jogador", "jogadora",
    "nick", "nickname", "apelido", "ign", "member", "membro", "utilizador", "username", "user",
  ],
  rank: ["rank", "ranking", "patente", "posto", "cargo", "role", "funcao", "nivel", "titulo"],
  squad: [
    "squad", "mainsquad", "main", "squadmain", "esquadrao", "esquadra", "esquadraprincipal",
    "tropa", "tropaprincipal", "unidade", "principal", "tipo", "classe",
  ],
  air: ["air", "airpower", "poderaereo", "aereo", "ar", "aviao", "aviacao", "avioes", "poderar", "forcaaerea"],
  tank: ["tank", "tankpower", "podertanque", "tanque", "tanques", "blindado", "blindados"],
  missile: [
    "missile", "missilepower", "podermissil", "missil", "misseis", "missiles", "misseto", "foguete", "foguetes",
  ],
  thp: [
    "thp", "totalhp", "hp", "heropower", "totalheropower", "poderheroi", "poderdeheroi", "poderdosherois",
    "poderherois", "herois", "heroi", "hero", "heroes", "poderheroico", "poderdoheroi",
  ],
};

const LOOKUP = new Map<string, ImportField>();
for (const [field, aliases] of Object.entries(ALIASES) as [ImportField, string[]][]) {
  for (const alias of aliases) if (!LOOKUP.has(alias)) LOOKUP.set(alias, field);
}

/** Matches header cells to fields, keeping the first column for each field. */
function mapHeaders(headers: string[]) {
  const mapping: Partial<Record<ImportField, number>> = {};
  headers.forEach((header, index) => {
    const field = LOOKUP.get(headerKey(header));
    if (field && mapping[field] === undefined) mapping[field] = index;
  });
  return mapping;
}

/* --------------------------------------------------------------- values --- */

/**
 * Reads a power value the way alliance sheets actually write them: `1234567`,
 * `1.234.567`, `1,234,567`, `12.5M`, `40kk`, `1 234 567` or `1,5M`.
 */
export function parseAmount(raw: unknown) {
  const value = parsePower(raw);
  return Number.isFinite(value) ? value : 0;
}

function parseRank(raw: unknown): "R4" | "R3" {
  const value = headerKey(String(raw ?? ""));
  if (!value) return "R3";
  if (/(r?4|r?5|master|lider|leader|chefe|oficial)/.test(value)) return "R4";
  return "R3";
}

function parseSquad(raw: unknown): ImportSquad | null {
  const value = headerKey(String(raw ?? ""));
  if (!value) return null;
  if (/(air|aereo|aviao|aviacao|forcaaerea)/.test(value) || value === "ar") return "AIR";
  if (/(tank|tanque|blindad)/.test(value)) return "TANK";
  if (/(missil|missile|misseis|foguete)/.test(value)) return "MISSILE";
  return null;
}

/* -------------------------------------------------------------- preview --- */

/** Column order used when a file arrives without a recognisable header. */
const POSITIONAL: ImportField[] = ["name", "air", "tank", "missile", "thp"];

export function buildPreview(table: SheetTable, limit: number): ImportPreview {
  let mapping = mapHeaders(table.headers);
  let dataRows = table.rows;
  let usedHeaderRow = true;

  if (mapping.name === undefined) {
    // No header recognised: read the columns in a fixed order and treat the
    // first row as data rather than silently dropping a player.
    mapping = {};
    POSITIONAL.forEach((field, index) => {
      if (index < table.headers.length) mapping[field] = index;
    });
    dataRows = [table.headers, ...table.rows];
    usedHeaderRow = false;
  }

  const seen = new Set<string>();
  const rows: ImportRow[] = [];

  dataRows.slice(0, limit).forEach((cells, index) => {
    const at = (field: ImportField) => {
      const column = mapping[field];
      return column === undefined ? "" : (cells[column] ?? "");
    };

    const name = at("name").trim().slice(0, 30);
    const airPower = parseAmount(at("air"));
    const tankPower = parseAmount(at("tank"));
    const missilePower = parseAmount(at("missile"));
    const thp = parseAmount(at("thp"));
    const issues: string[] = [];

    // Default the main squad to whichever squad carries the most power.
    const stated = parseSquad(at("squad"));
    const strongest: ImportSquad =
      tankPower > airPower && tankPower >= missilePower
        ? "TANK"
        : missilePower > airPower && missilePower > tankPower
          ? "MISSILE"
          : "AIR";
    if (!stated && at("squad").trim()) issues.push(`Squad "${at("squad").trim()}" not recognised — using ${strongest}.`);

    let skip = false;
    if (!name) {
      issues.push("No player name in this row.");
      skip = true;
    } else if (name.length < 2) {
      issues.push("Player name is too short.");
      skip = true;
    } else if (seen.has(name.toLowerCase())) {
      issues.push("This name appears earlier in the file.");
      skip = true;
    }
    if (name) seen.add(name.toLowerCase());

    rows.push({
      line: index + (usedHeaderRow ? 2 : 1),
      name,
      rank: parseRank(at("rank")),
      mainSquad: stated ?? strongest,
      airPower,
      tankPower,
      missilePower,
      thp,
      issues,
      skip,
    });
  });

  return { sheetName: table.sheetName, headers: table.headers, mapping, usedHeaderRow, rows };
}
