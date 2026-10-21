// Confluence pages as a requirements source (0 tokens): the same Atlassian site and token as Jira, under /wiki.
// Pages are found by title on the module's keywords and by links from the in-scope stories (description links
// and Jira remote links). Release notes and similar pages are kept as change history only. Cached per page.
import fs from "node:fs";
import path from "node:path";
import { htmlToText, readJson, writeJson, truncate } from "./util.mjs";

/** Page ids linked from a text: /wiki/spaces/X/pages/<id>/… and ?pageId=<id>. */
export function pageIdsFromText(text) {
  const ids = new Set();
  for (const m of String(text ?? "").matchAll(/\/wiki\/spaces\/[^/\s"']+\/pages\/(\d+)/g)) ids.add(m[1]);
  for (const m of String(text ?? "").matchAll(/[?&]pageId=(\d+)/g)) ids.add(m[1]);
  return [...ids];
}

/**
 * Words most keyword phrases share ("export" in "grid export", "csv export", "export to excel"): page titles
 * use the plain word ("Exports", "Export Job Config") far more often than a full phrase.
 */
export function sharedWords(keywords) {
  const phrases = keywords.map((k) => k.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
  const counts = new Map();
  for (const ws of phrases) for (const w of new Set(ws)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts].filter(([, n]) => phrases.length >= 2 && n >= Math.ceil(phrases.length / 2)).map(([w]) => w);
}

/** CQL for pages whose title matches any keyword, optionally limited to spaces. */
export function titleCql(keywords, spaces = []) {
  const q = (s) => `"${String(s).replace(/["\\]/g, " ").trim()}"`;
  const titles = [...new Set(keywords.map((k) => k.trim()).filter(Boolean))].map((k) => `title ~ ${q(k)}`);
  if (!titles.length) return null;
  const space = spaces.length ? ` AND space in (${spaces.map(q).join(", ")})` : "";
  return `type = page AND (${titles.join(" OR ")})${space}`;
}

/** "excluded" | "change-history" | "requirement" for a page title under the profile's confluence settings. */
export function classifyPage(title, conf = {}) {
  if ((conf.titleExclude ?? []).some((p) => new RegExp(p, "i").test(title))) return "excluded";
  if (conf.changeHistoryPattern && new RegExp(conf.changeHistoryPattern, "i").test(title)) return "change-history";
  return "requirement";
}

/**
 * Gather the Confluence pages of one module. `jira` is the Jira client (its get() reaches /wiki on the same site).
 * Returns { pages: [{ id, title, space, url, kind, foundBy, text }], cql, notes }.
 */
export async function gatherConfluence({ jira, conf = {}, keywords = [], stories = [], cacheDir, maxAgeHours = 24, log = () => {} }) {
  const notes = [];
  const found = new Map(); // id → foundBy[]
  const add = (id, by) => found.set(String(id), [...new Set([...(found.get(String(id)) ?? []), by])]);
  const cql = titleCql([...keywords, ...sharedWords(keywords)], conf.spaces ?? []);
  if (cql) {
    try {
      const res = await jira.get(`/wiki/rest/api/search?limit=50&cql=${encodeURIComponent(cql)}`);
      for (const r of res.results ?? []) if (r.content?.id) add(r.content.id, "title search");
      notes.push(`Title search found ${res.results?.length ?? 0} page(s).`);
    } catch (err) {
      notes.push(`Title search failed: ${err.message.slice(0, 200)}`);
    }
  }
  for (const s of stories) {
    for (const id of pageIdsFromText(s.descriptionHtml ?? s.descriptionText)) add(id, `linked from ${s.key}`);
    try {
      const links = await jira.get(`/rest/api/3/issue/${encodeURIComponent(s.key)}/remotelink`);
      for (const l of Array.isArray(links) ? links : []) for (const id of pageIdsFromText(l.object?.url)) add(id, `remote link on ${s.key}`);
    } catch (err) {
      notes.push(`Remote links of ${s.key} not read: ${err.message.slice(0, 120)}`);
    }
  }
  const maxPages = conf.maxPages ?? 25;
  const pages = [];
  for (const [id, foundBy] of found) {
    const page = await getPage({ jira, id, cacheDir, maxAgeHours }).catch((err) => {
      notes.push(`Page ${id} not read: ${err.message.slice(0, 120)}`);
      return null;
    });
    if (!page) continue;
    const kind = classifyPage(page.title, conf);
    if (kind === "excluded") continue;
    pages.push({ ...page, kind, foundBy, text: kind === "requirement" ? truncate(page.text, conf.maxCharsPerPage ?? 20000) : "" });
  }
  // Linked pages first (the stories point at them), then title hits; requirements before change history.
  const rank = (p) => (p.kind === "requirement" ? 0 : 2) + (p.foundBy.some((b) => b !== "title search") ? 0 : 1);
  pages.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
  if (pages.length > maxPages) notes.push(`${pages.length - maxPages} page(s) over confluence.maxPages (${maxPages}) not read: ${pages.slice(maxPages).map((p) => p.title).join(", ").slice(0, 300)}`);
  log(`Confluence: ${pages.length} page(s) (${pages.filter((p) => p.kind === "requirement").length} requirement, ${pages.filter((p) => p.kind === "change-history").length} change history)`);
  return { pages: pages.slice(0, maxPages), cql, notes };
}

/** One page as text, cached under cache/<profile>/confluence/<id>.json. */
async function getPage({ jira, id, cacheDir, maxAgeHours }) {
  const file = path.join(cacheDir, "confluence", `${id}.json`);
  if (fs.existsSync(file) && (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000 < maxAgeHours) return readJson(file);
  const p = await jira.get(`/wiki/rest/api/content/${encodeURIComponent(id)}?expand=body.storage,space,version`);
  const base = (p._links?.base ?? "").replace(/\/+$/, "");
  const page = {
    id: String(p.id), title: p.title ?? "", space: p.space?.key ?? "", version: p.version?.number ?? null,
    url: p._links?.webui ? `${base}${p._links.webui}` : null, text: htmlToText(p.body?.storage?.value ?? ""),
  };
  writeJson(file, page);
  return page;
}
