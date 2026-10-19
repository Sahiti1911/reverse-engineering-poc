// Implementation discovery (0 tokens): starting from a module's own files, find the code that actually
// implements it by following references — what it uses, what extends it, who calls it — instead of by file
// name (names over-match: "Export" also hits unrelated GTFS export code). Pure: works on {path, content}.

// Comments and string literals removed before reading identifiers; strings kept as "" so code shape survives.
const NOISE = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g;
const GENERIC_TOKENS = new Set(["admin", "page", "pages", "list", "view", "views", "detail", "details", "dialog", "dialogs", "common", "shared", "base", "core", "main", "feature", "features", "module", "modules", "component", "components", "service", "services", "overview", "settings", "logs"]);

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
const dirName = (p) => p.slice(0, p.lastIndexOf("/"));

/** Declared type names, parent types (extends/implements) and referenced type names of one source file. */
export function parseSource(filePath, content) {
  const code = content.replace(NOISE, (m) => (m[0] === "/" ? " " : '""'));
  const declares = new Set();
  for (const m of code.matchAll(/\b(?:class|interface|enum|record|type)\s+([A-Z]\w*)/g)) declares.add(m[1]);
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|function)\s+([A-Z]\w*)/g)) declares.add(m[1]);
  // AngularJS registers by string name: .service('ExportJobService', …)
  for (const m of content.matchAll(/\.(?:service|factory|controller|component|directive|provider)\(\s*['"]([A-Z][\w$]*)['"]/g)) declares.add(m[1]);
  const parents = new Set();
  for (const m of code.matchAll(/\b(?:class|interface)\s+[A-Z]\w*\s*(?:<[^{]*?>)?\s*((?:extends|implements)\s[^{]*)\{/g)) {
    let clause = m[1];
    while (/<[^<>]*>/.test(clause)) clause = clause.replace(/<[^<>]*>/g, "");
    for (const n of clause.matchAll(/\b([A-Z]\w*)\b/g)) parents.add(n[1]);
  }
  const refs = new Set();
  for (const m of code.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) if (!declares.has(m[0])) refs.add(m[0]);
  return { path: filePath, declares: [...declares], parents: [...parents], refs: [...refs] };
}

/** Lookup tables over parsed files: who declares a name, who references it (and from how many folders), who extends it. */
export function buildIndex(parsed) {
  const byPath = new Map(parsed.map((p) => [p.path, p]));
  const declaredBy = new Map();
  const referrers = new Map();
  const children = new Map();
  const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
  for (const p of parsed) {
    for (const n of p.declares) push(declaredBy, n, p.path);
    for (const n of p.refs) push(referrers, n, p.path);
    for (const n of p.parents) push(children, n, p.path);
  }
  const spread = new Map();
  for (const [n, paths] of referrers) spread.set(n, new Set(paths.map(dirName)).size);
  return { byPath, declaredBy, referrers, children, spread };
}

/** Distinctive words of a module path ("admin/export-job" → ["export"]); generic and short words dropped. */
export function moduleTokens(featurePath, extra = []) {
  const words = [...featurePath.split(/[\/_\-\s]+/), ...extra.flatMap((e) => e.split(/[\/_\-\s]+/))];
  return [...new Set(words.map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !GENERIC_TOKENS.has(w)))];
}

export function nameMatches(name, tokens) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_\-.]+/);
  return tokens.some((t) => words.includes(t) || words.includes(t + "s"));
}

/**
 * Walk the reference graph from the module's own files.
 * - core: types the module uses (transitively, up to maxDepth) that are specific to it — referenced from at
 *   most maxSpread folders, or named after the module. Widely used helpers (date utils, base REST classes) are
 *   skipped. Files that use a core type and are named after the module are core too (e.g. the frontend service
 *   all grid pages call, or the worker that picks up a queued job).
 * - variant: subclasses of a core type (one export handler per grid); listed, not expanded.
 * - caller: other files that use a specific core type (the grid pages with an Export button); listed only.
 * Returns Map path → { role, depth, via }.
 */
export function discoverImplementation(index, { seeds, links = [], tokens = [], maxDepth = 3, maxSpread = 8, maxHits = 3, maxCallers = 80, familyMin = 3 } = {}) {
  const found = new Map();
  const queue = [];
  // Short names (Log, Id, Dto) are ambiguous across nested classes; never follow them.
  const specific = (name) => name.length >= 4 && ((index.spread.get(name) ?? 0) <= maxSpread || nameMatches(name, tokens));
  // Extension point of this module: a type named after it with familyMin+ subclasses (one export handler per
  // grid). Bases named otherwise (a websocket consumer base) are someone else's extension point.
  const familyBase = (file) => file.parents.find((n) => nameMatches(n, tokens) && (index.children.get(n)?.length ?? 0) >= familyMin);
  const add = (p, role, depth, via) => {
    if (found.has(p) || !index.byPath.has(p)) return false;
    const base = role === "core" ? familyBase(index.byPath.get(p)) : null;
    if (base) {
      found.set(p, { role: "variant", depth, via: `extends ${base}; ${via}` });
      for (const b of index.declaredBy.get(base) ?? []) add(b, "core", depth, `base of ${baseName(p)} and ${(index.children.get(base).length - 1)} other subclasses`);
      return true;
    }
    found.set(p, { role, depth, via, named: nameMatches(baseName(p), tokens) });
    if (role === "module" || role === "core") queue.push(p);
    return true;
  };
  for (const s of seeds) add(s, "module", 0, "module folder");
  for (const l of links) add(l.path, "core", 1, l.via);

  while (queue.length) {
    const p = queue.shift();
    const { depth, role, named } = found.get(p);
    // Code not named after the module is followed one hop only: beyond that it is someone else's code.
    if (depth >= maxDepth || (role === "core" && !named && depth >= 2)) continue;
    const file = index.byPath.get(p);
    for (const ref of file.refs) {
      const targets = index.declaredBy.get(ref) ?? [];
      if (!targets.length || targets.length > maxHits || !specific(ref)) continue;
      for (const t of targets) add(t, "core", depth + 1, `used by ${baseName(p)} (${ref})`);
    }
    for (const name of file.declares) {
      if (!specific(name)) continue;
      for (const r of index.referrers.get(name) ?? []) {
        if (!found.has(r) && nameMatches(baseName(r), tokens)) add(r, "core", depth + 1, `uses ${name}`);
      }
    }
  }

  const core = [...found].filter(([, v]) => v.role === "module" || v.role === "core").map(([p]) => p);
  for (const p of core) {
    for (const name of index.byPath.get(p).declares) {
      for (const c of index.children.get(name) ?? []) add(c, "variant", found.get(p).depth + 1, `extends ${name}`);
    }
  }
  let callers = 0;
  for (const p of core) {
    for (const name of index.byPath.get(p).declares) {
      if (!specific(name)) continue;
      for (const r of index.referrers.get(name) ?? []) {
        if (callers >= maxCallers) break;
        if (add(r, "caller", found.get(p).depth + 1, `uses ${name}`)) callers++;
      }
    }
  }
  return found;
}

/** Skeleton of a file: declarations, annotations, method signatures and lines carrying string literals (columns, paths, messages). */
export function digestSource(content, max = 2500) {
  const keep = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || /^(import|package)\b|^(\/\/|\/\*|\*)/.test(line) || /\blog(ger)?\.(debug|info|warn|error|trace)\(/i.test(line)) continue;
    const declaration = /\b(class|interface|enum|record)\s+[A-Z]/.test(line);
    const annotation = /^@[A-Z]\w*/.test(line);
    const signature = !/^(if|for|while|switch|return|else|catch|try|do|new)\b/.test(line)
      && (/^(?:(?:public|protected|private|static|final|abstract|async|override|readonly|synchronized|default)\s+)+[^=;]*\(/.test(line) || /^[a-z]\w*\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{$/.test(line));
    const literal = /"[^"]{2,}"|'[^']{2,}'/.test(line);
    if (declaration || annotation || signature || literal) keep.push(line);
  }
  const text = keep.join("\n");
  return text.length > max ? text.slice(0, max) + "\n…[digest truncated]" : text;
}

/**
 * How a caller invokes the module: calls through the variables it holds the module's types in (inject(X),
 * `x: X`, `X x;`) with the lines after them (the arguments), then other lines naming the types.
 */
export function usageSnippet(content, names, { after = 3, max = 400 } = {}) {
  if (!names.length) return "";
  const lines = content.replace(/^\s*import\s[\s\S]*?;\s*$/gm, "").split("\n");
  const alt = names.map((n) => n.replace(/[$]/g, "\\$")).join("|");
  const vars = new Set();
  for (const m of content.matchAll(new RegExp(`\\b(\\w+)\\s*(?:=\\s*inject\\(\\s*|:\\s*)(?:${alt})\\b`, "g"))) vars.add(m[1]);
  for (const m of content.matchAll(new RegExp(`\\b(?:${alt})\\s+(\\w+)\\s*[;=)]`, "g"))) vars.add(m[1]);
  const callRx = vars.size ? new RegExp(`\\b(${[...vars].join("|")})\\s*\\.\\s*\\w+\\s*\\(`) : null;
  const nameRx = new RegExp(`\\b(${alt})\\b`);
  const pick = [];
  const seen = new Set();
  const take = (i) => { if (!seen.has(i) && lines[i]?.trim()) { seen.add(i); pick.push(i); } };
  if (callRx) lines.forEach((l, i) => { if (callRx.test(l)) for (let j = i; j <= Math.min(lines.length - 1, i + after); j++) take(j); });
  lines.forEach((l, i) => { if (nameRx.test(l)) take(i); });
  let text = "";
  for (const i of pick) {
    const line = lines[i].trim();
    if (text.length + line.length + 1 > max) { text += "…"; break; }
    text += line + "\n";
  }
  return text.trim();
}

/**
 * Fit the discovered files into a character budget, highest priority first. An item gets its full source
 * when that still leaves room for the small forms (digest or usage snippet) of the items after it — up to
 * reserveShare of the budget — else its small form, else it is dropped. Nothing is cut mid-file.
 * Items: { path, role, priority, full, small?, via }.
 */
export function packWithinBudget(items, budget, { reserveShare = 0.35 } = {}) {
  const sorted = [...items].sort((a, b) => a.priority - b.priority);
  const smallLen = (it) => (it.small ?? it.full).length;
  let rest = sorted.reduce((n, it) => n + smallLen(it), 0);
  const files = [];
  const dropped = [];
  let used = 0;
  for (const it of sorted) {
    rest -= smallLen(it);
    const reserve = Math.min(rest, budget * reserveShare);
    let content = null;
    let form = null;
    if (it.full != null && used + it.full.length + reserve <= budget) { content = it.full; form = "full"; }
    else if (it.small != null && used + it.small.length <= budget) { content = it.small; form = it.role === "caller" ? "usage" : "digest"; }
    else if (it.small == null && it.full != null && used + it.full.length <= budget) { content = it.full; form = "full"; }
    if (content == null) { dropped.push(it.path); continue; }
    used += content.length;
    files.push({ path: it.path, role: it.role, content, form, via: it.via });
  }
  return { files, used, dropped };
}
