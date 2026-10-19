// The six pipeline stages. Each one: apply the previous agent's review (if any), reset only its own
// outputs, do its work, save state. Order: scope → requirements → code → match → draft → report.
import fs from "node:fs";
import path from "node:path";
import { ROOT, requireEnv } from "./config.mjs";
import { normalizeIssue } from "./jira.mjs";
import { resolveScope } from "./scope.mjs";
import { triageByRules, deriveModule, keywordRegex } from "./triage-rules.mjs";
import { parseUcDoc, ucDocToScenarios, useCasesMentioning, focusRegex, splitByFocus } from "./uc-parser.mjs";
import { getSteps, caseUrl } from "./zephyr.mjs";
import { ensureRepo, collectModuleCode, codeUrl } from "./code.mjs";
import { selectCandidates, folderCandidates } from "./candidates.mjs";
import { buildWorkbook, readGapSheet } from "./workbook.mjs";
import { writeSummary } from "./report.mjs";
import { applyScoutReview, applyRequirementsReview, applyCodeReview, applyMatchReview, applyDraftsReview } from "./reviews.mjs";
import { chunk, promisePool, truncate, hash, writeJson, readJson } from "./util.mjs";

const blankResult = (story, triage) => ({
  story, triage, dropped: null, linkCheck: null, expected: [], droppedScenarios: [], skippedUcs: [], flags: [],
  candidates: [], matches: [], auditMatches: [], orphans: [], gaps: [], errors: [],
});

// ---------------------------------------------------------------- 1. scope
export async function scopeStage(ctx, { scopeArg, since, keywords, extraStories, limit, remember }) {
  const { profile } = ctx;
  requireEnv("ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN", "ZEPHYR_API_TOKEN");
  const scope = resolveScope(scopeArg, profile, { since, keywords, extraStories });
  ctx.state.scope = scope;
  ctx.step("scope", { notes: `JQL: ${scope.jql}${scope.moduleFilter ? ` | module: ${scope.moduleFilter} | keywords: ${scope.keywords.join(", ")}` : ""}${ctx.dryRun ? " | DRY RUN" : ""}` });

  const raw = await ctx.jira.search(scope.jql, { onPage: (n) => ctx.log(`Jira: ${n} issues fetched…`) });
  const override = scope.moduleFilter ? { module: scope.moduleFilter, keywords: scope.keywords } : null;
  let stories = raw.map(normalizeIssue).map((s) => ({
    ...s,
    ...deriveModule(s, profile, override),
    related: s.links.filter((l) => profile.jira.linkTypesToFollow?.includes(l.type) && l.key).map((l) => ({ key: l.key, id: l.id, type: l.type })),
  }));
  const fetched = stories.length;
  const conf = scope.moduleConf;
  if (conf?.includeStories?.length) {
    for (const s of stories.filter((x) => conf.includeStories.includes(x.key) && x.module !== scope.moduleFilter)) {
      Object.assign(s, { module: scope.moduleFilter, moduleSource: "modules.json", featurePath: scope.moduleFilter, moduleReason: "listed in includeStories" });
    }
  }
  // Rovo candidates the keywords did not assign: in scope for the scout to confirm or drop.
  const extraByKey = new Map((scope.extraStories ?? []).map((x) => [x.key, x]));
  const extraAdded = [];
  for (const s of stories.filter((x) => extraByKey.has(x.key) && x.module !== scope.moduleFilter && x.moduleSource !== "featurePath")) {
    const x = extraByKey.get(s.key);
    Object.assign(s, { module: scope.moduleFilter, moduleSource: x.source, featurePath: scope.moduleFilter, moduleReason: `found by ${x.source} search${x.query ? ` "${x.query}"` : ""}, no keyword match; candidate for the scout to confirm` });
    extraAdded.push(s.key);
  }
  if (extraByKey.size) {
    const fetchedKeys = new Set(stories.map((s) => s.key));
    const byKeyword = [...extraByKey.keys()].filter((k) => fetchedKeys.has(k) && !extraAdded.includes(k));
    const notStories = [...extraByKey.keys()].filter((k) => !fetchedKeys.has(k));
    ctx.step("extra-stories", {
      in: extraByKey.size, out: extraAdded.length,
      notes: `${extraByKey.size} candidate(s) from ${[...new Set([...extraByKey.values()].map((x) => x.source))].join("/")}: ${extraAdded.length} added (${extraAdded.join(", ") || "none"}), ${byKeyword.length} already found by the keywords.`,
      skipped: notStories.length ? `Not a ${profile.jira.storyTypes.join("/")} of ${profile.jira.projectKey} (or not visible): ${notStories.join(", ")}` : "",
    });
  }
  // Cross-cutting feature: a QA doc of another page that mentions it is in scope (only its matching UCs count).
  if (conf?.crossCutting) {
    const rx = keywordRegex(scope.keywords);
    for (const s of stories.filter((x) => x.moduleSource === "featurePath" && x.featurePath !== scope.moduleFilter)) {
      const hit = rx && (s.summary.match(rx) ?? s.descriptionText.match(rx));
      if (hit) Object.assign(s, { module: scope.moduleFilter, moduleSource: "keywords", featurePath: scope.moduleFilter, hostModule: s.featurePath, keywordHit: hit[0], moduleReason: `QA doc of ${s.featurePath} mentions "${hit[0]}" (cross-cutting module: only its matching use cases are analysed)` });
    }
  }
  if (scope.moduleFilter) {
    const out = stories.filter((s) => s.module !== scope.moduleFilter);
    stories = stories.filter((s) => s.module === scope.moduleFilter);
    if (out.length) {
      ctx.step("module-filter", {
        in: fetched, out: stories.length,
        notes: `${out.length} story(ies) matched the text search but belong elsewhere.`,
        skipped: out.slice(0, 25).map((s) => `${s.key} (${s.moduleSource === "featurePath" ? `its QA doc names ${s.featurePath}` : "no keyword in summary/description"})`).join("; "),
      });
    }
  }
  if (limit) stories = stories.slice(0, Number(limit));
  for (const s of stories.filter((x) => x.moduleSource === "keywords" && !x.hostModule)) s.moduleReason = `assigned via keyword "${s.keywordHit}"`;
  ctx.state.stories = stories.map((s) => blankResult(s, triageByRules(s, profile)));
  const excluded = [];
  for (const r of ctx.stories.filter((x) => conf?.excludeStories?.includes(x.story.key))) {
    r.dropped = { by: "config:modules.json", reasoning: `Listed in excludeStories of module "${conf.name ?? scope.moduleFilter}" in profiles/${profile.name}/modules.json.` };
    excluded.push(r.story.key);
  }
  ctx.step("fetch-stories", {
    in: fetched, out: stories.length,
    notes: `${fetched} issue(s) from Jira; ${stories.length} in scope${conf?.name ? ` (module "${conf.name}" from modules.json)` : ""}.`,
    skipped: excluded.length ? `Excluded by modules.json: ${excluded.join(", ")}` : "",
  });

  const undecided = ctx.stories.filter((r) => r.triage.testable === null).length;
  ctx.step("triage-rules", { in: stories.length, out: stories.length - undecided, notes: `${stories.length - undecided} decided by profile rules (0 tokens); ${undecided} left for the requirements stage.` });

  const zephyr = await ctx.zephyr();
  ctx.step("zephyr-export", { in: zephyr.cases.length, out: zephyr.inScopeCases.length, notes: `${zephyr.cases.length} cases in ${profile.zephyr.projectKey}; ${zephyr.inScopeCases.length} under "${profile.zephyr.folderRoot}". Exported ${zephyr.exportedAt}.` });
  linkCheck(ctx, zephyr);

  if (remember && scope.moduleFilter) rememberKeywords(ctx, scope);
  ctx.markDone("scope");
}

