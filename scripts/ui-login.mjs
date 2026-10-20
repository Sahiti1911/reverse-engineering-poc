#!/usr/bin/env node
// Saves a logged-in browser session for the ui-explorer (environment from config/config.yaml).
//   npm run ui-login                 (config.yaml `environment`)
//   npm run ui-login -- --env test [--headed]
// With login.credentials, it logs in by script: the username and password are read from that .env file into
// memory only (never printed, never written anywhere). Without credentials it opens a browser and you log in.
// Either way only the session (cookies, storage) is saved, to login.storageState under cache/ (git-ignored),
// and then checked by opening the app with it. agents.mjs re-runs the scripted login itself when the session
// has expired, so this is only needed once, or when there are no credentials.
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT, loadRunConfig } from "./lib/config.mjs";
import { resolveEnvironment } from "./lib/pipeline.mjs";
import { login } from "./lib/ui-session.mjs";

const { values: a } = parseArgs({ options: { env: { type: "string" }, headed: { type: "boolean" } } });
const env = resolveEnvironment(loadRunConfig(), a.env);
if (env.login.method !== "storage-state") {
  console.log(`Environment '${env.name}' uses login method '${env.login.method}'; nothing to save.`);
  process.exit(0);
}
const file = await login(env, { headed: a.headed });
console.log(`Saved and checked: ${path.relative(ROOT, file)} (session only, no password). The ui-explorer will use it for '${env.name}'.`);
