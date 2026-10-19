#!/usr/bin/env node
// Keyword triangulation (0 tokens): what the user means → the module, its keywords and its Zephyr folder,
// checked against the code (frontend + backend), the Jira stories and the Zephyr cases.
//   node scripts/vocab.mjs --words "grid data export"                                    (profile from config/run.json)
//   node scripts/vocab.mjs --words "grid data export" --rovo runs/avl/rovo/grid-data-export.json
//   node scripts/vocab.mjs --words "grid data export" --save "grid export"               (write the proposal into modules.json)
// --rovo: what a Rovo search found ({stories: [{key, summary}], docs: [{title, url}]}); its titles add
// candidate phrases. Nothing is sent to Claude; Jira gets one count request per candidate.
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ROOT, loadEnv, loadProfile, loadRunConfig, requireEnv, loadModulesCatalog } from "./lib/config.mjs";
import { ensureRepo, codeVocabulary } from "./lib/code.mjs";
import { exportZephyr } from "./lib/zephyr.mjs";
import { createJiraClient } from "./lib/jira.mjs";
import { keywordRegex } from "./lib/triage-rules.mjs";
import { phraseWords, sweepKeywords } from "./lib/discover.mjs";
import { focusRegex } from "./lib/uc-parser.mjs";
import { candidatePhrases, scoreKeyword, chooseKeywords, locateModule, dominantFolder, bridgeToCode } from "./lib/vocab.mjs";
import { readJson, writeJson, slug, promisePool, htmlToText } from "./lib/util.mjs";