function linkCheck(ctx, zephyr) {
  const relevant = ctx.stories.filter((r) => r.triage.testable !== false);
  for (const r of relevant) {
    const s = r.story;
    const own = zephyr.issueIndex.get(s.id) ?? [];
    const viaRelated = s.related.map((rel) => ({ rel, keys: zephyr.issueIndex.get(rel.id) ?? [] }));
    const linkedKeys = [...new Set([...own, ...viaRelated.flatMap((x) => x.keys)])];
    const parts = [own.length ? `${own.length} case(s) link to ${s.key} as coverage (${own.join(", ")}).` : `No Zephyr case links to ${s.key}.`];
    for (const { rel, keys } of viaRelated) parts.push(`Related ${rel.key} (${rel.type}): ${keys.length ? keys.join(", ") : "no linked cases"}.`);
    if (!linkedKeys.length) parts.push("Guaranteed gap at link level; matching will still look for unlinked cases by folder/keyword.");
    r.linkCheck = { linkedKeys, result: linkedKeys.length ? `Has ${linkedKeys.length} linked test case(s)` : "No tests linked — guaranteed gap", reasoning: parts.join(" ") };
  }
  const none = relevant.filter((r) => !r.linkCheck.linkedKeys.length).length;
  ctx.step("link-check", { in: relevant.length, out: none, notes: `${none} of ${relevant.length} (possibly) testable stories have no linked Zephyr case.` });
}

