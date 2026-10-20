#!/usr/bin/env node
// Module discovery (0 tokens): lists the code feature folders of a profile and ranks them against plain words.
//   node scripts/modules.mjs --find "import job"          (profile defaults to config/config.yaml)
//   node scripts/modules.mjs                              (list all)
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { ROOT, loadEnv, loadProfile } from "./lib/config.mjs";
import { ensureRepo } from "./lib/code.mjs";

/** Every folder under frontendRoot (depth ≤ 3) that directly holds source files. */
export function listModules(profile, { cacheDir, refresh = false, log = () => {} } = {}) {
  const modules = new Map();
  for (const repo of profile.code?.repos ?? []) {
    const info = ensureRepo(repo, cacheDir, { refresh, log });
    const root = path.join(info.dir, repo.frontendRoot);
    const exts = repo.frontendExtensions ?? [".ts", ".html"];
    const exclude = repo.excludePattern ? new RegExp(repo.excludePattern) : null;
    const walk = (dir, depth) => {
      if (depth > 3 || !fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files = entries.filter((e) => e.isFile() && exts.includes(path.extname(e.name)) && !(exclude && exclude.test(e.name)));
      const rel = path.relative(root, dir).split(path.sep).join("/");
      if (rel && files.length) {
        const m = modules.get(rel) ?? { path: rel, repos: [], files: 0, sample: [] };
        m.repos.push(repo.name);
        m.files += files.length;
        m.sample.push(...files.slice(0, 3).map((f) => f.name));
        modules.set(rel, m);
      }
      for (const e of entries.filter((x) => x.isDirectory())) walk(path.join(dir, e.name), depth + 1);
    };
    walk(root, 1);
  }
  for (const [name, hint] of Object.entries(profile.modules ?? {})) {
    const m = modules.get(name) ?? { path: name, repos: [], files: 0, sample: [] };
    Object.assign(m, { zephyrFolder: hint.zephyrFolder, summaryPattern: hint.summaryPattern, name: hint.name, aliases: hint.aliases ?? [] });
    modules.set(name, m);
  }
  return [...modules.values()];
}

// Singular form so "incidents"/"users" meet "incident"/"user".
const stem = (w) => (w.length > 3 ? w.replace(/ies$/, "y").replace(/(?<!s)s$/, "") : w);
const words = (s) => String(s).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(stem);

/** Score how well plain words name a module path ("import job" ~ admin/import-job). */
export function scoreModule(query, modPath) {
  const q = words(query);
  if (!q.length) return 0;
  const segs = modPath.split("/");
  const last = segs.at(-1);
  const lastWords = words(last);
  const allWords = new Set(segs.flatMap(words));
  const compactQ = q.join("");
  let score = 0;
  if (compactQ === lastWords.join("")) score += 10; // "importjob" / "import job" vs import-job
  score += q.filter((w) => lastWords.includes(w)).length * 3;
  score += q.filter((w) => allWords.has(w)).length;
  score += q.filter((w) => w.length >= 4 && [...allWords].some((a) => a.startsWith(w) || w.startsWith(a))).length * 0.5;
  // Prefer the module whose last segment is fully named over deeper/parent folders.
  if (lastWords.every((w) => q.includes(w))) score += 2;
  return score - segs.length * 0.1;
}

export function findModules(query, modules, limit = 8) {
  const q = words(query).join(" ");
  // A name or alias from modules.json is the user's own vocabulary: an exact hit wins outright.
  const named = (m) => [m.name, ...(m.aliases ?? [])].filter(Boolean).some((n) => words(n).join(" ") === q);
  return modules
    .map((m) => ({ ...m, score: +(named(m) ? 50 : Math.max(scoreModule(query, m.path), ...[m.name, ...(m.aliases ?? [])].filter(Boolean).map((n) => scoreModule(query, n) - 0.5))).toFixed(2) }))
    .filter((m) => m.score > 0.5)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values: a } = parseArgs({ options: { profile: { type: "string" }, find: { type: "string" }, json: { type: "boolean" }, refresh: { type: "boolean" } } });
  loadEnv();
  const profile = loadProfile(a.profile);
  const modules = listModules(profile, { cacheDir: path.join(ROOT, "cache", profile.name), refresh: a.refresh, log: (m) => console.error(m) });
  const list = a.find ? findModules(a.find, modules) : modules.sort((x, y) => x.path.localeCompare(y.path));
  if (a.json) {
    console.log(JSON.stringify(list, null, 2));
  } else {
    if (a.find && !list.length) console.log(`No module matches "${a.find}". Run without --find to list all ${modules.length}.`);
    for (const m of list) {
      console.log(`${a.find ? `${String(m.score).padStart(5)}  ` : ""}${m.path}${m.name ? `  = "${m.name}" in modules.json` : ""}  (${m.files} files${m.zephyrFolder ? `, Zephyr folder "${m.zephyrFolder}"` : ""})${a.find ? `  e.g. ${m.sample.slice(0, 2).join(", ")}` : ""}`);
    }
    if (a.find && list.length > 1 && list[0].score - list[1].score < 1) console.log(`\nAMBIGUOUS: "${list[0].path}" and "${list[1].path}" score almost the same.`);
  }
}
