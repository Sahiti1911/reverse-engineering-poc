// Saved browser session for the ui-explorer: check it, and log in again by script when it is invalid.
// The username and password are read from the configured .env file into memory only (never printed, never
// written, never put in process.env), so agent processes cannot see them. Only the session is saved.
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { ROOT } from "./config.mjs";

export async function launch(env, headless) {
  const pw = await import("playwright-core");
  const b = env.browser ?? "chromium";
  if (b === "firefox") return pw.firefox.launch({ headless });
  if (b === "webkit") return pw.webkit.launch({ headless });
  return pw.chromium.launch({ headless, ...(["chrome", "msedge"].includes(b) ? { channel: b } : {}) });
}

/** Username and password from the environment's login.credentials .env file, or null. */
function credentials(login) {
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

const formOf = (login) => ({ username: "Username", password: "Password", submit: "Log in", ...login.form });
const storageFile = (env) => path.resolve(ROOT, env.login.storageState);

/** Opens the app with the saved session. Returns null when it is logged in, else the reason it is not. */
async function sessionProblem(env, { browser = null } = {}) {
  const file = storageFile(env);
  if (!fs.existsSync(file)) return "no saved session";
  const own = !browser;
  browser ??= await launch(env, true);
  try {
    const context = await browser.newContext({ storageState: file });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && /no user logged in/i.test(m.text())) errors.push(m.text()); });
    await page.goto(env.uiBaseUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
    const loginForm = await page.getByRole("textbox", { name: formOf(env.login).password }).isVisible().catch(() => false);
    await context.close();
    if (loginForm) return "the app shows the login form";
    if (errors.length) return "the app reports 'No user logged in'";
    return null;
  } finally {
    if (own) await browser.close();
  }
}

/**
 * Logs in and saves the session to login.storageState, then checks it. With login.credentials the login is
 * scripted (headless unless headed); without, a browser opens and the user logs in by hand.
 */
export async function login(env, { headed = false, log = console.log } = {}) {
  const file = storageFile(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const form = formOf(env.login);
  const creds = credentials(env.login);
  const browser = await launch(env, creds ? !headed : false);
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(env.uiBaseUrl, { waitUntil: "domcontentloaded" });
    const userBox = page.getByRole("textbox", { name: form.username });
    if (creds) {
      log(`Logging in to ${env.uiBaseUrl} as the user from ${env.login.credentials.envFile}…`);
      await userBox.fill(creds.user, { timeout: 60_000 });
      await page.getByRole("textbox", { name: form.password }).fill(creds.password);
      await page.getByRole("button", { name: form.submit }).click();
      await userBox.waitFor({ state: "hidden", timeout: 90_000 }).catch(() => {
        throw new Error("Still on the login form after 90 s: wrong credentials, or the form labels in login.form changed.");
      });
    } else {
      log(`Log in to ${env.uiBaseUrl} in the browser window. Waiting up to 5 minutes…`);
      await userBox.waitFor({ state: "visible", timeout: 60_000 }).catch(() => {});
      await userBox.waitFor({ state: "hidden", timeout: 300_000 });
    }
    await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
    await context.storageState({ path: file });
    await context.close();
    const problem = await sessionProblem(env, { browser });
    if (problem) throw new Error(`The saved session does not keep you logged in (${problem}).`);
    return file;
  } finally {
    await browser.close();
  }
}

/**
 * Reuses the saved session and logs in again only when it is invalid or missing. Re-login happens only by
 * script (login.credentials); without credentials the caller gets the reason and the ui-login hint.
 * Returns { ok, relogged, problem }.
 */
export async function ensureSession(env, { log = console.log } = {}) {
  if (env.login.method !== "storage-state") return { ok: true, relogged: false, problem: null };
  const problem = await sessionProblem(env);
  if (!problem) return { ok: true, relogged: false, problem: null };
  if (!env.login.credentials?.envFile) return { ok: false, relogged: false, problem };
  log(`UI: saved session for '${env.name}' is not valid (${problem}); logging in again by script…`);
  await login(env, { log: () => {} });
  return { ok: true, relogged: true, problem };
}