/** --remember: store the module's keywords in modules.json so the next run needs none. */
function rememberKeywords(ctx, scope) {
  const file = path.join(ctx.profile.dir, "modules.json");
  const json = readJson(file, { $schema: "../../schema/modules.schema.json", modules: {} });
  const existing = Object.entries(json.modules).find(([, m]) => m.path === scope.moduleFilter);
  const name = existing?.[0] ?? scope.moduleFilter.split("/").pop().replace(/[-_]+/g, " ");
  const entry = existing?.[1] ?? { path: scope.moduleFilter };
  entry.keywords = [...new Set([...(entry.keywords ?? []), ...scope.keywords])];
  json.modules[name] = entry;
  writeJson(file, json);
  ctx.step("remember", { notes: `Saved keywords for "${name}" (${scope.moduleFilter}) into profiles/${ctx.profile.name}/modules.json.` });
}

// ---------------------------------------------------------------- 2. requirements
export async function requirementsStage(ctx) {
  const { profile, cfg } = ctx;
  applyScoutReview(ctx);
  ctx.clearErrors("requirements");
  for (const r of ctx.stories) {
    Object.assign(r, { expected: [], droppedScenarios: [], skippedUcs: [], flags: [], extractNote: undefined });
    if (r.triage.decidedBy !== "rule") r.triage = triageByRules(r.story, profile);
  }
  const live = ctx.stories.filter((r) => !r.dropped);

  // Triage leftovers (LLM)
  const undecided = live.filter((r) => r.triage.testable === null);
  const batches = chunk(undecided, cfg.batch.triage);
  await promisePool(batches, ctx.concurrency, async (batch, i) => {
    const input = batch.map(({ story: s }) => ({ key: s.key, summary: s.summary, epic: s.epicSummary ?? "", labels: s.labels, description: truncate(s.descriptionText, cfg.limits.descriptionCharsTriage) }));
    try {
      const res = await ctx.llmRun("triage", {
        cacheKey: `triage-${hash(batch.map((r) => r.story.key))}`, fingerprint: input, prompt: JSON.stringify({ stories: input }),
        jiraKeys: batch.map((r) => r.story.key), itemsIn: batch.length, countOut: (o) => o.results.length,
      });
      for (const r of batch) {
        const hit = res.output?.results.find((x) => x.key === r.story.key);
        if (hit) Object.assign(r.triage, { testable: hit.testable, decidedBy: "LLM", reasoning: hit.reasoning });
        else Object.assign(r.triage, { testable: null, decidedBy: "none", reasoning: res.output ? "LLM triage returned no verdict for this story; review manually." : `Undecided: ${ctx.skipReason(res)}.` });
      }
      ctx.step("triage-llm", { batch: `batch ${i + 1}/${batches.length}`, in: batch.length, out: res.output?.results.length ?? 0, notes: res.reused ? "served from cache" : res.output ? "classified" : ctx.skipReason(res) });
    } catch (err) {
      for (const r of batch) Object.assign(r.triage, { testable: null, decidedBy: "error", reasoning: `LLM triage failed: ${err.message.slice(0, 200)}` });
      ctx.step("triage-llm", { batch: `batch ${i + 1}/${batches.length}`, in: batch.length, errors: err.message.slice(0, 300) });
    }
  });
  // Stories that became testable need a link check too.
  linkCheck(ctx, await ctx.zephyr());

  const testable = ctx.testable();
  ctx.step("triage", { in: live.length, out: testable.length, notes: `${testable.length} testable, ${live.filter((r) => r.triage.testable === false).length} not testable, ${live.filter((r) => r.triage.testable === null).length} undecided, ${ctx.stories.length - live.length} dropped by the scout.` });

  // Structured UC docs: parsed by script
  // Cross-cutting module: a story found by keyword (or Rovo) is about some page that uses the feature, so only
  // its parts about the feature count. Stories listed in includeStories are kept whole.
  const scope = ctx.state.scope;
  const moduleName = `"${scope?.moduleConf?.name ?? scope?.moduleFilter}"`;
  const hostStory = (r) => scope?.moduleConf?.crossCutting && r.story.moduleSource !== "modules.json";
  const keywordsRx = keywordRegex(scope?.keywords ?? []);
  const focusRx = focusRegex(scope?.moduleConf, scope?.keywords ?? []);
  const freeText = [];
  for (const r of testable) {
    if (r.triage.acSource === "uc-doc") {
      const { doc, skipped: offTopic } = hostStory(r)
        ? useCasesMentioning(parseUcDoc(r.story.descriptionHtml), keywordsRx, { storyKey: r.story.key, moduleName, focusRx })
        : { doc: parseUcDoc(r.story.descriptionHtml), skipped: [] };
      const { scenarios, skipped } = ucDocToScenarios(doc, { storyKey: r.story.key, ...profile.jira.ucDoc });
      r.expected.push(...scenarios);
      r.skippedUcs = [...skipped, ...offTopic];
    } else {
      freeText.push(r);
    }
  }
  const ucCount = testable.filter((r) => r.triage.acSource === "uc-doc");
  ctx.step("extract-uc-doc", { in: ucCount.length, out: ucCount.reduce((n, r) => n + r.expected.length, 0), notes: "Structured UC docs parsed by script (0 tokens)." });

  // Free-text AC / descriptions: LLM
  const acBatches = chunk(freeText, cfg.batch["extract-ac"]);
  await promisePool(acBatches, ctx.concurrency, async (batch, i) => {
    const input = batch.map(({ story: s }) => ({ key: s.key, summary: s.summary, epic: s.epicSummary ?? "", description: truncate(s.descriptionText, cfg.limits.descriptionCharsExtract) }));
    try {
      const res = await ctx.llmRun("extract-ac", {
        cacheKey: `extract-ac-${hash(batch.map((r) => r.story.key))}`, fingerprint: input, prompt: JSON.stringify({ stories: input }),
        jiraKeys: batch.map((r) => r.story.key), itemsIn: batch.length, countOut: (o) => o.stories.reduce((n, x) => n + x.scenarios.length, 0),
      });
      for (const r of batch) {
        const hit = res.output?.stories.find((x) => x.key === r.story.key);
        if (!hit) { r.errors.push(`requirements: ${res.output ? "extract-ac returned nothing for this story" : ctx.skipReason(res)}`); continue; }
        if (!hit.scenarios.length) r.extractNote = hit.noScenarioReason;
        hit.scenarios.forEach((sc, n) => r.expected.push({
          id: `${r.story.key}:S${String(n + 1).padStart(2, "0")}`, storyKey: r.story.key, source: "story", uc: "", flow: sc.flow, title: sc.title, type: sc.type,
          steps: sc.steps, expected: sc.expected, evidence: sc.evidence, priorityHint: sc.flow === "main" ? "High" : "Medium",
          codeOnly: false, reasoning: `${sc.reasoning} (LLM-derived from the story's ${r.triage.acSource === "ac-text" ? "acceptance criteria" : "description"}.)`,
        }));
      }
      ctx.step("extract-ac", { batch: `batch ${i + 1}/${acBatches.length}`, in: batch.length, out: res.output ? res.output.stories.reduce((n, x) => n + x.scenarios.length, 0) : 0, notes: res.reused ? "served from cache" : res.output ? "extracted" : ctx.skipReason(res) });
    } catch (err) {
      for (const r of batch) r.errors.push(`requirements: extract-ac failed: ${err.message.slice(0, 200)}`);
      ctx.step("extract-ac", { batch: `batch ${i + 1}/${acBatches.length}`, in: batch.length, errors: err.message.slice(0, 300) });
    }
  });
  // Free-text scenarios of another page's story: only those naming the feature stay (0 tokens, cache untouched).
  const focusDrops = [];
  const rx = focusRx ?? keywordsRx;
  for (const r of freeText.filter(hostStory)) {
    const { keep, drop } = splitByFocus(r.expected, rx);
    if (!drop.length) continue;
    r.expected = keep;
    r.droppedScenarios.push(...drop.map((e) => ({ ...e, droppedBy: "config:crossCutting", reasoning: `${e.reasoning} Dropped: not about ${moduleName} (no match for /${rx.source}/); ${r.story.key} covers another page, so only its ${moduleName} scenarios are analysed.` })));
    focusDrops.push(`${r.story.key} ${drop.length}/${drop.length + keep.length}`);
  }
  if (focusDrops.length) ctx.step("cross-cutting-filter", { in: freeText.length, out: freeText.reduce((n, r) => n + r.expected.length, 0), notes: `Scenarios not about ${moduleName} dropped (/${rx.source}/): ${focusDrops.join(", ")}.` });
  ctx.markDone("requirements");
}

