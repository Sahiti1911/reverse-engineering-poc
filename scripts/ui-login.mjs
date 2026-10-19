#!/usr/bin/env node
// Saves a logged-in browser session for the ui-explorer (environment from config/config.yaml).
//   npm run ui-login                 (config.yaml `environment`)
//   npm run ui-login -- --env test [--headed]
// With login.credentials, it logs in by script: the username and password are read from that .env file into
// memory only (never printed, never written anywhere). Without credentials it opens a browser and you log in.
// Either way only the session (cookies, storage) is saved, to login.storageState under cache/ (git-ignored),
// and then checked by opening the app with it.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import dotenv from "dotenv";
import { chromium, firefox, webkit } from "playwright-core";
import { ROOT, loadRunConfig } from "./lib/config.mjs";
import { resolveEnvironment } from "./lib/pipeline.mjs";

const { values: a } = parseArgs({ options: { env: { type: "string" }, headed: { type: "boolean" } } });
const cfg = loadRunConfig();
const env = resolveEnvironment(cfg, a.env);
const login = env.login;
if (login.method !== "storage-state") {
  console.log(`Environment '${env.name}' uses login method '${login.method}'; nothing to save.`);
  process.exit(0);
}
const file = path.resolve(ROOT, login.storageState);
fs.mkdirSync(path.dirname(file), { recursive: true });

function launcher() {
  const b = env.browser ?? "chromium";
  if (b === "firefox") return { type: firefox, opts: {} };
  if (b === "webkit") return { type: webkit, opts: {} };
  return { type: chromium, opts: ["chrome", "msedge"].includes(b) ? { channel: b } : {} };
}

/** Username and password from the configured .env file, or null. */
function credentials() {
  const c = login.credentials;
  if (!c?.envFile) return null;
  const envFile = path.resolve(ROOT, c.envFile);
  if (!fs.existsSync(envFile)) throw new Error(`login.credentials.envFile not found: ${c.envFile}`);
  const vars = dotenv.parse(fs.readFileSync(envFile));
  const user = vars[c.userVar ?? "TEST_USERNAME"];
  const password = vars[c.passwordVar ?? "TEST_PASSWORD"];
  if (!user || !password) throw new Error(`${c.envFile} has no ${c.userVar} / ${c.passwordVar}.`);
  return { user, password };
}

const form = { username: "Username", password: "Password", submit: "Log in", ...login.form };
const { type, opts } = launcher();
const creds = credentials();
const browser = await type.launch({ ...opts, headless: creds ? !a.headed : false });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(env.uiBaseUrl, { waitUntil: "domcontentloaded" });
  const userBox = page.getByRole("textbox", { name: form.username });
  if (creds) {
    console.log(`Logging in to ${env.uiBaseUrl} as the user from ${login.credentials.envFile}…`);
    await userBox.fill(creds.user, { timeout: 60_000 });
    await page.getByRole("textbox", { name: form.password }).fill(creds.password);
    await page.getByRole("button", { name: form.submit }).click();
    await userBox.waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {
      throw new Error("Still on the login form after 90 s: wrong credentials, or the form labels in login.form changed.");
    });
  } else {
    console.log(`Log in to ${env.uiBaseUrl} in the browser window. Waiting up to 5 minutes…`);
    await userBox.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
    await userBox.waitFor({ state: "hidden", timeout: 300_000 });
  }
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await context.storageState({ path: file });
  await context.close();

  // Check: a fresh context with only the saved session must not see the login form.
  const check = await browser.newContext({ storageState: file });
  const p2 = await check.newPage();
  await p2.goto(env.uiBaseUrl, { waitUntil: "domcontentloaded" });
  await p2.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  const stillLogin = await p2.getByRole("textbox", { name: form.password }).isVisible().catch(() => false);
  await check.close();
  if (stillLogin) throw new Error("The saved session does not keep you logged in (login form shown again).");
  console.log(`Saved and checked: ${path.relative(ROOT, file)} (session only, no password). The ui-explorer will use it for '${env.name}'.`);
} finally {
  await browser.close();
}
