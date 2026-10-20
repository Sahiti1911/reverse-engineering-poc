// Keyword triangulation (0 tokens): turn what the user means ("grid data export") into the words the code,
// the Jira stories and the Zephyr cases actually use. Candidate phrases come from the user's words, from
// Rovo search results (stories, Confluence pages) and from type names declared in the code; each candidate is
// then counted in all three sources. A phrase found in code AND Jira AND Zephyr is a good keyword; one found
// almost everywhere is too generic. Pure functions; the counting itself happens in scripts/vocab.mjs.
import { phraseWords } from "./discover.mjs";

// Words that say nothing about a feature on their own (they still count inside a longer phrase).
const WEAK = new Set(["data", "page", "list", "view", "new", "add", "edit", "test", "story", "qa", "fix", "bug", "user", "button", "dialog", "service", "dto", "impl", "base", "helper", "util", "type", "model", "component", "handler", "config", "info", "item", "value", "all", "get", "set"]);

/** Parts of a title between separators ("Export XLSX — Historical > Drives" → 3 parts); a phrase never spans two. */
export function segments(text) {
  return String(text).split(/\s[-–—]\s|[—–:;|()[\]>/,.!?]+/).map((x) => x.trim()).filter(Boolean);
}

/** n-grams (1..maxN words) of a phrase's words, in order. */
export function ngrams(words, maxN = 3) {
  const out = [];
  for (let n = 1; n <= maxN; n++) for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(" "));
  return out;
}

/**
 * Candidate keywords: n-grams of the texts (story summaries, page titles, declared type names) that contain
 * one of the user's distinctive words, ranked by how many texts contain them. The user's own phrase is
 * always a candidate. One-word candidates only when the word is distinctive (not "data", "list", …).
 */
export function candidatePhrases(userWords, texts, { max = 20, minCount = 2, minAnchors = 3 } = {}) {
  const focus = new Set(phraseWords(userWords).filter((w) => !WEAK.has(w)));
  // Anchor on texts naming ALL the distinctive words ("grid" and "export"): one word alone drifts to other
  // features ("grid column order"). Too few such texts → any distinctive word will do.
  const anchors = texts.filter((t) => { const ws = phraseWords(t); return [...focus].every((f) => ws.includes(f)); });
  const counts = new Map();
  for (const t of anchors.length >= minAnchors ? anchors : texts) {
    const seen = new Set(segments(t).flatMap((seg) => ngrams(phraseWords(seg))).filter((g) => g.split(" ").some((w) => focus.has(w))));
    for (const g of seen) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  const own = phraseWords(userWords).join(" ");
  const ranked = [...counts]
    .filter(([g, n]) => n >= minCount && (g.includes(" ") || (!WEAK.has(g) && g.length >= 4)))
    .filter(([g]) => !g.split(" ").every((w) => WEAK.has(w)))
    .sort((a, b) => b[1] - a[1] || b[0].split(" ").length - a[0].split(" ").length || a[0].localeCompare(b[0]))
    .map(([g, n]) => ({ phrase: g, seen: n }));
  const out = own ? [{ phrase: own, seen: counts.get(own) ?? 0 }] : [];
  for (const r of ranked) if (!out.some((o) => o.phrase === r.phrase)) out.push(r);
  return out.slice(0, max);
}

/**
 * Score one counted candidate. counts: { codeDeclares, codeMentions, jira, zephyr }. A source counts as hit
 * when it has at least one match; a phrase is generic when any source is flooded.
 */
export function scoreKeyword(c, { maxCodeDeclares = 25, maxJira = 150, maxZephyr = 250 } = {}) {
  const sources = [c.codeDeclares + c.codeMentions > 0 && "code", c.jira > 0 && "jira", c.zephyr > 0 && "zephyr"].filter(Boolean);
  const flooded = [c.codeDeclares > maxCodeDeclares && `code (${c.codeDeclares} declaring files)`, c.jira > maxJira && `Jira (${c.jira} stories)`, c.zephyr > maxZephyr && `Zephyr (${c.zephyr} cases)`].filter(Boolean);
  const words = c.phrase.split(" ").length;
  const score = sources.length * 10 + Math.min(words, 3) + (c.codeDeclares > 0 ? 2 : 0) - flooded.length * 15;
  const reason = `${sources.length ? `found in ${sources.join(" + ")}` : "found nowhere"} (code ${c.codeDeclares} declaring / ${c.codeMentions} mentioning, Jira ${c.jira}, Zephyr ${c.zephyr})${flooded.length ? `; too generic in ${flooded.join(", ")}` : ""}`;
  return { ...c, sources, generic: flooded.length > 0, score, reason };
}

/** Keep the best keywords: non-generic, in 2+ sources (else the best 1-source ones), longest phrasing first among equals. */
export function chooseKeywords(scored, { max = 6 } = {}) {
  const ok = scored.filter((s) => !s.generic && s.sources.length);
  const strong = ok.filter((s) => s.sources.length >= 2);
  const pool = (strong.length >= 2 ? strong : ok).sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
  const out = [];
  // Drop a phrase contained in an already chosen one when it adds no source ("grid" after "grid export").
  for (const s of pool) {
    if (out.length >= max) break;
    const shadowed = out.some((o) => ` ${o.phrase} `.includes(` ${s.phrase} `) && s.sources.every((x) => o.sources.includes(x)));
    if (!shadowed) out.push(s);
  }
  return out;
}

/**
 * Where the feature lives. frontendFiles: repo paths of declaring files under the frontend feature root
 * (relative to it, e.g. "admin/import-job/import-job-page.ts"); otherFiles: the rest (backend, shared). If one
 * feature folder holds most frontend hits it is the module path; otherwise the feature is cross-cutting and
 * its code paths are the folders holding most hits.
 */
export function locateModule({ frontendFiles, otherFiles, slugName, featureDepth = 2, dominant = 0.6, maxPaths = 6 }) {
  const folderOf = (p) => p.split("/").slice(0, -1).slice(0, featureDepth).join("/");
  const counts = new Map();
  for (const f of frontendFiles) { const d = folderOf(f); if (d) counts.set(d, (counts.get(d) ?? 0) + 1); }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  if (ranked.length && ranked[0][1] / frontendFiles.length >= dominant && ranked[0][1] >= 2) {
    return { path: ranked[0][0], crossCutting: false, codePaths: [], why: `${ranked[0][1]} of ${frontendFiles.length} frontend files that declare a keyword are in ${ranked[0][0]}` };
  }
  const dirs = new Map();
  for (const f of [...frontendFiles.map((x) => `@front/${x}`), ...otherFiles]) { const d = f.split("/").slice(0, -1).join("/"); dirs.set(d, (dirs.get(d) ?? 0) + 1); }
  const codePaths = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, maxPaths).map(([d]) => d);
  return { path: slugName, crossCutting: true, codePaths, why: ranked.length ? `the declaring files are spread over ${ranked.length} feature folders (largest: ${ranked[0][0]}, ${ranked[0][1]} of ${frontendFiles.length})` : "no feature folder declares a keyword; the code lives in shared/backend folders" };
}