// ---------------------------------------------------------------- 3. code
export async function codeStage(ctx) {
  const { profile, cfg } = ctx;
  applyRequirementsReview(ctx);
  ctx.clearErrors("code");
  for (const r of ctx.stories) r.expected = r.expected.filter((e) => !e.codeOnly);

  if (!(cfg.code.enabled && !ctx.opts.noCode && profile.code?.provider === "git" && profile.code.repos?.length)) {
    ctx.step("extract-code", { skipped: "Code analysis disabled (--no-code, config code.enabled=false, or profile code.provider is not git)." });
    ctx.markDone("code");
    return;
  }
  const byModule = new Map();
  for (const r of ctx.testable()) {
    if (!r.story.featurePath) continue;
    if (cfg.code.skipForUcDocStories && r.triage.acSource === "uc-doc") continue;
    if (!byModule.has(r.story.featurePath)) byModule.set(r.story.featurePath, []);
    byModule.get(r.story.featurePath).push(r);
  }
  const noPath = ctx.testable().filter((r) => !r.story.featurePath).length;
  if (noPath) ctx.step("extract-code", { batch: "(all)", skipped: `${noPath} testable stories have no code feature path; code analysis skipped for them.` });

  const repoInfos = repoInfosFor(ctx, { checkout: byModule.size > 0 });
  await promisePool([...byModule], ctx.concurrency, async ([featurePath, group]) => {
    const files = [];
    const notes = [];
    for (const { repo, info } of repoInfos.values()) {
      // The scope's keywords drive the sweep for the analysed module only; stories of other modules keep folder discovery.
      const keywords = featurePath === ctx.state.scope?.moduleFilter ? ctx.state.scope.keywords ?? [] : [];
      const c = collectModuleCode({ repo, repoInfo: info, featurePath, codePaths: profile.modules?.[featurePath]?.codePaths, keywords, limits: cfg.limits, discovery: cfg.code.discovery, hints: group.map((r) => r.story.summary) });
      files.push(...c.files.map((f) => ({ ...f, repo: repo.name })));
      notes.push(...c.notes);
    }
    if (!files.length) {
      ctx.step("extract-code", { batch: featurePath, in: group.length, skipped: `No code files found. ${notes.join("; ")}` });
      return;
    }
    // One set of code scenarios per module, attached to the story owning the module's QA doc (else the newest).
    const primary = [...group].sort((a, b) => (b.triage.acSource === "uc-doc") - (a.triage.acSource === "uc-doc") || b.story.updated.localeCompare(a.story.updated))[0];
    const titles = group.flatMap((r) => r.expected.map((e) => e.title)).slice(0, 80);
    const input = { module: featurePath, stories: group.map((r) => ({ key: r.story.key, summary: r.story.summary })), storyScenarioTitles: titles, files: files.map(({ path: p, role, content }) => ({ path: p, role, content })) };
    try {
      const res = await ctx.llmRun("extract-code", {
        cacheKey: `code-${featurePath}`, fingerprint: { files: files.map((f) => hash(f.content) + f.path), titles }, prompt: JSON.stringify(input),
        jiraKeys: group.map((r) => r.story.key), module: featurePath, itemsIn: files.length, countOut: (o) => o.scenarios.length,
      });
      if (!res.output) { ctx.step("extract-code", { batch: featurePath, in: files.length, skipped: ctx.skipReason(res) }); return; }
      const fileRepo = new Map(files.map((f) => [f.path, f.repo]));
      res.output.scenarios.forEach((sc, n) => primary.expected.push({
        id: `${primary.story.key}:CODE-${String(n + 1).padStart(2, "0")}`, storyKey: primary.story.key, source: sc.source, uc: "", flow: sc.flow, title: sc.title,
        type: sc.type, steps: sc.steps, expected: sc.expected, evidence: sc.evidence, repo: fileRepo.get(sc.evidence.path) ?? files[0].repo,
        priorityHint: "Medium", codeOnly: true,
        reasoning: `${sc.reasoning} (Code-derived from ${sc.evidence.path}: code shows what the system does, so confirm it is intended before treating it as a requirement.${group.length > 1 ? ` Module shared by ${group.map((r) => r.story.key).join(", ")}; attached to ${primary.story.key}.` : ""})`,
      }));
      ctx.step("extract-code", { batch: featurePath, in: files.length, out: res.output.scenarios.length, notes: `${res.reused ? "served from cache" : "extracted"}; ${files.filter((f) => f.role !== "map").length} files + implementation map. ${notes.join("; ")}` });
    } catch (err) {
      primary.errors.push(`code: extract-code failed: ${err.message.slice(0, 200)}`);
      ctx.step("extract-code", { batch: featurePath, in: files.length, errors: err.message.slice(0, 300) });
    }
  });
  ctx.markDone("code");
}

