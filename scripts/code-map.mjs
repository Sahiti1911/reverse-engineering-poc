#!/usr/bin/env node
// Implementation map preview (0 tokens): shows which files the code stage would send for one module and why.
//   node scripts/code-map.mjs --module export-job            (profile defaults to config/run.json)
//   node scripts/code-map.mjs --module export-job --show core (print the packed content of one role)
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT, loadEnv, loadProfile, loadRunConfig, resolveModule } from "./lib/config.mjs";
import { ensureRepo, collectModuleCode } from "./lib/code.mjs";

const { values } = parseArgs({ options: { profile: { type: "string" }, module: { type: "string" }, show: { type: "string" }, refresh: { type: "boolean", default: false } } });
loadEnv();
const cfg = loadRunConfig();
const profile = loadProfile(values.profile ?? cfg.defaultProfile);
if (!values.module) { console.error("Usage: node scripts/code-map.mjs --module <feature path or module name> [--show <role>]"); process.exit(1); }
const featurePath = resolveModule(profile, values.module)?.path ?? values.module;
const cacheDir = path.join(ROOT, "cache", profile.name);

for (const repo of profile.code?.repos ?? []) {
  const info = ensureRepo(repo, cacheDir, { refresh: values.refresh, log: (m) => console.error(m) });
  const t = Date.now();
  const res = collectModuleCode({ repo, repoInfo: info, featurePath, limits: cfg.limits, discovery: cfg.code?.discovery });
  console.log(`# ${repo.name}@${info.commit.slice(0, 10)} — ${featurePath} (${Date.now() - t} ms, ${res.bytes} chars ≈ ${Math.round(res.bytes / 4)} tokens if sent)`);
  console.log(res.notes.join("\n"));
  if (!res.files.length) continue;
  console.log(res.files[0].content);
  if (values.show) for (const f of res.files.filter((x) => x.role === values.show)) console.log(`\n===== ${f.path} (${f.form}) =====\n${f.content}`);
}
