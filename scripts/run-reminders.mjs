/**
 * Discord reminder runner for GitHub Actions and local tests.
 *
 * Wakes at most once an hour. If a storm or calendar event is within ~70
 * minutes, it sleeps until T-5 then sends. Otherwise it exits immediately.
 */
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleReminders } from "./build.mjs";
import { loadEnvFile } from "./load-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** Stay under the workflow timeout; the next hourly cron picks up later events. */
const MAX_SLEEP_MS = 70 * 60 * 1000;

await loadEnvFile(join(root, ".env"));
await loadEnvFile(join(root, ".env.local"));

if (!String(process.env.DATABASE_URL || process.env.NETLIFY_DB_URL || process.env.SUPABASE_DB_URL || "").trim()) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

await bundleReminders();
const href = `${pathToFileURL(join(root, ".netlify", "local", "discord-reminders.mjs")).href}?t=${Date.now()}`;
const reminders = await import(href);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const deadline = Date.now() + MAX_SLEEP_MS;
let last = { sent: 0, failed: 0, skipped: 0, deferred: 0, idle: true };

while (Date.now() < deadline - 15_000) {
  const next = await reminders.msUntilNextReminder();
  if (next === null) {
    last = { ...last, idle: true, reason: "no upcoming events" };
    break;
  }
  if (Date.now() + next > deadline) {
    last = {
      ...last,
      idle: true,
      nextMs: next,
      nextMinutes: Math.round(next / 60_000),
    };
    break;
  }
  if (next > 2000) {
    console.log(`sleeping ${Math.round(next / 1000)}s until T-5`);
    await sleep(next);
  }
  last = await reminders.runReminderPass();
}

console.log(JSON.stringify(last));
if (last?.failed) process.exit(1);
