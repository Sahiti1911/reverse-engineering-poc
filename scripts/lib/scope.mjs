import { slug } from "./util.mjs";
import { resolveModule } from "./config.mjs";

const KINDS = ["project", "epic", "sprint", "module", "issues", "jql"];

/**
 * --scope project | epic:KEY | sprint:active | sprint:<name> | module:<name> | issues:K1,K2 | jql:<query>
 * Returns the JQL to fetch plus any local filter applied after fetching.
 */
/** "import-job" → "import job"; keywords are de-duplicated case-insensitively. */
export function normalizeKeywords(keywords, modulePath) {
  const list = (Array.isArray(keywords) ? keywords : String(keywords ?? "").split(","))
    .map((k) => String(k).trim().replace(/"/g, ""))
    .filter((k) => k.length >= 3);
  // The folder name is only a fallback: as a bare word it can be noisy (e.g. "conductor" is also a customer name).
  if (modulePath && !list.length) list.push(modulePath.split("/").pop().replace(/[-_]+/g, " "));
  const seen = new Set();
  return list.filter((k) => !seen.has(k.toLowerCase()) && seen.add(k.toLowerCase()));
}

/**
 * Candidate stories found outside the JQL text search (e.g. a Rovo semantic search run by the user's Claude
 * session): [{ key, summary?, query? }] or "K1,K2". Only keys of the profile's Jira project are kept.
 */
export function normalizeExtraStories(extra, projectKey) {
  const list = Array.isArray(extra) ? extra : String(extra ?? "").split(/[\s,]+/).filter(Boolean);
  const keyRx = new RegExp(`^${projectKey}-\\d+$`);
  const seen = new Set();
  return list
    .map((x) => (typeof x === "string" ? { key: x } : x))
    .filter((x) => keyRx.test(x.key ?? "") && !seen.has(x.key) && seen.add(x.key))
    .map((x) => ({ key: x.key, summary: x.summary ?? "", query: x.query ?? "", source: x.source ?? "rovo" }));
}

export function resolveScope(scopeArg, profile, { since, keywords, extraStories } = {}) {
  if (!scopeArg) throw new Error(`--scope is required (${KINDS.join(" | ")})`);
  const idx = scopeArg.indexOf(":");
  const kind = idx === -1 ? scopeArg : scopeArg.slice(0, idx);
  let value = idx === -1 ? "" : scopeArg.slice(idx + 1).trim();
  if (!KINDS.includes(kind)) throw new Error(`Unknown scope kind '${kind}'. Use one of: ${KINDS.join(", ")}`);
  if (kind !== "project" && !value) throw new Error(`Scope '${kind}' needs a value, e.g. ${kind}:…`);

  const { projectKey, storyTypes } = profile.jira;
  const base = `project = ${projectKey} AND issuetype in (${storyTypes.map((t) => `"${t}"`).join(", ")})`;
  let jql;
  let moduleFilter = null;
  let moduleConf = null;
  let extra = [];
  switch (kind) {
    case "project": jql = base; break;
    case "epic": jql = `${base} AND parent = ${value}`; break;
    case "sprint": jql = value === "active" ? `${base} AND sprint in openSprints()` : `${base} AND sprint = "${value.replace(/"/g, '\\"')}"`; break;
    case "module": {
      // A catalogue name or alias ("import job") resolves to its code path (admin/import-job).
      value = resolveModule(profile, value)?.path ?? value;
      moduleFilter = value;
      const conf = profile.modules?.[value] ?? {};
      const given = Array.isArray(keywords) ? keywords : String(keywords ?? "").split(",");
      const kws = normalizeKeywords([...(conf.keywords ?? []), ...given], value);
      // Text search narrows the fetch to stories that mention the module (incl. UC docs naming its path).
      jql = conf.jql ?? `${base} AND (${kws.map((k) => `text ~ "\\"${k}\\""`).join(" OR ")})`;
      if (conf.includeStories?.length) jql = `(${jql}) OR key in (${conf.includeStories.join(", ")})`;
      // Extra candidates (Rovo) are fetched too, but only when they are stories of this project.
      extra = normalizeExtraStories(extraStories, projectKey);
      if (extra.length) jql = `(${jql}) OR (key in (${extra.map((x) => x.key).join(", ")}) AND ${base})`;
      moduleConf = { name: conf.name ?? null, crossCutting: !!conf.crossCutting, includeStories: conf.includeStories ?? [], excludeStories: conf.excludeStories ?? [], notes: conf.notes ?? "" };
      keywords = kws;
      break;
    }
    case "issues": {
      const keys = value.split(/[\s,]+/).filter(Boolean);
      if (!keys.every((k) => /^[A-Z][A-Z0-9_]*-\d+$/.test(k))) throw new Error(`issues: expects Jira keys like ${projectKey}-123`);
      jql = `key in (${keys.join(", ")})`;
      break;
    }
    case "jql": jql = value; break;
  }
  if (since) jql = `(${jql}) AND updated >= "${since}"`;
  return { kind, value, jql: `${jql} ORDER BY key ASC`, moduleFilter, moduleConf, extraStories: extra, keywords: kind === "module" ? keywords : [], since: since ?? null, slug: slug(kind === "project" ? "project" : `${kind}-${value}`) + (since ? `-since-${slug(since)}` : "") };
}
