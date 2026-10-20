import { tokens, overlap } from "./util.mjs";

/**
 * Which existing Zephyr cases a story is compared against (0 tokens):
 *  1. cases linked to the story or a related story (linkTypesToFollow),
 *  2. unlinked cases in the same folders as those,
 *  3. module scope: cases in the module's Zephyr folder that share a word with the story's scenarios, and
 *     cases whose name contains a module keyword (the module's tests, linked to some other story or none),
 *  4. keyword hits on case names under the profile's folderRoot (finds coverage that was never linked).
 * Linked cases always come first, so the cap never drops them.
 */
export function selectCandidates({ story, zephyr, expected, limits, module = null }) {
  const out = new Map();
  const add = (key, why, linked) => {
    if (!out.has(key) && zephyr.byKey.has(key)) out.set(key, { key, why, linked });
  };

  for (const key of zephyr.issueIndex.get(story.id) ?? []) add(key, `linked to ${story.key}`, true);
  for (const rel of story.related) {
    for (const key of zephyr.issueIndex.get(rel.id) ?? []) add(key, `linked to related ${rel.key} (${rel.type})`, true);
  }

  const linkedFolders = new Set([...out.values()].map((c) => zephyr.byKey.get(c.key).folderId).filter(Boolean));
  const sameFolder = zephyr.inScopeCases.filter((c) => linkedFolders.has(c.folderId));
  for (const c of sameFolder.slice(0, Math.max(0, limits.candidateCasesPerStory - out.size))) {
    add(c.key, `same folder as linked cases (${c.folderPath})`, false);
  }

  const storyTokens = tokens([story.summary, story.module, ...expected.slice(0, 15).map((e) => e.title)].join(" "));
  if (module) {
    const folder = module.zephyrFolder?.toLowerCase();
    const scored = [];
    for (const c of zephyr.inScopeCases) {
      if (out.has(c.key)) continue;
      const inFolder = folder && c.folderPath.toLowerCase().includes(folder);
      const named = module.rx?.test(c.name);
      if (!inFolder && !named) continue;
      const hits = [...tokens(c.name)].filter((t) => storyTokens.has(t));
      if (!named && !hits.length) continue;
      scored.push({ c, score: hits.length + (named ? 1 : 0) + (inFolder ? 1 : 0), inFolder, named, hits });
    }
    scored.sort((a, b) => b.score - a.score || a.c.key.localeCompare(b.c.key));
    for (const { c, inFolder, named, hits } of scored.slice(0, limits.moduleCandidates ?? 15)) {
      if (out.size >= limits.candidateCasesPerStory) break;
      add(c.key, [inFolder && `in the module's Zephyr folder "${module.zephyrFolder}"`, named && "name contains a module keyword", hits.length && `shares: ${hits.slice(0, 4).join(", ")}`].filter(Boolean).join("; "), false);
    }
  }
  const scored = [];
  for (const c of zephyr.inScopeCases) {
    if (out.has(c.key)) continue;
    const caseTokens = tokens(`${c.name} ${c.folderPath.split(" > ").slice(-2).join(" ")}`);
    const hits = [...caseTokens].filter((t) => storyTokens.has(t));
    if (hits.length >= 2) scored.push({ c, score: hits.length, hits });
  }
  scored.sort((a, b) => b.score - a.score);
  for (const { c, hits } of scored.slice(0, limits.keywordCandidates)) {
    if (out.size >= limits.candidateCasesPerStory) break;
    add(c.key, `keyword overlap: ${hits.slice(0, 5).join(", ")}`, false);
  }
  return [...out.values()];
}

/** Folder candidates for new cases: module hint, folders of linked/candidate cases, then keyword-similar folders. */
export function folderCandidates({ story, candidates, zephyr, profile, limit }) {
  const out = new Map();
  const add = (folder, why) => {
    if (folder && !out.has(folder.id)) out.set(folder.id, { id: folder.id, path: folder.path, why });
  };
  const hint = profile.modules?.[story.module]?.zephyrFolder;
  if (hint) {
    for (const f of zephyr.inScopeFolders.filter((f) => f.path.toLowerCase().includes(hint.toLowerCase()))) add(f, `profile module hint "${hint}"`);
  }
  const folderById = new Map(zephyr.folders.map((f) => [f.id, f]));
  const counts = new Map();
  for (const c of candidates) {
    const fid = zephyr.byKey.get(c.key)?.folderId;
    if (fid) counts.set(fid, (counts.get(fid) ?? 0) + (c.linked ? 3 : 1));
  }
  for (const [fid, n] of [...counts].sort((a, b) => b[1] - a[1])) add(folderById.get(fid), `holds ${n > 2 ? "linked" : "similar"} existing cases`);
  const storyTokens = tokens(`${story.summary} ${story.module}`);
  const scored = zephyr.inScopeFolders
    .map((f) => ({ f, score: overlap(tokens(f.path.split(" > ").slice(-2).join(" ")), storyTokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  for (const { f } of scored) add(f, "folder name matches the story/module");
  return [...out.values()].slice(0, limit);
}