const { values: a } = parseArgs({ options: {
  profile: { type: "string" }, words: { type: "string" }, rovo: { type: "string" }, max: { type: "string" },
  save: { type: "string" }, json: { type: "boolean" }, help: { type: "boolean", short: "h" },
} });
const cfg = loadRunConfig();
a.words ??= cfg.defaultModule;
if (a.help || !a.words) {
  console.log(`Usage: node scripts/vocab.mjs --words "<what you mean>" [--rovo <file>] [--max 20] [--save "<module name>"] [--json]`);
  process.exit(a.help ? 0 : 2);
}
loadEnv();
requireEnv("ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "ZEPHYR_API_TOKEN");
const profile = loadProfile(a.profile);
const cacheDir = path.join(ROOT, "cache", profile.name);
const log = (m) => console.error(m);
const rovo = a.rovo ? readJson(path.resolve(a.rovo)) : { stories: [], docs: [] };
const rovoStories = Array.isArray(rovo) ? rovo : rovo.stories ?? [];
const rovoDocs = Array.isArray(rovo) ? [] : rovo.docs ?? [];

// 1. Candidates come from the language of every source: Jira story summaries, Zephyr case names and folders,
//    Rovo titles and type names in the code, each kept only when it shares a distinctive word with the request.
const repos = (profile.code?.repos ?? []).map((repo) => ({ repo, info: ensureRepo(repo, cacheDir, { refresh: false, log }) }));
const vocab = repos.map(({ repo, info }) => ({ repo, ...codeVocabulary(repo, info) }));
const focus = new Set(phraseWords(a.words));
const declaredTexts = vocab.flatMap((v) => v.declared).filter((n) => phraseWords(n).some((w) => focus.has(w)));
const zephyr = await exportZephyr({ profile, cacheDir, maxAgeHours: cfg.zephyr.exportMaxAgeHours, log });
const jira = createJiraClient({ baseUrl: profile.jira.baseUrl, email: process.env.ATLASSIAN_EMAIL, token: process.env.ATLASSIAN_API_TOKEN });
const base = `project = ${profile.jira.projectKey} AND issuetype in (${profile.jira.storyTypes.map((t) => `"${t}"`).join(", ")})`;
const textJql = (phrases) => `${base} AND (${phrases.map((p) => `text ~ "\\"${p}\\""`).join(" OR ")})`;
const shares = (t) => phraseWords(t).some((w) => focus.has(w));
// Stories naming every distinctive word of the request (any order), summaries only.
const focusJql = `${base} AND ${[...focus].map((w) => `summary ~ "${w}"`).join(" AND ")}`;
const jiraSummaries = focus.size ? (await jira.search(focusJql).catch((err) => { log(`Jira search failed: ${err.message.slice(0, 120)}`); return []; })).map((i) => i.fields.summary) : [];
const zephyrTexts = zephyr.inScopeCases.map((z) => `${z.folderPath.split(" > ").at(-1)} ${z.name}`).filter(shares);
const texts = [a.words, ...jiraSummaries, ...zephyrTexts, ...rovoStories.map((s) => s.summary ?? ""), ...rovoDocs.map((d) => d.title ?? ""), ...declaredTexts];
const candidates = candidatePhrases(a.words, texts, { max: Number(a.max ?? 20) });

// 2. Count each candidate in code, Jira and Zephyr.
const allFiles = vocab.flatMap((v) => v.files);
const sweep = sweepKeywords(allFiles, candidates.map((c) => c.phrase), { maxSeedsPerPhrase: Infinity, maxMentions: 0 });
const counted = [];
await promisePool(candidates, 4, async (c) => {
  const st = sweep.stats.find((s) => s.phrase === c.phrase);
  const rx = keywordRegex([c.phrase]);
  const cases = zephyr.inScopeCases.filter((z) => rx.test(z.name) || rx.test(z.folderPath.split(" > ").at(-1)));
  let jiraCount = 0;
  try { jiraCount = await jira.count(textJql([c.phrase])); } catch (err) { log(`Jira count failed for "${c.phrase}": ${err.message.slice(0, 120)}`); }
  counted.push(scoreKeyword({ phrase: c.phrase, seen: c.seen, codeDeclares: st.strong, codeMentions: st.files - st.strong, jira: jiraCount, zephyr: cases.length }));
});
const scored = counted.sort((x, y) => y.score - x.score || x.phrase.localeCompare(y.phrase));
const chosen = chooseKeywords(scored);

// 2b. Bridge to the code's own vocabulary through the stories the chosen keywords find.
const userPhrases = chosen.map((c) => c.phrase);
const featureIssues = userPhrases.length ? await jira.search(textJql(userPhrases)).catch(() => []) : [];
const storyTexts = featureIssues.map((i) => `${i.fields.summary}\n${htmlToText(i.renderedFields?.description ?? "")}`);
const codeCands = candidatePhrases(a.words, declaredTexts, { max: 40, minCount: 1, minAnchors: Infinity }).map((c) => c.phrase).filter((p) => p.includes(" ") && !userPhrases.includes(p));
const codeStats = codeCands.length ? sweepKeywords(allFiles, codeCands, { maxSeedsPerPhrase: Infinity, maxMentions: 0 }).stats : [];
const bridge = bridgeToCode(codeStats.map((s) => ({ phrase: s.phrase, declares: s.strong })), storyTexts, (p) => keywordRegex([p]));
const phrases = [...userPhrases, ...bridge.map((b) => b.phrase)];

// 3. Proposal: where the code lives, which Zephyr folder holds the cases, which Rovo stories fit.
const front = profile.code.repos[0]?.frontendRoot ?? "";
const declaring = (list) => (list.length ? sweepKeywords(allFiles, list, { maxSeedsPerPhrase: Infinity, maxMentions: 0 }).seeds.map((s) => s.path) : []);
// The users' words decide WHICH folder the module is; the bridged code words only add where its code lives.
const userSeeds = declaring(userPhrases);
const seeds = [...new Set([...userSeeds, ...declaring(bridge.map((b) => b.phrase))])];
const inFront = (p) => p.startsWith(front + "/");
const located = locateModule({
  frontendFiles: userSeeds.filter(inFront).map((p) => p.slice(front.length + 1)),
  otherFiles: seeds.filter((p) => !inFront(p) || !userSeeds.includes(p)),
  slugName: slug(a.words),
});
located.codePaths = located.codePaths.map((d) => d.replace(/^@front/, front));
const rx = keywordRegex(phrases);
const matchingCases = rx ? zephyr.inScopeCases.filter((z) => rx.test(z.name) || rx.test(z.folderPath.split(" > ").at(-1))) : [];
const folder = dominantFolder(matchingCases.map((z) => z.folderPath), profile.zephyr.folderRoot);
let storyCount = 0;
if (phrases.length) try { storyCount = await jira.count(textJql(phrases)); } catch { /* counted above */ }
const rovoFit = rovoStories.filter((s) => rx?.test(s.summary ?? ""));
// Cross-cutting: the core term that keeps another page's export parts and drops the rest of that page.
const focusRx = located.crossCutting ? focusRegex(null, phrases) : null;

const proposal = {
  path: located.path,
  ...(located.crossCutting ? { crossCutting: true, ...(focusRx ? { focusPattern: focusRx.source } : {}), codePaths: located.codePaths } : {}),
  aliases: [a.words],
  keywords: phrases,
  ...(folder ? { zephyrFolder: folder.folder } : {}),
  includeStories: [],
  excludeStories: [],
  notes: `Proposed by scripts/vocab.mjs on ${new Date().toISOString().slice(0, 10)} from "${a.words}": ${located.why}.`,
};
const result = { words: a.words, candidates: scored, chosen: phrases, bridge, located, zephyrFolder: folder, jiraStories: storyCount, zephyrCases: matchingCases.length, rovo: { stories: rovoStories.length, fitting: rovoFit.map((s) => s.key), docs: rovoDocs }, proposal };

if (a.json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`# "${a.words}" — ${candidates.length} candidate keywords (from your words, ${jiraSummaries.length} Jira summaries, ${zephyrTexts.length} Zephyr cases, ${rovoStories.length + rovoDocs.length} Rovo results, ${declaredTexts.length} type names)\n`);
  console.log("score  keep  phrase                          code decl/ment  Jira  Zephyr  why");
  for (const s of scored) console.log(`${String(s.score).padStart(5)}  ${chosen.includes(s) ? " ✓  " : s.generic ? " ✗  " : "    "}  ${s.phrase.padEnd(30)}  ${String(s.codeDeclares).padStart(5)}/${String(s.codeMentions).padEnd(5)}  ${String(s.jira).padStart(5)}  ${String(s.zephyr).padStart(6)}  ${s.reason}`);
  console.log(`\nFeature stories found by those keywords: ${featureIssues.length}`);
  for (const b of bridge) console.log(`  + "${b.phrase}" — ${b.reason}`);
  if (!bridge.length) console.log("  (no code phrase is both declared in the code and mentioned by these stories)");
  console.log(`\nModule: ${located.crossCutting ? `cross-cutting feature "${located.path}"` : located.path} — ${located.why}`);
  if (located.crossCutting) console.log(`Code paths: ${located.codePaths.join(", ") || "(none)"}`);
  if (located.crossCutting) console.log(`Focus: ${focusRx ? `/${focusRx.source}/ — other pages' stories keep only the use cases and scenarios matching it` : "(none: the keywords share no word; other pages' UCs are filtered by the keywords only)"}`);
  console.log(`Zephyr: ${matchingCases.length} case(s) match the keywords${folder ? `; most in "${folder.path}" (${folder.cases} of ${folder.of})` : ""}`);
  console.log(`Jira: ~${storyCount} ${profile.jira.storyTypes.join("/")} stories contain a keyword`);
  if (rovoStories.length) console.log(`Rovo: ${rovoFit.length} of ${rovoStories.length} stories contain a chosen keyword (${rovoFit.map((s) => s.key).join(", ") || "none"}); the others stay candidates for the scout`);
  for (const d of rovoDocs) console.log(`  doc: ${d.title} ${d.url ?? ""}`);
  console.log(`\nProposed modules.json entry:\n${JSON.stringify({ [a.save ?? a.words]: proposal }, null, 2)}`);
}

// 4. --save: only on request (the /coverage command asks the user first).
if (a.save) {
  const file = path.join(profile.dir, "modules.json");
  const json = readJson(file, { $schema: "../../schema/modules.schema.json", modules: {} });
  const prev = json.modules[a.save];
  json.modules[a.save] = prev
    ? { ...proposal, ...prev, keywords: [...new Set([...(prev.keywords ?? []), ...proposal.keywords])], aliases: [...new Set([...(prev.aliases ?? []), ...proposal.aliases])] }
    : proposal;
  writeJson(file, json);
  loadModulesCatalog(profile.dir); // throws if the result is not valid
  console.error(`Saved "${a.save}" into ${path.relative(ROOT, file)}${prev ? " (merged: your existing fields kept, keywords and aliases added)" : ""}.`);
}
