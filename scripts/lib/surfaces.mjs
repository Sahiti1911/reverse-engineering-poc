// Surfaces of a cross-cutting feature: each separate implementation of it (e.g. one grid's export). The
// feature's own registry in the code (modules.json `surfaces.idSource`, e.g. a backend enum) lists them; the
// name each one has there is the join key across layers: the backend, the legacy frontend, the new frontend,
// the request the UI sends, Confluence pages, stories and Zephyr cases. Pure: no I/O, unit-tested.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const hasPhrase = (text, phrase) => !!phrase && ` ${text} `.includes(` ${phrase} `);
const uniq = (a) => [...new Set(a)];

/** Every surface in the registry file: [{ name, id }] in file order (id = group 2, the number the UI sends). */
export function parseIdSource(text, pattern) {
  const out = new Map();
  for (const m of String(text).matchAll(new RegExp(pattern, "g"))) {
    if (!out.has(m[1])) out.set(m[1], { name: m[1], id: m[2] ?? null });
  }
  return [...out.values()];
}

/** ADMIN_UNIT_EXPORT → "Admin unit" (labelDrop: ["EXPORT"]). */
export function surfaceLabel(name, drop = []) {
  const kept = name.split("_").filter((w) => w && !drop.includes(w.toUpperCase()));
  const s = (kept.length ? kept : name.split("_")).join(" ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Which layer a repo-relative file belongs to: backend (Java), legacy (legacyRoots), frontend, or other. */
export function classifyLayer(filePath, repo = {}) {
  if (filePath.endsWith(".java")) return "backend";
  if ((repo.legacyRoots ?? []).some((r) => filePath.startsWith(r.replace(/\/+$/, "") + "/"))) return "legacy";
  if (/\.(ts|html|js)$/.test(filePath)) return "frontend";
  return "other";
}

/**
 * Files that name each surface: Map name → [{ path, line }]. One pass over the files with one regex.
 * `exclude` = paths that name every surface by construction (the registry itself).
 */
export function findSurfaceFiles(files, names, { exclude = [] } = {}) {
  const found = new Map(names.map((n) => [n, []]));
  if (!names.length) return found;
  const rx = new RegExp(`\\b(${[...names].sort((a, b) => b.length - a.length).map(esc).join("|")})\\b`, "g");
  for (const f of files) {
    if (exclude.includes(f.path)) continue;
    const seen = new Set();
    for (const m of f.content.matchAll(rx)) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      found.get(m[1]).push({ path: f.path, line: f.content.slice(0, m.index).split("\n").length });
    }
  }
  return found;
}

/**
 * Follow a dispatcher: in the `case NAME:` branch of a switch, the fields it calls (`exportAdminUnitHandler.process(…)`)
 * name the classes that implement the surface. Returns the class names (ExportAdminUnitHandler), in order.
 */
export function dispatchTargets(content, name) {
  const m = String(content).match(new RegExp(`case\\s+(?:[\\w.]+\\.)?${esc(name)}\\s*:([\\s\\S]*?)(?=\\bcase\\s+[\\w.]+\\s*:|\\bdefault\\s*:|\\n\\s*}\\s*\\n)`));
  if (!m) return [];
  return uniq([...m[1].matchAll(/\b([a-z][A-Za-z0-9]*)\s*\.\s*[a-z]\w*\s*\(/g)].map((x) => x[1].charAt(0).toUpperCase() + x[1].slice(1)));
}

/**
 * Add the implementing classes a dispatcher branch calls to each surface's files (see dispatchTargets).
 * `byBase` = Map basename-without-extension → repo paths.
 */
export function followDispatch(found, files, byBase) {
  const content = new Map(files.map((f) => [f.path, f.content]));
  for (const [name, hits] of found) {
    for (const h of [...hits]) {
      for (const cls of dispatchTargets(content.get(h.path) ?? "", name)) {
        for (const p of byBase.get(cls) ?? []) if (!hits.some((x) => x.path === p)) hits.push({ path: p, line: 1, via: `called for ${name} in ${h.path.split("/").pop()}` });
      }
    }
  }
  return found;
}

/** The first notThis pattern a text matches, or null. */
export function notThisMatch(text, notThis = []) {
  return notThis.find((p) => new RegExp(p, "i").test(String(text ?? ""))) ?? null;
}

/**
 * Phrases that name a surface in prose (case names, stories, Confluence): its label when it has 2+ words,
 * the page titles the UI showed, and the surface name itself. One-word labels ("Event") are too generic.
 */
export function surfaceAliases(surface) {
  const label = words(surface.label);
  return uniq([
    words(surface.name),
    ...(label.split(" ").length >= 2 ? [label] : []),
    ...(surface.ui ?? []).map((u) => words(u.title)).filter((t) => t.length >= 4),
    ...(surface.aliases ?? []).map(words),
  ].filter(Boolean));
}

/** The surface a text is about: the one whose longest alias it contains (ties: none). */
export function surfaceOfText(text, surfaces) {
  const t = words(text);
  let best = null;
  let bestLen = 0;
  let tie = false;
  for (const s of surfaces) {
    for (const a of surfaceAliases(s)) {
      if (!hasPhrase(t, a)) continue;
      if (a.length > bestLen) { best = s; bestLen = a.length; tie = false; }
      else if (a.length === bestLen && best !== s) tie = true;
    }
  }
  return tie ? null : best;
}

/**
 * Join everything gathered about the feature into one feature map.
 *   registry:   [{ name, id }] from parseIdSource
 *   files:      Map name → [{ path, line }] from findSurfaceFiles
 *   repo:       the repo profile (for classifyLayer)
 *   ui:         UI sweep pages [{ route, title, trigger, requests: [{ id }], columnsMatch, problem }], or null when not swept
 *   confluence: [{ id, title, text, kind: "requirement" | "change-history" }]
 *   stories:    [{ key, text, featurePath }]
 *   cases:      [{ key, name, objective, folderPath }] (the module's Zephyr pool)
 * Returns { surfaces, shared, notThis, unmatchedUi }; every surface carries a reasoning string.
 */
export function joinSurfaces({ registry, files, repo = {}, ui = null, confluence = [], stories = [], cases = [], labelDrop = [], notThis = [] }) {
  const out = { surfaces: [], shared: { cases: [], confluence: [] }, notThis: { surfaces: [], cases: [], confluence: [] }, unmatchedUi: [] };
  const surfaces = [];
  for (const r of registry) {
    const code = { backend: [], legacy: [], frontend: [] };
    for (const f of files.get(r.name) ?? []) {
      const layer = classifyLayer(f.path, repo);
      if (code[layer]) code[layer].push(f.path);
    }
    const s = { name: r.name, id: r.id, label: surfaceLabel(r.name, labelDrop), code, ui: [], confluence: [], stories: [], cases: [] };
    const reason = notThisMatch(r.name.replace(/_/g, " "), notThis);
    if (reason) out.notThis.surfaces.push({ name: r.name, reasoning: `Name matches notThis pattern /${reason}/.` });
    else surfaces.push(s);
  }
  const byId = new Map(surfaces.filter((s) => s.id != null).map((s) => [String(s.id), s]));

  if (ui) {
    for (const p of ui) {
      const ids = uniq((p.requests ?? []).map((q) => String(q.id)).filter((x) => x && x !== "undefined"));
      if (!ids.length) {
        if (p.trigger) out.unmatchedUi.push({ route: p.route, title: p.title, reasoning: p.problem || "Trigger found but no feature request was captured." });
        continue;
      }
      for (const id of ids) {
        const s = byId.get(id);
        if (s) s.ui.push({ route: p.route, title: p.title, columnsMatch: p.columnsMatch ?? null, problem: p.problem ?? "" });
        else out.unmatchedUi.push({ route: p.route, title: p.title, reasoning: `Request id ${id} is not in the registry.` });
      }
    }
  }

  for (const st of stories) {
    const fp = st.featurePath ? `/${st.featurePath.replace(/^\/+|\/+$/g, "")}/` : null;
    const byPath = fp ? surfaces.filter((s) => [...s.code.frontend, ...s.code.legacy].some((p) => p.includes(fp))) : [];
    const hits = byPath.length ? byPath : [surfaceOfText(`${st.summary ?? ""} ${st.text ?? ""}`, surfaces)].filter(Boolean);
    for (const s of hits) s.stories.push(st.key);
  }

  for (const page of confluence) {
    const reason = notThisMatch(page.title, notThis);
    if (reason) { out.notThis.confluence.push({ id: page.id, title: page.title, reasoning: `Title matches notThis pattern /${reason}/.` }); continue; }
    const text = `${page.title} ${page.text ?? ""}`;
    const hits = surfaces.filter((s) => text.includes(s.name) || surfaceAliases(s).some((a) => a.includes(" ") && hasPhrase(words(text), a)));
    if (!hits.length) out.shared.confluence.push(page.id);
    for (const s of hits) s.confluence.push(page.id);
  }

  for (const c of cases) {
    const reason = notThisMatch(`${c.name} ${c.folderPath ?? ""}`, notThis);
    if (reason) { out.notThis.cases.push({ key: c.key, reasoning: `Name or folder matches notThis pattern /${reason}/.` }); continue; }
    const s = surfaceOfText(`${c.name} ${c.objective ?? ""}`, surfaces);
    if (s) s.cases.push(c.key);
    else out.shared.cases.push(c.key);
  }

  for (const s of surfaces) {
    s.missing = [
      ...["backend", "legacy", "frontend"].filter((l) => !s.code[l].length).map((l) => `code:${l}`),
      ...(ui && !s.ui.length ? ["ui"] : []),
      ...(!s.cases.length ? ["zephyr"] : []),
    ];
    s.status = s.missing.length ? `missing: ${s.missing.join(", ")}` : "complete";
    const list = (a, n = 3) => (a.length ? a.slice(0, n).map((p) => p.split("/").pop()).join(", ") + (a.length > n ? ` (+${a.length - n})` : "") : "none");
    s.reasoning = [
      `Registry ${s.name}${s.id != null ? ` (id ${s.id})` : ""}.`,
      `Backend: ${list(s.code.backend)}; legacy UI: ${list(s.code.legacy)}; new UI: ${list(s.code.frontend)}.`,
      ui ? (s.ui.length ? `UI sweep: ${s.ui.map((u) => `${u.title || u.route} sent id ${s.id}${u.columnsMatch === false ? " (exported columns differ from the grid)" : ""}`).join("; ")}.` : "UI sweep: no page sent this id.") : "UI not swept.",
      `Zephyr: ${s.cases.length} case(s); stories: ${s.stories.join(", ") || "none"}; Confluence: ${s.confluence.length} page(s).`,
    ].join(" ");
  }
  out.surfaces = surfaces;
  return out;
}
