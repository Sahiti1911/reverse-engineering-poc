// Code provider "git": a sparse, blobless, depth-1 clone of only the profile's code roots, using the
// machine's existing git credentials. Reading code this way costs 0 tokens; only the extracted,
// size-capped module files are sent to the LLM.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseSource, buildIndex, moduleTokens, nameMatches, discoverImplementation, digestSource, usageSnippet, packWithinBudget, sweepKeywords, mentionSnippet } from "./discover.mjs";

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const refreshed = new Map();

/** Every code root of a repo profile: what is cloned and what discovery may follow references into. */
export function codeRoots(repo) {
  return [...new Set([repo.frontendRoot, ...(repo.backendRoots ?? []), ...(repo.legacyRoots ?? []), ...(repo.searchRoots ?? [])].filter(Boolean))];
}

export function ensureRepo(repo, cacheDir, { refresh = true, log = () => {} } = {}) {
  const dir = path.join(cacheDir, "repos", repo.name);
  if (refreshed.has(dir)) return refreshed.get(dir);
  const roots = codeRoots(repo);
  if (!fs.existsSync(path.join(dir, ".git"))) {
    log(`Code: cloning ${repo.cloneUrl} (${repo.ref}, sparse: ${roots.join(", ")})…`);
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    git(path.dirname(dir), ["clone", "--filter=blob:none", "--no-checkout", "--depth", "1", "--branch", repo.ref, repo.cloneUrl, repo.name]);
    git(dir, ["sparse-checkout", "set", "--cone", ...roots]);
    git(dir, ["checkout", repo.ref]);
  } else if (refresh) {
    log(`Code: updating ${repo.name} to latest ${repo.ref}…`);
    git(dir, ["fetch", "--depth", "1", "--filter=blob:none", "origin", repo.ref]);
    git(dir, ["sparse-checkout", "set", "--cone", ...roots]);
    git(dir, ["reset", "--hard", "FETCH_HEAD"]);
  } else {
    // A profile that gained roots must widen the checkout even when not refreshing.
    // Cone mode lists only the outermost folders, so a root inside a listed folder is already checked out.
    const current = git(dir, ["sparse-checkout", "list"]).split("\n").map((s) => s.trim()).filter(Boolean);
    if (roots.some((r) => !current.some((c) => r === c || r.startsWith(c + "/")))) {
      log(`Code: widening ${repo.name} checkout to ${roots.join(", ")}…`);
      git(dir, ["sparse-checkout", "set", "--cone", ...roots]);
    }
  }
  const info = { dir, commit: git(dir, ["rev-parse", "HEAD"]) };
  refreshed.set(dir, info);
  return info;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  if (fs.statSync(dir).isFile()) return [...out, dir];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Drop import/package lines and blank runs: they cost tokens and carry no behaviour. */
export function compactSource(text) {
  return text
    .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
    .replace(/^\s*package\s+[\w.]+;\s*$/gm, "")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const SOURCE_EXT = new Set([".ts", ".java", ".js"]);
const parsedIndexCache = new Map();

/** Parse every source file under the repo's code roots once per process (0 tokens). */
function sourceIndex(repoDir, repo, rel) {
  const key = repoDir + "|" + codeRoots(repo).join(",");
  if (!parsedIndexCache.has(key)) {
    const exclude = repo.excludePattern ? new RegExp(repo.excludePattern) : null;
    const parsed = new Map();
    for (const root of codeRoots(repo)) {
      for (const file of walk(path.join(repoDir, root))) {
        const p = rel(file);
        if (parsed.has(p) || !SOURCE_EXT.has(path.extname(file)) || (exclude && exclude.test(file))) continue;
        if (/\/(test|tests|node_modules|dist|vendor|bower_components)\//.test(p) || /\.min\.js$/.test(p)) continue;
        parsed.set(p, parseSource(p, fs.readFileSync(file, "utf8")));
      }
    }
    parsedIndexCache.set(key, buildIndex([...parsed.values()]));
  }
  return parsedIndexCache.get(key);
}

const SWEEP_EXT = new Set([".ts", ".html", ".java", ".js"]);
const sweepCache = new Map();

/** Every code and template file under the repo's code roots, read once per process, for the keyword sweep. */
function sweepFiles(repoDir, repo, rel) {
  const key = repoDir + "|" + codeRoots(repo).join(",");
  if (!sweepCache.has(key)) {
    const exclude = repo.excludePattern ? new RegExp(repo.excludePattern) : null;
    const files = new Map();
    for (const root of codeRoots(repo)) {
      for (const file of walk(path.join(repoDir, root))) {
        const p = rel(file);
        if (files.has(p) || !SWEEP_EXT.has(path.extname(file)) || (exclude && exclude.test(file))) continue;
        if (/\/(test|tests|node_modules|dist|vendor|bower_components)\//.test(p) || /\.min\.js$/.test(p)) continue;
        files.set(p, { path: p, content: fs.readFileSync(file, "utf8") });
      }
    }
    sweepCache.set(key, [...files.values()]);
  }
  return sweepCache.get(key);
}

/** Everything the keyword triangulation needs from one repo: its code/template files and every declared type name. */
/** Every code and template file of a repo as { path, content } (read once per process). */
export function codeFiles(repo, repoInfo) {
  return sweepFiles(repoInfo.dir, repo, (f) => path.relative(repoInfo.dir, f).split(path.sep).join("/"));
}

export function codeVocabulary(repo, repoInfo) {
  const rel = (f) => path.relative(repoInfo.dir, f).split(path.sep).join("/");
  return { files: sweepFiles(repoInfo.dir, repo, rel), declared: [...sourceIndex(repoInfo.dir, repo, rel).declaredBy.keys()] };
}

/** Pseudo path of the implementation map; not a repo file, so never valid as evidence. */
export const MAP_PATH = "(implementation map)";
// Docs and the module first, then the engine (core named after the module), variant samples, callers (usage
// lines only: which screens trigger the module and how), other variants, helpers, the legacy copy of the page.
// Keyword files (found by the sweep, outside the module folder) come right after the module; mentions (lines
// naming the keywords in code nothing else led to) right before the callers.
const ROLE_PRIORITY = { doc: 1, module: 2, keyword: 2.5, core: 3, mention: 4.6, caller: 4.8, variant: 6, helper: 6.5, legacy: 6.6 };

/**
 * Collect the implementation of one module: its own frontend files (plus the legacy folder of the same name
 * and docs kept next to them), then everything discovery finds by following references (see discover.mjs),
 * packed into limits.codeBytesPerModule. The first file is a map of every discovered file and why it is
 * related. Returns repo-relative paths so evidence links can be built.
 */
export function collectModuleCode({ repo, repoInfo, featurePath, codePaths = [], keywords = [], limits, discovery = {}, hints = [] }) {
  const notes = [];
  const rel = (f) => path.relative(repoInfo.dir, f).split(path.sep).join("/");
  const featureDir = path.join(repoInfo.dir, repo.frontendRoot, featurePath);
  const extraDirs = codePaths.map((p) => path.join(repoInfo.dir, p)).filter((p) => fs.existsSync(p));
  for (const p of codePaths) if (!fs.existsSync(path.join(repoInfo.dir, p))) notes.push(`Code path ${p} (modules.json codePaths) not found at ${repoInfo.commit.slice(0, 8)}`);
  // Keyword sweep: the module's words across every code root, for features without (only) a folder of their own.
  const sweepConf = discovery.keywordSweep ?? {};
  const sweep = keywords.length && sweepConf.enabled !== false ? sweepKeywords(sweepFiles(repoInfo.dir, repo, rel), keywords, sweepConf) : null;
  if (sweep) {
    notes.push(`Keyword sweep (${keywords.join(", ")}): ${sweep.seeds.length} file(s) declare a matching type, ${sweep.mentions.length + sweep.moreMentions} mention one`
      + (sweep.generic.length ? `; too generic to seed: ${sweep.generic.map((g) => `"${g.phrase}" (${g.strong} files)`).join(", ")}` : ""));
  }
  if (!fs.existsSync(featureDir) && !extraDirs.length && !sweep?.seeds.length) {
    return { files: [], bytes: 0, truncated: false, notes: [...notes, `Feature folder ${repo.frontendRoot}/${featurePath} not found at ${repoInfo.commit.slice(0, 8)}${keywords.length ? " and the keyword sweep found no declaring file" : ""}`] };
  }
  const exts = repo.frontendExtensions ?? [".ts", ".html"];
  const exclude = repo.excludePattern ? new RegExp(repo.excludePattern) : null;
  const ownDirs = [{ dir: featureDir, role: "module" }, ...extraDirs.map((dir) => ({ dir, role: "module" })), ...(repo.legacyRoots ?? []).map((r) => ({ dir: path.join(repoInfo.dir, r, featurePath), role: "legacy" }))];
  const own = [];
  for (const { dir, role } of ownDirs) {
    for (const f of [...new Set(walk(dir))]) {
      if (own.some((o) => o.path === rel(f))) continue;
      if (exclude && exclude.test(f)) continue;
      if (path.extname(f) === ".md") own.push({ path: rel(f), role: "doc" });
      else if (exts.includes(path.extname(f)) || (role === "legacy" && path.extname(f) === ".js")) own.push({ path: rel(f), role });
    }
  }
  const raw = (p) => fs.readFileSync(path.join(repoInfo.dir, p), "utf8");
  const legacyPath = (p) => (repo.legacyRoots ?? []).some((r) => p.startsWith(r + "/"));

  const index = sourceIndex(repoInfo.dir, repo, rel);
  const links = [];
  for (const link of repo.backendLinks ?? []) {
    const rx = new RegExp(link.frontendPattern, "g");
    const names = new Map();
    for (const o of own.filter((x) => x.role === "module")) for (const m of raw(o.path).matchAll(rx)) names.set(link.backendFile.replace("$1", m[1]), `backend link from ${path.basename(o.path)} (${m[0]})`);
    for (const [name, via] of names) {
      const hits = [...index.byPath.keys()].filter((p) => p.endsWith("/" + name));
      if (!hits.length) notes.push(`Backend file ${name} referenced by the frontend was not found`);
      for (const h of hits) links.push({ path: h, via });
    }
  }
  const seeds = own.filter((o) => o.role !== "doc").map((o) => o.path);
  const isOwn = new Set(own.map((o) => o.path));
  const keywordSeeds = (sweep?.seeds ?? []).filter((k) => !isOwn.has(k.path)).map((k) => ({ path: k.path, via: `keyword sweep: declares ${k.phrases.map((p) => `"${p}"`).join(", ")}` }));
  const found = discoverImplementation(index, { ...discovery, seeds: [...seeds, ...keywordSeeds], links, tokens: moduleTokens(featurePath, discovery.extraTokens ?? []) });
  const keywordPaths = new Set(keywordSeeds.map((k) => k.path));

  // Variant families: a few full samples (named in the stories first, then the largest), digests for the rest.
  const hintWords = hints.join(" ").toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  // Variants the engine calls by name (a dispatcher) come first, then those named in the stories, then the largest.
  const sampleScore = (p) => (found.get(p).via.includes("used by") ? 2e9 : 0) + (nameMatches(path.basename(p, path.extname(p)), hintWords) ? 1e9 : 0) + raw(p).length;
  const variants = [...found].filter(([, v]) => v.role === "variant").map(([p]) => p);
  const samples = new Set(variants.sort((a, b) => sampleScore(b) - sampleScore(a)).slice(0, discovery.variantSamples ?? 4));
  const coreNames = [...found].filter(([, v]) => v.role === "core" || v.role === "module").flatMap(([p]) => index.byPath.get(p).declares);

  const items = own.filter((o) => o.role === "doc").map((o) => {
    const text = raw(o.path);
    return { path: o.path, role: "doc", priority: ROLE_PRIORITY.doc, full: text.length > 20000 ? text.slice(0, 20000) + "\n…[truncated]" : text, via: "doc kept in the module folder" };
  });
  for (const o of own.filter((x) => x.role !== "doc" && !found.has(x.path))) {
    items.push({ path: o.path, role: o.role, priority: ROLE_PRIORITY[o.role], full: compactSource(raw(o.path)), via: "module folder" });
  }
  // Templates are not in the reference index, so discovery never returns them: add keyword templates directly.
  for (const k of keywordSeeds.filter((x) => !found.has(x.path))) {
    items.push({ path: k.path, role: "keyword", priority: ROLE_PRIORITY.keyword, full: compactSource(raw(k.path)), small: digestSource(compactSource(raw(k.path))), via: k.via });
  }
  for (const [p, v] of found) {
    const role = v.role === "module" && own.find((o) => o.path === p)?.role === "legacy" ? "legacy" : v.role;
    if (role === "caller") items.push({ path: p, role, priority: legacyPath(p) ? ROLE_PRIORITY.helper + 0.2 : ROLE_PRIORITY.caller, full: null, small: usageSnippet(raw(p), coreNames, { max: 350 }), via: v.via });
    else if (keywordPaths.has(p)) items.push({ path: p, role: "keyword", priority: ROLE_PRIORITY.keyword, full: compactSource(raw(p)), small: digestSource(compactSource(raw(p))), via: v.via });
    else if (role === "module" || role === "legacy") items.push({ path: p, role, priority: ROLE_PRIORITY[role], full: compactSource(raw(p)), via: v.via });
    else if (role === "core" && !v.named) items.push({ path: p, role: "helper", priority: ROLE_PRIORITY.helper + v.depth / 100, full: null, small: digestSource(compactSource(raw(p)), 1500), via: v.via });
    else {
      const full = compactSource(raw(p));
      const sample = samples.has(p);
      const priority = role === "core" ? ROLE_PRIORITY.core + v.depth / 10 : sample ? ROLE_PRIORITY.core + 1 : ROLE_PRIORITY.variant;
      // Non-sample variants stay digests: per-variant columns and overrides matter, their shared plumbing does not.
      if (role === "variant" && !sample) items.push({ path: p, role, priority, full: null, small: digestSource(full, 1000), via: v.via });
      else items.push({ path: p, role, priority, full, small: digestSource(full), via: v.via });
    }
  }

  for (const m of (sweep?.mentions ?? []).filter((x) => !found.has(x.path) && !isOwn.has(x.path))) {
    const small = mentionSnippet(raw(m.path), m.phrases);
    if (small) items.push({ path: m.path, role: "mention", priority: ROLE_PRIORITY.mention + 0.1 / (1 + m.count), full: null, small, via: `keyword sweep: mentions ${m.phrases.map((p) => `"${p}"`).join(", ")} (${m.count}×)` });
  }

  const budget = limits.codeBytesPerModule;
  const mapBudget = Math.min(30000, Math.floor(budget / 8));
  const pack = packWithinBudget(items, budget - mapBudget);
  const counts = {};
  for (const f of pack.files) counts[f.role] = (counts[f.role] ?? 0) + 1;
  let map = `Implementation map of ${featurePath}. Roles: doc = documentation kept with the code; module/legacy = the module's own files; `
    + `core = code named after the module that it uses or that uses it (the engine); helper = other code the module uses (digest only); variant = subclasses of a core type (full source for samples, digest for the rest); `
    + `caller = other code that invokes the module (usage lines only); keyword = found by the keyword sweep because it declares a type named by the keywords (full source); mention = other code naming the keywords (those lines only). Forms: full source, or digest (declarations, signatures, lines with literals).\n`
    + (sweep ? `Keyword sweep over all code roots for: ${keywords.join(", ")}${sweep.generic.length ? `. Too generic to seed (listed as mentions only): ${sweep.generic.map((g) => g.phrase).join(", ")}` : ""}${sweep.moreMentions ? `. ${sweep.moreMentions} weaker mention(s) not listed` : ""}
` : "")
    + (pack.dropped.length ? `Left out for budget (${pack.dropped.length}): ${pack.dropped.slice(0, 30).map((p) => path.basename(p)).join(", ")}${pack.dropped.length > 30 ? ", …" : ""}\n` : "")
    + pack.files.map((f) => `${f.role.padEnd(7)} ${f.form.padEnd(6)} ${f.path} — ${f.via}`).join("\n");
  if (map.length > mapBudget) map = map.slice(0, mapBudget) + "\n…[map truncated]";
  notes.push(`Discovered ${found.size} related files: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(", ")}${pack.dropped.length ? `; ${pack.dropped.length} left out for budget` : ""}`);
  const files = [{ path: MAP_PATH, role: "map", content: map, form: "full", via: "" }, ...pack.files];
  return { files, bytes: pack.used + map.length, truncated: pack.dropped.length > 0, notes, counts };
}

export function codeUrl(repo, commit, filePath) {
  return repo.browseUrl ? repo.browseUrl.replace("{commit}", commit).replace("{path}", filePath) : null;
}
