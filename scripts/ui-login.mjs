#!/usr/bin/env node
// Saves a logged-in browser session for the ui-explorer (environment from config/config.yaml).
//   npm run ui-login                 (config.yaml `environment`)
//   npm run ui-login -- --env test
// Opens a visible browser on the environment's uiBaseUrl; log in, then close the browser window. The session is
// written to the environment's login.storageState file (under cache/, git-ignored). No password is stored.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { ROOT, loadRunConfig } from "./lib/config.mjs";
import { resolveEnvironment } from "./lib/pipeline.mjs";

const { values: a } = parseArgs({ options: { env: { type: "string" } } });
const cfg = loadRunConfig();
const env = resolveEnvironment(cfg, a.env);
if (env.login.method !== "storage-state") {
  console.log(`Environment '${env.name}' uses login method '${env.login.method}'; nothing to save.`);
  process.exit(0);
}
const file = path.resolve(ROOT, env.login.storageState);
fs.mkdirSync(path.dirname(file), { recursive: true });
// The storage-state file format is stable across Playwright releases, so codegen's version need not match the MCP's.
const pkg = "playwright@1.63.0";
console.log(`Opening ${env.uiBaseUrl}. Log in, then close the browser window. The session goes to ${path.relative(ROOT, file)}.`);
const r = spawnSync("npx", ["-y", pkg, "codegen", "--save-storage", file, env.uiBaseUrl], { stdio: "inherit", shell: process.platform === "win32" });
if (r.status !== 0 || !fs.existsSync(file)) {
  console.error("No session saved. If the browser did not open, run once: npx playwright install chromium");
  process.exit(1);
}
console.log(`Saved. The ui-explorer will use it for environment '${env.name}'.`);
