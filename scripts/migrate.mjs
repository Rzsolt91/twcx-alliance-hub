/**
 * Apply SQL files under netlify/database/migrations to DATABASE_URL.
 * Used once when pointing a new Supabase project at this schema.
 *
 *   DATABASE_URL=... node scripts/migrate.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadEnvFile } from "./load-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "netlify", "database", "migrations");

await loadEnvFile(join(root, ".env"));
await loadEnvFile(join(root, ".env.local"));

const url = String(
  process.env.NETLIFY_DB_URL || process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "",
).trim();
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const useSsl =
  process.env.DATABASE_SSL === "1" ||
  (process.env.DATABASE_SSL !== "0" && (url.includes("supabase") || url.includes("sslmode=require")));
const ssl = useSsl ? { rejectUnauthorized: false } : undefined;

const client = new pg.Client({ connectionString: url, ssl });
await client.connect();

try {
  await client.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())",
  );

  const names = (await readdir(migrationsDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    const already = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", [name]);
    if (already.rowCount) {
      console.log(`skip ${name}`);
      continue;
    }
    const sql = await readFile(join(migrationsDir, name, "migration.sql"), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [name]);
      await client.query("COMMIT");
      console.log(`applied ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