/** Repo checkouts for code reading and evidence links; commits are remembered in state. */
export function repoInfosFor(ctx, { checkout = true } = {}) {
  const infos = new Map();
  for (const repo of ctx.profile.code?.repos ?? []) {
    if (checkout && !ctx.state.repos[repo.name]?.checkedOutThisRun) {
      try {
        const info = ensureRepo(repo, ctx.cacheDir, { log: (m) => ctx.log(m) });
        ctx.state.repos[repo.name] = { commit: info.commit, dir: info.dir, checkedOutThisRun: true };
      } catch (err) {
        ctx.step("code-checkout", { batch: repo.name, errors: err.message.slice(0, 300) });
      }
    }
    const known = ctx.state.repos[repo.name];
    if (known) infos.set(repo.name, { repo, info: { commit: known.commit, dir: known.dir } });
  }
  ctx.state.codeCommits = [...infos.values()].map(({ repo, info }) => `${repo.name}@${info.commit.slice(0, 10)}`);
  return infos;
}

// ---------------------------------------------------------------- 4. match
export async function matchStage(ctx) {
  const { profile, cfg } = ctx;
  applyCodeReview(ctx);
  ctx.clearErrors("match");
  for (const r of ctx.stories) Object.assign(r, { candidates: [], matches: [], auditMatches: [], orphans: [] });
  const zephyr = await ctx.zephyr();
  const autoAccept = cfg.matching.autoAcceptConfidence ?? ["High"];
  // Module scope: the module's Zephyr folder and keywords point to its existing tests (linked or not).
  const scope = ctx.state.scope;
  const moduleHint = scope?.moduleFilter ? { path: scope.moduleFilter, zephyrFolder: profile.modules?.[scope.moduleFilter]?.zephyrFolder, rx: keywordRegex(scope.keywords ?? []) } : null;

  await promisePool(ctx.testable(), ctx.concurrency, async (r) => {
    const s = r.story;
    if (!r.expected.length) return;
    r.candidates = selectCandidates({ story: s, zephyr, expected: r.expected, limits: cfg.limits, module: s.module === moduleHint?.path ? moduleHint : null });
    if (!r.candidates.length) {
      r.matches = r.expected.map((e) => ({
        expectedId: e.id, verdict: "Missing", matchedKeys: [], confidence: "High", missingAspects: "", autoAccepted: false, decidedBy: "rule",
        reasoning: `No Zephyr case is linked to ${s.key} or its related stories, and no case under "${profile.zephyr.folderRoot}" shares at least two name keywords with it (${zephyr.inScopeCases.length} cases searched), so nothing can cover this scenario.`,
      }));
      ctx.step("match", { batch: s.key, in: r.expected.length, out: 0, notes: "No candidates: all scenarios Missing (0 tokens)." });
      return;
    }
    const withSteps = await promisePool(r.candidates, 4, async (c) => {
      const z = zephyr.byKey.get(c.key);
      let steps = [];
      try {
        steps = await getSteps({ profile, cacheDir: ctx.cacheDir, key: c.key, maxAgeHours: cfg.zephyr.stepsMaxAgeHours });
      } catch (err) {
        r.errors.push(`match: steps of ${c.key}: ${err.message.slice(0, 120)}`);
      }
      return {
        key: c.key, linked: c.linked, name: z.name, folder: z.folderPath, objective: truncate(z.objective, 400), precondition: truncate(z.precondition, 200),
        steps: steps.slice(0, 12).map((x) => ({ action: truncate(x.description, 200), expected: truncate(x.expectedResult, 200) })),
      };
    });
    // Skipped UCs (e.g. legacy parity, WCAG) go in as audit-only items so their cases aren't reported as orphans.
    // Off-topic UCs of a cross-cutting module's host page are not audited: their cases belong to that page.
    const audit = r.skippedUcs.filter((sk) => !sk.offTopic).map((sk) => ({ id: `${s.key}:${sk.uc}:audit`, title: sk.title, flow: "main", type: "audit", auditOnly: true, steps: [], expected: "" }));
    const expected = [...r.expected.map((e) => ({ id: e.id, title: e.title, flow: e.flow, type: e.type, steps: e.steps, expected: e.expected })), ...audit];
    const input = { story: { key: s.key, summary: s.summary }, expected, candidates: withSteps };
    try {
      const res = await ctx.llmRun("match", {
        cacheKey: `match-${s.key}`, fingerprint: input, prompt: JSON.stringify(input), jiraKeys: [s.key], module: s.module,
        itemsIn: expected.length, countOut: (o) => o.matches.length,
      });
      if (!res.output) { r.errors.push(`match: ${ctx.skipReason(res)}`); return; }
      const candidateKeys = new Set(r.candidates.map((c) => c.key));
      const linkedKeys = new Set(r.candidates.filter((c) => c.linked).map((c) => c.key));
      r.matches = r.expected.map((e) => {
        const m = res.output.matches.find((x) => x.expectedId === e.id);
        if (!m) return { expectedId: e.id, verdict: "Missing", matchedKeys: [], confidence: "Low", missingAspects: "", autoAccepted: false, decidedBy: "fallback", reasoning: "The match stage returned no verdict for this scenario; treated as Missing so it gets reviewed." };
        const matchedKeys = m.matchedKeys.filter((k) => candidateKeys.has(k));
        return { ...m, matchedKeys, autoAccepted: m.verdict === "Covered" && autoAccept.includes(m.confidence), decidedBy: "LLM" };
      });
      r.auditMatches = audit.map((a) => {
        const m = res.output.matches.find((x) => x.expectedId === a.id);
        return {
          expectedId: a.id, title: a.title, verdict: m?.verdict ?? "Missing", matchedKeys: (m?.matchedKeys ?? []).filter((k) => candidateKeys.has(k)),
          confidence: m?.confidence ?? "Low", missingAspects: m?.missingAspects ?? "", autoAccepted: false, decidedBy: "LLM (audit-only)",
          reasoning: m?.reasoning ?? "No verdict returned for this audit-only use case.",
        };
      });
      r.orphans = res.output.orphans.filter((o) => linkedKeys.has(o.key));
      const counts = ["Covered", "Partial", "Missing"].map((v) => `${v} ${r.matches.filter((m) => m.verdict === v).length}`).join(", ");
      ctx.step("match", { batch: s.key, in: expected.length, out: r.matches.length, notes: `${res.reused ? "cache; " : ""}${r.candidates.length} candidates (${linkedKeys.size} linked) → ${counts}; ${r.orphans.length} orphan(s).` });
    } catch (err) {
      r.errors.push(`match: failed: ${err.message.slice(0, 200)}`);
      ctx.step("match", { batch: s.key, in: expected.length, errors: err.message.slice(0, 300) });
    }
  });
  // A linked case matched by a sibling story in this run (e.g. the TESTING story of a dev story) is not an orphan.
  const matchedAnywhere = new Set(ctx.testable().flatMap((r) => [...r.matches, ...r.auditMatches].flatMap((m) => m.matchedKeys)));
  let cleared = 0;
  for (const r of ctx.testable()) {
    const before = r.orphans.length;
    r.orphans = r.orphans.filter((o) => !matchedAnywhere.has(o.key));
    cleared += before - r.orphans.length;
  }
  if (cleared) ctx.step("match", { batch: "(all)", notes: `${cleared} orphan(s) removed: they match scenarios of another story in this run.` });
  ctx.markDone("match");
}

