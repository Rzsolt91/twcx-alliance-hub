/**
 * Reads a roster spreadsheet into a table of strings.
 *
 * `.xlsx` is a ZIP of XML parts, so it can be unpacked with the runtime's own
 * inflate — no spreadsheet dependency is pulled in. `.csv` (and the tab or
 * semicolon separated exports Excel produces in some locales) is read
 * directly. Legacy binary `.xls` is rejected with an actionable message.
 */

import { inflateRawSync } from "node:zlib";
import { HttpError } from "./http.js";

export type SheetTable = {
  sheetName: string;
  /** First row of the sheet, trimmed. May be data when the file has no header. */
  headers: string[];
  /** Every row after the header, padded to the header width. */
  rows: string[][];
};

export const MAX_SHEET_ROWS = 1000;
const MAX_COLUMNS = 40;

/* ------------------------------------------------------------------- zip --- */

type ZipEntry = { name: string; method: number; offset: number; compressedSize: number };

function readZipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);

  // The end-of-central-directory record sits in the last 64 KB of the file.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 66_000);
  for (let at = bytes.length - 22; at >= floor; at -= 1) {
    if (u32(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new HttpError("That file is not a readable .xlsx workbook.", 415);

  const count = u16(eocd + 10);
  let cursor = u32(eocd + 16);
  const entries = new Map<string, ZipEntry>();

  for (let index = 0; index < count && cursor + 46 <= bytes.length; index += 1) {
    if (u32(cursor) !== 0x02014b50) break;
    const method = u16(cursor + 10);
    const compressedSize = u32(cursor + 20);
    const nameLength = u16(cursor + 28);
    const extraLength = u16(cursor + 30);
    const commentLength = u16(cursor + 32);
    const offset = u32(cursor + 42);
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    entries.set(name, { name, method, offset, compressedSize });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipFile(bytes: Uint8Array, entry: ZipEntry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(entry.offset, true) !== 0x04034b50) {
    throw new HttpError("That .xlsx workbook is damaged.", 415);
  }
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return new TextDecoder().decode(raw);
  if (entry.method !== 8) throw new HttpError("That .xlsx workbook uses an unsupported compression.", 415);
  try {
    return new TextDecoder().decode(inflateRawSync(raw));
  } catch {
    throw new HttpError("That .xlsx workbook could not be unpacked.", 415);
  }
}

/* ------------------------------------------------------------------- xml --- */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeXml(value: string) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16) || 0);
    }
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10) || 0);
    return ENTITIES[body] ?? match;
  });
}

/** Walks every `<name …>…</name>` (and `<name … />`) at any depth. */
function* elements(xml: string, name: string) {
  const opener = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, "g");
  const closer = `</${name}>`;
  let match: RegExpExecArray | null;

  while ((match = opener.exec(xml))) {
    const attrs = match[1] ?? "";
    if (match[2] === "/") {
      yield { attrs, inner: "" };
      continue;
    }
    const end = xml.indexOf(closer, opener.lastIndex);
    yield { attrs, inner: end === -1 ? xml.slice(opener.lastIndex) : xml.slice(opener.lastIndex, end) };
    if (end === -1) break;
    opener.lastIndex = end + closer.length;
  }
}

function attribute(attrs: string, name: string) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs);
  return match ? match[1] : "";
}

/** Joins every `<t>` in an element — rich text arrives as several runs. */
function textOf(inner: string) {
  let out = "";
  for (const node of elements(inner, "t")) out += decodeXml(node.inner);
  return out;
}

function columnIndex(reference: string) {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase());
  if (!letters) return -1;
  let index = 0;
  for (const letter of letters[1]) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

/* ----------------------------------------------------------------- xlsx --- */

/** The first sheet in workbook order, falling back to the lowest sheet file. */
function firstSheetPath(bytes: Uint8Array, entries: Map<string, ZipEntry>) {
  const workbook = entries.get("xl/workbook.xml");
  const rels = entries.get("xl/_rels/workbook.xml.rels");

  if (workbook && rels) {
    const targets = new Map<string, string>();
    for (const relationship of elements(readZipFile(bytes, rels), "Relationship")) {
      targets.set(attribute(relationship.attrs, "Id"), attribute(relationship.attrs, "Target"));
    }

    for (const sheet of elements(readZipFile(bytes, workbook), "sheet")) {
      const target = targets.get(attribute(sheet.attrs, "r:id") || attribute(sheet.attrs, "id"));
      if (!target) continue;
      const path = target.replace(/^\/?(xl\/)?/, "xl/");
      if (entries.has(path)) return { path, name: decodeXml(attribute(sheet.attrs, "name")) || "Sheet1" };
    }
  }

  const fallback = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }))[0];
  if (!fallback) throw new HttpError("That workbook has no worksheets.", 422);
  return { path: fallback, name: "Sheet1" };
}

