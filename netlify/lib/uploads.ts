import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getStore } from "@netlify/blobs";
import { HttpError } from "./http.js";

const STORE = "twcx-uploads";
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];
const SHEET_TYPES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "text/csv",
  // Browsers label spreadsheets inconsistently; the parser is the real check.
  "text/plain",
  "text/tab-separated-values",
  "application/octet-stream",
  "",
];

export type UploadKind = "image" | "sheet";

export type StoredUpload = {
  key: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
};

export type MultipartRequest = {
  /** Every non-file field, as plain strings. */
  fields: Record<string, string>;
  /** The stored file, or null when the form carried no file. */
  file: StoredUpload | null;
};

/**
 * Reads a multipart upload in one pass — a request body can only be consumed
 * once, so fields and the file have to come out together.
 *
 * The file is validated and written to Netlify Blobs; the caller records the
 * returned key in Postgres.
 */
export async function readMultipart(req: Request, fileField: string, kind: UploadKind): Promise<MultipartRequest> {
  const form = await req.formData().catch(() => null);
  if (!form) throw new HttpError("Expected a multipart form upload.", 400);

  const fields: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (typeof value === "string") fields[name] = value;
  }

  const candidate = form.get(fileField);
  if (!(candidate instanceof File) || candidate.size === 0) return { fields, file: null };

  const allowed = kind === "image" ? IMAGE_TYPES : [...SHEET_TYPES, ...IMAGE_TYPES];
  const mimeType = candidate.type || "application/octet-stream";
  if (!allowed.includes(mimeType)) {
    throw new HttpError(
      kind === "image"
        ? "Upload a PNG, JPEG, WebP, GIF or AVIF image."
        : "Upload a spreadsheet (.xlsx, .xls, .csv) or an image.",
      415,
    );
  }
  if (candidate.size > MAX_UPLOAD_BYTES) throw new HttpError("Files must stay under 5 MB.", 413);

  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const bytes = new Uint8Array(await candidate.arrayBuffer());
  await putUpload(key, bytes, mimeType, String(candidate.name || "upload"));

  return {
    fields,
    file: {
      key,
      mimeType,
      fileName: String(candidate.name || "upload").slice(0, 160),
      sizeBytes: candidate.size,
    },
  };
}

export async function fetchUpload(key: string) {
  if (useLocalFiles()) return readLocal(key);
  try {
    const blob = await getStore(STORE).get(key, { type: "arrayBuffer" });
    return blob ? new Uint8Array(blob) : null;
  } catch {
    return readLocal(key);
  }
}

export async function deleteUpload(key: string) {
  if (useLocalFiles()) {
    await deleteLocal(key);
    return;
  }
  try {
    await getStore(STORE).delete(key);
  } catch {
    await deleteLocal(key);
  }
}

function useLocalFiles() {
  return process.env.TWCX_LOCAL === "1";
}

function localDir() {
  return join(process.cwd(), ".netlify", "local-blobs", STORE);
}

async function putUpload(key: string, bytes: Uint8Array, mimeType: string, fileName: string) {
  if (useLocalFiles()) {
    await writeLocal(key, bytes, mimeType, fileName);
    return;
  }
  try {
    await getStore(STORE).set(key, bytes, { metadata: { contentType: mimeType, fileName } });
  } catch (error) {
    if (!process.env.NETLIFY_DEV) throw error;
    await writeLocal(key, bytes, mimeType, fileName);
  }
}

async function writeLocal(key: string, bytes: Uint8Array, mimeType: string, fileName: string) {
  const dir = localDir();
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, key), bytes);
  await writeFile(join(dir, `${key}.meta.json`), JSON.stringify({ mimeType, fileName }));
}

async function readLocal(key: string) {
  try {
    const buf = await readFile(join(localDir(), key));
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

async function deleteLocal(key: string) {
  const dir = localDir();
  await unlink(join(dir, key)).catch(() => {});
  await unlink(join(dir, `${key}.meta.json`)).catch(() => {});
}