/** The Zephyr folder holding most matching cases, as a path below the profile's folder root. */
export function dominantFolder(folderPaths, folderRoot) {
  const counts = new Map();
  for (const p of folderPaths) counts.set(p, (counts.get(p) ?? 0) + 1);
  const [top] = [...counts].sort((a, b) => b[1] - a[1]);
  if (!top) return null;
  const rel = top[0].startsWith(folderRoot) ? top[0].slice(folderRoot.length).replace(/^\s*>\s*/, "") : top[0];
  return { folder: rel.split(" > ").at(-1).trim(), path: top[0], cases: top[1], of: folderPaths.length };
}

/**
 * Bridge to the code's own vocabulary. Testers say "grid export", the code says ExportJobService. Code phrases
 * (from declared type names) are accepted when the stories about the feature mention them and they are
 * specific in the code. codeCounts: [{phrase, declares}]; storyTexts: summaries + descriptions of the stories
 * found by the chosen keywords. Returns the accepted phrases with the reason.
 */
export function bridgeToCode(codeCounts, storyTexts, matcher, { max = 3, maxDeclares = 25, minShare = 0.2 } = {}) {
  // One story in passing is chance; ask for at least 2 stories and minShare of them.
  const minStories = Math.max(2, Math.ceil(storyTexts.length * minShare));
  return codeCounts
    .filter((c) => c.declares > 0 && c.declares <= maxDeclares && c.phrase.includes(" "))
    .map((c) => ({ ...c, stories: storyTexts.filter((t) => matcher(c.phrase).test(t)).length }))
    .filter((c) => c.stories >= minStories)
    .sort((a, b) => b.stories - a.stories || b.declares - a.declares || a.phrase.localeCompare(b.phrase))
    .slice(0, max)
    .map((c) => ({ ...c, reason: `code vocabulary: ${c.declares} file(s) declare it, ${c.stories} of ${storyTexts.length} feature stories mention it` }));
}
