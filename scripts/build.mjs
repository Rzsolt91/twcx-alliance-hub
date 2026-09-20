import * as esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const staticDir = join(root, "src", "static");

async function copyStatic() {
  await mkdir(dist, { recursive: true });
  await Promise.all([
    cp(join(staticDir, "index.html"), join(dist, "index.html")),
    cp(join(staticDir, "styles.css"), join(dist, "styles.css")),
    cp(join(staticDir, "twcx-interface.png"), join(dist, "twcx-interface.png")),
  ]);
}

export async function buildFrontend({ watch = false } = {}) {
  await copyStatic();
  const options = {
    absWorkingDir: root,
    entryPoints: ["src/app.js"],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: !watch,
    outfile: "dist/app.js",
    logLevel: "info",
  };
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    return ctx;
  }
  await esbuild.build(options);
}

export async function bundleApi() {
  await mkdir(join(root, ".netlify", "local"), { recursive: true });
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["netlify/functions/api.mts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: ".netlify/local/api.mjs",
    packages: "external",
    sourcemap: true,
    logLevel: "info",
  });
}

export async function bundleReminders() {
  await mkdir(join(root, ".netlify", "local"), { recursive: true });
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: ["scripts/reminders-entry.mts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: ".netlify/local/discord-reminders.mjs",
    packages: "external",
    sourcemap: true,
    logLevel: "silent",
  });
}

const invokedDirectly = process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/build.mjs");
if (invokedDirectly) {
  const watch = process.argv.includes("--watch");
  await buildFrontend({ watch });
  if (!watch) console.log("frontend build ok");
}