function parseXlsx(bytes: Uint8Array): SheetTable {
  const entries = readZipEntries(bytes);

  const shared: string[] = [];
  const sharedEntry = entries.get("xl/sharedStrings.xml");
  if (sharedEntry) {
    for (const item of elements(readZipFile(bytes, sharedEntry), "si")) shared.push(textOf(item.inner));
  }

  const sheet = firstSheetPath(bytes, entries);
  const sheetXml = readZipFile(bytes, entries.get(sheet.path)!);

  const grid: string[][] = [];
  for (const row of elements(sheetXml, "row")) {
    if (grid.length > MAX_SHEET_ROWS + 1) break;
    const cells: string[] = [];

    for (const cell of elements(row.inner, "c")) {
      const at = columnIndex(attribute(cell.attrs, "r"));
      const index = at >= 0 ? at : cells.length;
      if (index >= MAX_COLUMNS) continue;
      while (cells.length < index) cells.push("");

      const type = attribute(cell.attrs, "t");
      let value = "";
      if (type === "inlineStr") {
        value = textOf(cell.inner);
      } else {
        const decoded = decodeXml([...elements(cell.inner, "v")][0]?.inner ?? "");
        if (type === "s") value = shared[Number(decoded)] ?? "";
        else if (type === "b") value = decoded === "1" ? "TRUE" : "FALSE";
        else if (type === "e") value = "";
        else value = decoded;
      }
      cells[index] = value.trim();
    }
    grid.push(cells);
  }

  return toTable(grid, sheet.name);
}

/* ------------------------------------------------------------------ csv --- */

function sniffDelimiter(sample: string) {
  const counts = [",", ";", "\t"].map((candidate) => ({
    candidate,
    // Count only outside quotes, so a quoted "Smith, John" does not win.
    score: sample.replace(/"[^"]*"/g, "").split(candidate).length - 1,
  }));
  counts.sort((left, right) => right.score - left.score);
  return counts[0].score > 0 ? counts[0].candidate : ",";
}

export function parseDelimitedText(content: string): SheetTable {
  const text = content.replace(/^﻿/, "");
  const delimiter = sniffDelimiter(text.slice(0, 4000));

  const grid: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    if (row.length < MAX_COLUMNS) row.push(cell.trim());
    cell = "";
  };
  const endRow = () => {
    endCell();
    grid.push(row);
    row = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) endCell();
    else if (char === "\n") endRow();
    else if (char === "\r") continue;
    else cell += char;

    if (grid.length > MAX_SHEET_ROWS + 1) break;
  }
  if (cell || row.length) endRow();

  return toTable(grid, "CSV");
}

/* ---------------------------------------------------------------- shared --- */

function toTable(grid: string[][], sheetName: string): SheetTable {
  const filled = grid.filter((row) => row.some((cell) => cell !== ""));
  if (!filled.length) throw new HttpError("That file has no rows in it.", 422);

  const width = Math.min(MAX_COLUMNS, Math.max(...filled.map((row) => row.length)));
  const [headers, ...rest] = filled.map((row) =>
    Array.from({ length: width }, (_, index) => row[index] ?? ""),
  );
  return { sheetName, headers, rows: rest.slice(0, MAX_SHEET_ROWS) };
}

/** Reads an uploaded spreadsheet, choosing the reader by signature. */
export function parseSpreadsheet(bytes: Uint8Array, fileName: string): SheetTable {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const isOle = bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

  if (isOle) {
    throw new HttpError(
      "That is a legacy .xls workbook. Open it in Excel and save as .xlsx or .csv, then upload again.",
      415,
    );
  }
  if (isZip) return parseXlsx(bytes);
  if (/\.(csv|txt|tsv)$/i.test(fileName) || !bytes.includes(0)) {
    return parseDelimitedText(new TextDecoder().decode(bytes));
  }

  throw new HttpError("Upload an .xlsx workbook or a .csv export.", 415);
}