// ---------------------------------------------------------------- 5. draft
export async function draftStage(ctx) {
  const { profile, cfg } = ctx;
  applyMatchReview(ctx);
  ctx.clearErrors("draft");
  for (const r of ctx.stories) r.gaps = [];
  const zephyr = await ctx.zephyr();
  const folderPath = new Map(zephyr.folders.map((f) => [f.id, f.path]));

  await promisePool(ctx.testable(), ctx.concurrency, async (r) => {
    const s = r.story;
    const byId = new Map(r.expected.map((e) => [e.id, e]));
    const gapMatches = r.matches.filter((m) => byId.has(m.expectedId) && (m.verdict !== "Covered" || (!m.autoAccepted && m.confidence === "Low")));
    if (!gapMatches.length) return;
    r.gaps = gapMatches.map((m) => {
      const e = byId.get(m.expectedId);
      const verdict = m.verdict === "Covered" ? "Unverified" : m.verdict;
      const why = m.verdict === "Covered" ? `Possibly covered by ${m.matchedKeys.join(", ")} but only with Low confidence. ${m.reasoning}` : m.reasoning;
      return {
        gapId: `GAP-${m.expectedId.replace(/:/g, "-")}`, expectedId: m.expectedId, scenario: e.title, source: e.source, type: e.type, verdict,
        matchedKeys: m.matchedKeys, missingAspects: m.missingAspects, codeReview: e.codeReview ?? "", suspectedBug: !!e.suspectedBug,
        reasoning: `${why}${m.missingAspects ? ` Missing: ${m.missingAspects}` : ""}${e.codeOnly ? " (Code-only scenario.)" : ""}`,
      };
    });
    const folders = folderCandidates({ story: s, candidates: r.candidates, zephyr, profile, limit: cfg.limits.folderCandidates });
    const partialCases = [...new Set(r.gaps.flatMap((g) => g.matchedKeys))].map((k) => ({ key: k, name: zephyr.byKey.get(k)?.name }));
    const chunks = chunk(r.gaps, cfg.batch.draft ?? 12);
    // Chunks keep each response well under the output limit; each chunk is cached on its own.
    for (const [i, gaps] of chunks.entries()) {
      const label = chunks.length > 1 ? `${s.key} part ${i + 1}/${chunks.length}` : s.key;
      const input = {
        story: { key: s.key, summary: s.summary, module: s.module, context: truncate(s.descriptionText, 3000) },
        gaps: gaps.map((g) => {
          const e = byId.get(g.expectedId);
          return { gapId: g.gapId, verdict: g.verdict, scenario: { title: e.title, flow: e.flow, type: e.type, steps: e.steps, expected: e.expected, source: e.source, codeOnly: e.codeOnly, codeReview: e.codeReview ?? "" }, matchedKeys: g.matchedKeys, missingAspects: g.missingAspects };
        }),
        partialCases: partialCases.filter((c) => gaps.some((g) => g.matchedKeys.includes(c.key))),
        folderCandidates: folders.map((f) => ({ id: f.id, path: f.path, why: f.why })),
        styleExamples: r.candidates.filter((c) => c.linked).slice(0, 5).map((c) => zephyr.byKey.get(c.key).name),
      };
      try {
        const res = await ctx.llmRun("draft", {
          cacheKey: `draft-${s.key}-${i}`, fingerprint: input, prompt: JSON.stringify(input), jiraKeys: [s.key], module: s.module,
          itemsIn: gaps.length, countOut: (o) => o.drafts.length,
        });
        for (const g of gaps) {
          const d = res.output?.drafts.find((x) => x.gapId === g.gapId);
          if (d) g.draft = { ...d, folderPath: folderPath.get(d.folderId) ?? "(folder id not found in Zephyr — choose one)" };
          else g.draftError = res.output ? "The draft stage returned nothing for this gap; write the case manually or re-run." : `No draft: ${ctx.skipReason(res)}.`;
        }
        ctx.step("draft", { batch: label, in: gaps.length, out: res.output?.drafts.length ?? 0, notes: res.reused ? "served from cache" : res.output ? `${folders.length} folder candidates` : ctx.skipReason(res) });
      } catch (err) {
        for (const g of gaps) g.draftError = `Draft failed: ${err.message.slice(0, 200)}`;
        ctx.step("draft", { batch: label, in: gaps.length, errors: err.message.slice(0, 300) });
      }
    }
  });
  ctx.markDone("draft");
}

