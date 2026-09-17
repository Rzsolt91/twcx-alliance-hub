import type { Account } from "../auth.js";
import { canManage, requireManage } from "../auth.js";
import { query, queryOne } from "../db.js";
import { HttpError, integer, ok, oneOf, text } from "../http.js";
import type { RouteTable } from "../router.js";
import { deleteUpload, fetchUpload, readMultipart } from "../uploads.js";

/** Matches the category check constraint on `strategy_images`. */
export const LIBRARY_CATEGORIES = ["EVENT", "VS", "SITE", "EXCEL"] as const;

/** GET /api/library?category= — war plans, spreadsheets and site imagery. */
async function list(account: Account, url: URL) {
  const filter = url.searchParams.get("category");
  const category = filter ? oneOf(filter, LIBRARY_CATEGORIES, "Category") : null;

  const rows = await query(
    `SELECT i.id, i.category, i.event_id, i.title, i.description, i.mime_type, i.file_name, i.size_bytes,
            i.created_at, u.player_name AS author
     FROM strategy_images i
     LEFT JOIN users u ON u.id = i.uploaded_by
     WHERE ($1::text IS NULL OR i.category = $1)
     ORDER BY i.created_at DESC
     LIMIT 200`,
    [category],
  );

  return ok({
    canManage: canManage(account),
    files: rows.map((row) => ({
      id: row.id,
      category: row.category,
      eventId: row.event_id,
      title: row.title,
      description: row.description,
      mimeType: row.mime_type,
      fileName: row.file_name,
      sizeBytes: Number(row.size_bytes),
      isImage: String(row.mime_type).startsWith("image/"),
      author: row.author,
      createdAt: row.created_at,
    })),
  });
}

/** POST /api/library — R4/Master upload a plan, spreadsheet or site image. */
async function upload(account: Account, req: Request) {
  requireManage(account);
  const { fields, file } = await readMultipart(req, "file", "sheet");
  if (!file) throw new HttpError("Choose a file to upload.", 422);

  const category = oneOf(fields.category ?? "EVENT", LIBRARY_CATEGORIES, "Category");
  const title = text(fields.title, "Title", { max: 140 }) || file.fileName;
  const description = text(fields.description, "Description", { max: 1000 });
  const eventId = fields.eventId ? integer(fields.eventId, "Event id", { min: 1 }) : null;

  if (category === "EXCEL" && file.mimeType.startsWith("image/")) {
    throw new HttpError("Upload a spreadsheet file for the spreadsheet library.", 415);
  }

  const created = await query<{ id: number }>(
    `INSERT INTO strategy_images
       (category, event_id, title, description, blob_key, mime_type, file_name, size_bytes, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      category,
      eventId,
      title,
      description,
      file.key,
      file.mimeType,
      file.fileName,
      file.sizeBytes,
      account.id,
    ],
  );
  return ok({ id: created[0].id });
}

/** DELETE /api/library?id= */
async function remove(account: Account, url: URL) {
  requireManage(account);
  const id = integer(url.searchParams.get("id"), "File id", { min: 1 });

  const file = await queryOne<{ blob_key: string }>("SELECT blob_key FROM strategy_images WHERE id = $1", [id]);
  if (!file) throw new HttpError("File not found.", 404);

  // Detach references first so the row can go without breaking foreign keys.
  await query("UPDATE site_content SET image_id = NULL WHERE image_id = $1", [id]);
  await query("UPDATE vs_weeks SET strategy_image_id = NULL WHERE strategy_image_id = $1", [id]);
  await query("DELETE FROM strategy_images WHERE id = $1", [id]);
  await deleteUpload(file.blob_key);

  return ok({ id });
}

function serve(bytes: Uint8Array, mimeType: string, fileName: string, download: boolean) {
  const disposition = download
    ? `attachment; filename="${fileName.replace(/[^\w.\-]+/g, "_")}"`
    : "inline";
  return new Response(bytes as unknown as BodyInit, {
    headers: {
      "content-type": mimeType,
      "content-disposition": disposition,
      // Blob contents never change for a given id, but the row can be deleted.
      "cache-control": "private, max-age=300",
    },
  });
}

/** GET /api/library/file?id= — stream an uploaded file to a signed-in member. */
async function download(_account: Account, url: URL) {
  const id = integer(url.searchParams.get("id"), "File id", { min: 1 });
  const row = await queryOne<{ blob_key: string; mime_type: string; file_name: string }>(
    "SELECT blob_key, mime_type, file_name FROM strategy_images WHERE id = $1",
    [id],
  );
  if (!row) throw new HttpError("File not found.", 404);

  const bytes = await fetchUpload(row.blob_key);
  if (!bytes) throw new HttpError("File contents are no longer available.", 404);

  const asDownload = !row.mime_type.startsWith("image/") || url.searchParams.get("download") === "1";
  return serve(bytes, row.mime_type, row.file_name || `file-${id}`, asDownload);
}

/** GET /api/library/post?id= — stream a community post image. */
async function postImage(_account: Account, url: URL) {
  const id = integer(url.searchParams.get("id"), "Post id", { min: 1 });
  const row = await queryOne<{ blob_key: string | null; mime_type: string | null; title: string }>(
    "SELECT blob_key, mime_type, title FROM community_posts WHERE id = $1 AND active = TRUE",
    [id],
  );
  if (!row?.blob_key) throw new HttpError("Image not found.", 404);

  const bytes = await fetchUpload(row.blob_key);
  if (!bytes) throw new HttpError("Image contents are no longer available.", 404);

  return serve(bytes, row.mime_type ?? "application/octet-stream", row.title, false);
}

export const libraryRoutes: RouteTable = {
  "GET library": ({ account, url }) => list(account, url),
  "POST library": ({ account, req }) => upload(account, req),
  "DELETE library": ({ account, url }) => remove(account, url),
  "GET library/file": ({ account, url }) => download(account, url),
  "GET library/post": ({ account, url }) => postImage(account, url),
};
