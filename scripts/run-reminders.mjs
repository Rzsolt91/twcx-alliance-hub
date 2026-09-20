/**
 * One Discord reminder pass. Used by GitHub Actions (Thu/Fri) and local tests:
 *
 *   node scripts/run-reminders.mjs
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleReminders } from "./build.mjs";
import { loadEnvFile } from "./load-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await loadEnvFile(join(root, ".env"));
await loadEnvFile(join(root, ".env.local"));

if (!String(process.env.DATABASE_URL || process.env.NETLIFY_DB_URL || process.env.SUPABASE_DB_URL || "").trim()) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

await bundleReminders();
const href = `${pathToFileURL(join(root, ".netlify", "local", "discord-reminders.mjs")).href}?t=${Date.now()}`;
const reminders = await import(href);
const summary = await reminders.runReminderPass();
console.log(JSON.stringify(summary));
if (summary?.failed) process.exit(1);