// ---------------------------------------------------------------- 6. report
export async function reportStage(ctx, { out } = {}) {
  const { profile, cfg, state } = ctx;
  const zephyr = await ctx.zephyr();
  applyDraftsReview(ctx, new Map(zephyr.folders.map((f) => [f.id, f.path])));
  const scope = state.scope;
  const workbookPath = out ? path.resolve(out) : path.join(ctx.runDir, `coverage_${profile.name}_${scope.slug}.xlsx`);

  // Keep review work from an earlier build of the same workbook (decisions, notes, created keys).
  if (fs.existsSync(workbookPath)) {
    try {
      const prev = await readGapSheet(workbookPath);
      const byGap = new Map(prev.rows.map((row) => [row["Gap ID"], row]));
      let kept = 0;
      for (const r of ctx.stories) {
        for (const g of r.gaps) {
          const old = byGap.get(g.gapId);
          if (!old) continue;
          g.reviewDecision = old["Review decision"] || undefined;
          g.notes = old["Reviewer notes"] || undefined;
          g.createdKey = old["Created key"] || undefined;
          kept++;
        }
      }
      ctx.step("carry-over", { in: prev.rows.length, out: kept, notes: `Kept review decisions/notes/created keys for ${kept} gap(s) from the previous workbook.` });
    } catch (err) {
      ctx.step("carry-over", { errors: `Could not read previous workbook: ${err.message.slice(0, 200)}` });
    }
  }
  for (const r of ctx.stories) {
    if (r.errors.length) ctx.step("story-errors", { batch: r.story.key, errors: r.errors.join(" | ") });
    writeJson(path.join(ctx.runDir, "stories", `${r.story.key}.json`), { ...r, story: { ...r.story, descriptionHtml: undefined, links: undefined } });
  }

  const repoInfos = repoInfosFor(ctx, { checkout: false });
  const urls = {
    jira: (key) => ctx.jira.browseUrl(key),
    zephyr: (key) => caseUrl(profile, key),
    code: (repoName, filePath) => {
      const x = repoInfos.get(repoName);
      return x ? codeUrl(x.repo, x.info.commit, filePath) : null;
    },
  };
  const ordered = [...ctx.stories].sort((a, b) => a.story.module.localeCompare(b.story.module) || a.story.key.localeCompare(b.story.key));
  const handoffs = ctx.handoffs();
  const runInfo = {
    runAt: state.runAt, zephyrExportedAt: state.zephyrExportedAt ?? zephyr.exportedAt, codeCommits: state.codeCommits.join(", "),
    autoAccept: (cfg.matching.autoAcceptConfidence ?? ["High"]).join("/"),
    models: Object.entries(cfg.models).map(([k, v]) => `${k}=${v}`).join(", "),
  };
  ctx.markDone("report");
  ctx.save();
  let built;
  try {
    built = await buildWorkbook({ file: workbookPath, profile, scope, stories: ordered, zephyr, tokenRecords: ctx.tokenLog.records, runLog: state.runLog, runInfo, urls, handoffs });
  } catch (err) {
    if (err.code === "EBUSY") throw new Error(`${workbookPath} is open in another program (Excel?). Close it and re-run the report stage; nothing else needs repeating.`);
    throw err;
  }
  const summary = writeSummary({ ctx, built, workbookPath, handoffs });
  return { built, workbookPath, summaryPath: summary.file };
}

export const STAGE_FUNCS = { scope: scopeStage, requirements: requirementsStage, code: codeStage, match: matchStage, draft: draftStage, report: reportStage };
export { ROOT };
