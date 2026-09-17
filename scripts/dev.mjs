/**
 * Local hub: embedded Postgres + API + static files. No Netlify link, no push.
 *
 *   npm install
 *   npm run dev
 *
 * Then open http://127.0.0.1:8888
 * First email registration becomes Master and must finish onboarding.
 * After that, accounts need an invite link (`/#/join?invite=CODE`).
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NetlifyDB } from "@netlify/database-dev";
import { buildFrontend, bundleApi, bundleReminders } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const port = Number(process.env.PORT || 8888);
const origin = `http://127.0.0.1:${port}`;

process.env.TWCX_LOCAL = "1";
process.env.NETLIFY_DEV = "true";
process.chdir(root);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".map": "application/json",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
};

function log(message) {
  console.log(`[hub] ${message}`);
}

async function loadEnvFile(filePath) {
  let text;
  try {
    text = await readFile(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function ensureEmailKeys() {
  const names = ["EMAIL_ENCRYPTION_KEY", "EMAIL_HMAC_KEY"];
  const missing = names.filter((name) => !String(process.env[name] ?? "").trim());
  if (!missing.length) return;
  const generated = {};
  for (const name of missing) generated[name] = randomBytes(32).toString("hex");
  Object.assign(process.env, generated);
  const localEnv = join(root, ".env.local");
  const block = `\n# generated ${new Date().toISOString()}\n${missing
    .map((name) => `${name}=${generated[name]}`)
    .join("\n")}\n`;
  await appendFile(localEnv, block, "utf8");
  log(`wrote ${missing.join(", ")} to .env.local (not committed)`);
}

async function startDatabase() {
  await mkdir(join(root, ".netlify", "local-db"), { recursive: true });
  const db = new NetlifyDB({
    directory: join(root, ".netlify", "local-db"),
    port: Number(process.env.TWCX_DB_PORT || 55432),
    logger: (...message) => console.log("[db]", ...message),
  });
  const connectionString = await db.start();
  return { db, connectionString };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function toFetchRequest(req) {
  const url = new URL(req.url || "/", origin);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value == null) continue;
    if (key === "connection" || key === "transfer-encoding" || key === "content-length") continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : String(value));
  }
  const method = req.method || "GET";
  /** @type {RequestInit} */
  const init = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = await readBody(req);
    init.duplex = "half";
  }
  return new Request(url, init);
}

async function sendFetchResponse(res, response) {
  res.statusCode = response.status;
  const cookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  for (const [key, value] of response.headers) {
    if (key.toLowerCase() === "set-cookie") continue;
    res.setHeader(key, value);
  }
  if (cookies.length) res.setHeader("set-cookie", cookies);
  const bytes = Buffer.from(await response.arrayBuffer());
  res.end(bytes);
}

function safeFile(requestPath) {
  const decoded = decodeURIComponent((requestPath || "/").split("?")[0]);
  const target = normalize(join(dist, decoded === "/" ? "index.html" : decoded));
  const rel = relative(dist, target);
  if (!rel || rel.startsWith("..") || rel.startsWith(`..${sep}`)) return null;
  return target;
}

async function serveStatic(res, filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader("content-type", MIME[extname(filePath).toLowerCase()] || "application/octet-stream");
    res.setHeader("cache-control", "no-store");
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

async function loadApiHandler() {
  await bundleApi();
  const href = `${pathToFileURL(join(root, ".netlify", "local", "api.mjs")).href}?t=${Date.now()}`;
  const mod = await import(href);
  return mod.default;
}

async function main() {
  await loadEnvFile(join(root, ".env"));
  await loadEnvFile(join(root, ".env.local"));
  await ensureEmailKeys();

  log("starting local database");
  const { db, connectionString } = await startDatabase();
  process.env.NETLIFY_DB_URL = connectionString;
  process.env.DATABASE_URL = connectionString;

  log("applying migrations");
  const applied = await db.applyMigrations(join(root, "netlify", "database", "migrations"));
  if (applied.length) log(`applied ${applied.join(", ")}`);
  else log("migrations already applied");

  log("building frontend");
  const watch = process.argv.includes("--watch");
  await buildFrontend({ watch });

  const handler = await loadApiHandler();
  await bundleReminders();
  const remindersHref = `${pathToFileURL(join(root, ".netlify", "local", "discord-reminders.mjs")).href}?t=${Date.now()}`;
  const reminders = await import(remindersHref);

  /** Node cannot sleep longer than ~24 days in one timeout. */
  const MAX_TIMER_MS = 2_147_000_000;
  let reminderTimer = null;

  const armReminder = async () => {
    if (reminderTimer) {
      clearTimeout(reminderTimer);
      reminderTimer = null;
    }
    if (!String(process.env.DISCORD_BOT_TOKEN ?? "").trim()) {
      log("discord reminders idle (no DISCORD_BOT_TOKEN)");
      return;
    }
    let wait = MAX_TIMER_MS;
    try {
      const next = await reminders.msUntilNextReminder();
      wait = next === null ? MAX_TIMER_MS : Math.max(0, Math.min(next, MAX_TIMER_MS));
    } catch (error) {
      console.warn("[hub] could not arm discord reminder", error instanceof Error ? error.message : error);
      wait = 30 * 60_000;
    }
    const when = wait === 0 ? "now" : `in ${Math.round(wait / 1000)}s (T-5 of next storm)`;
    log(`discord reminder ${when}`);
    reminderTimer = setTimeout(async () => {
      try {
        await reminders.default();
      } catch (error) {
        console.warn("[hub] discord reminder pass failed", error instanceof Error ? error.message : error);
      }
      await armReminder();
    }, wait);
    reminderTimer.unref?.();
  };

  await armReminder();

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", origin);
      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        await sendFetchResponse(res, await handler(await toFetchRequest(req)));
        return;
      }
      const file = safeFile(url.pathname);
      if (file && (await serveStatic(res, file))) return;
      if (await serveStatic(res, join(dist, "index.html"))) return;
      res.statusCode = 404;
      res.end("Not found");
    } catch (error) {
      console.error(error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Local server failed handling that request." }));
      }
    }
  });

  const shutdown = async () => {
    log("shutting down");
    if (reminderTimer) clearTimeout(reminderTimer);
    server.close();
    await db.stop().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(port, "127.0.0.1", () => {
    log(`ready at ${origin}`);
    log("invite-only after the first account — Administration → Invite links");
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
