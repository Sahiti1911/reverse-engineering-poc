#!/usr/bin/env node
// UI sweep on its own (0 tokens): open every page of the app's navigation, trigger the module's feature and
// record the request each page sends (always aborted, never reaches the server).
//   node scripts/ui-sweep.mjs --module "grid export" [--env test] [--max-pages 20] [--routes "#/a,#/b"] [--out <dir>] [--headed]
// The map stage runs the same sweep inside an agent run (into <run>/ui/).
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT, loadProfile, loadRunConfig, resolveModule } from "./lib/config.mjs";
import { resolveEnvironment } from "./lib/pipeline.mjs";
import { ensureSession } from "./lib/ui-session.mjs";
import { runSweep } from "./lib/ui-sweep.mjs";
import { slug } from "./lib/util.mjs";

const { values: a } = parseArgs({
  options: { profile: { type: "string" }, module: { type: "string" }, env: { type: "string" }, "max-pages": { type: "string" }, routes: { type: "string" }, out: { type: "string" }, headed: { type: "boolean" }, help: { type: "boolean", short: "h" } },
});
const cfg = loadRunConfig();
a.module ??= cfg.defaultModule;
if (a.help || !a.module) {
  console.log('Usage: node scripts/ui-sweep.mjs --module "<module>" [--env <name>] [--max-pages n] [--out <dir>] [--headed]');
  process.exit(a.help ? 0 : 2);
}
const profile = loadProfile(a.profile);
const mod = resolveModule(profile, a.module);
if (!mod?.surfaces?.ui) throw new Error(`Module "${a.module}" has no surfaces.ui block in profiles/${profile.name}/modules.json.`);
const env = resolveEnvironment(cfg, a.env);
const session = await ensureSession(env);
if (!session.ok) throw new Error(`Saved login for '${env.name}' is not valid (${session.problem}). Run: npm run ui-login -- --env ${env.name}`);
const opts = cfg.agents["ui-explorer"] ?? {};
const outDir = path.resolve(a.out ?? path.join(ROOT, "runs", profile.name, "ui-sweep", slug(a.module)));
const res = await runSweep({
  env, ui: mod.surfaces.ui, outDir, extraRoutes: (mod.uiRoutes ?? []).map((r) => (r.startsWith("#") ? r : `#${r}`)), onlyRoutes: a.routes ? a.routes.split(",").map((r) => r.trim()) : null,
  opts: { ...opts, headless: a.headed ? false : opts.headless, sweep: { ...(opts.sweep ?? {}), ...(a["max-pages"] ? { maxPages: Number(a["max-pages"]) } : {}) } },
});
const withTrigger = res.pages.filter((p) => p.trigger);
const ids = [...new Set(res.pages.flatMap((p) => p.requests.map((q) => q.id)))];
console.log(`\n${res.pages.length} page(s) swept; ${withTrigger.length} with the trigger; ${ids.length} distinct request id(s): ${ids.join(", ")}`);
for (const n of res.notes) console.log(`- ${n}`);
console.log(`Result: ${path.join(outDir, "sweep.json")}`);
