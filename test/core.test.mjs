import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUcDoc, ucDocToScenarios, useCasesMentioning, focusRegex, splitByFocus } from "../scripts/lib/uc-parser.mjs";
import { triageByRules, deriveModule, detectAcSource, keywordRegex } from "../scripts/lib/triage-rules.mjs";
import { resolveScope, normalizeExtraStories } from "../scripts/lib/scope.mjs";
import { summarizeTokens, TokenLog } from "../scripts/lib/tokens.mjs";
import { findModules } from "../scripts/modules.mjs";
import { allowedTools, buildPrompt } from "../scripts/agents.mjs";
import { AGENTS, resolvePipeline, resolveEnvironment, uiTools, checkUiMode, playwrightArgs, blockWritesScript } from "../scripts/lib/pipeline.mjs";
import { validateGap } from "../scripts/lib/validate.mjs";
import vm from "node:vm";
import { RunContext } from "../scripts/lib/context.mjs";
import { applyRequirementsReview, applyCodeReview, applyContextReview, applyScoutReview, applyUiReview, applyZephyrReview, applyValidationReview, primaryStory } from "../scripts/lib/reviews.mjs";
import { renderSummary } from "../scripts/lib/report.mjs";
import { formatSteps, parseSteps, buildWorkbook, readGapSheet, layoutColumns, sheetKey, checkOutputConfig, COLUMNS } from "../scripts/lib/workbook.mjs";
import { outputFields, withExtraFields, extraFieldsPrompt, extraCells, pickExtras } from "../scripts/lib/output.mjs";
import { coverageJson } from "../scripts/lib/run-outputs.mjs";
import { loadLlmSchema } from "../scripts/lib/config.mjs";
import { selectCandidates } from "../scripts/lib/candidates.mjs";
import { segments, candidatePhrases, scoreKeyword, chooseKeywords, bridgeToCode, locateModule, dominantFolder } from "../scripts/lib/vocab.mjs";
import { loadProfile, resolveModule, loadModulesCatalog, loadRunConfig } from "../scripts/lib/config.mjs";
import { htmlToText, hash } from "../scripts/lib/util.mjs";
import { compactSource } from "../scripts/lib/code.mjs";
import { parseSource, buildIndex, moduleTokens, nameMatches, discoverImplementation, digestSource, usageSnippet, packWithinBudget, phraseWords, wordsMatch, keywordHits, sweepKeywords, mentionSnippet } from "../scripts/lib/discover.mjs";

const profile = loadProfile("avl");
const html = fs.readFileSync(new URL("./fixtures/AVLN-2398.rendered.html", import.meta.url), "utf8");
const story = (over = {}) => ({
  key: "AVLN-1", id: 1, summary: "Some feature", labels: [], epicKey: null, epicSummary: null,
  descriptionText: "", descriptionHtml: "", related: [], module: "m", updated: "2026-01-01", ...over,
});

test("parseUcDoc reads all use cases and flows of AVLN-2398", () => {
  const doc = parseUcDoc(html);
  assert.equal(doc.sourcePath, "gtms-vps/frontend/src/app/features/admin/import-job/");
  const shape = doc.useCases.map((u) => `${u.id}:${u.main.length}/${u.alternatives.length}/${u.exceptions.length}`);
  assert.deepEqual(shape, ["UC-01:5/2/1", "UC-02:5/2/0", "UC-03:2/1/0", "UC-04:4/3/1", "UC-05:3/0/1", "UC-06:4/1/1", "UC-07:6/0/1", "UC-08:4/0/0"]);
  assert.deepEqual(doc.useCases[0].alternatives[0], { id: "3a", label: "Cancel", text: "user closes the dialog before uploading → dialog closes, no job created, grid unchanged." });
});

test("ucDocToScenarios applies skip and consolidate rules from the profile", () => {
  const { scenarios, skipped } = ucDocToScenarios(parseUcDoc(html), { storyKey: "AVLN-2398", ...profile.jira.ucDoc });
  assert.deepEqual(skipped.map((s) => s.uc), ["UC-06", "UC-07"]);
  assert.equal(scenarios.length, 17);
  const perm = scenarios.find((s) => s.uc === "UC-08");
  assert.equal(perm.type, "permission");
  assert.equal(perm.steps.length, 4);
  assert.equal(scenarios.find((s) => s.id === "AVLN-2398:UC-02:main").type, "positive");
  assert.equal(scenarios.find((s) => s.id === "AVLN-2398:UC-04:exception-3b").type, "validation");
  assert.ok(scenarios.every((s) => s.reasoning.length > 20));
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
});

test("parseUcDoc returns null when there is no UC doc", () => {
  assert.equal(parseUcDoc("<p>AC: it works</p>"), null);
});

test("triage rules: epic, summary pattern, UC doc, AC text, undecided", () => {
  assert.equal(triageByRules(story({ epicKey: "AVLN-1933", epicSummary: "AVL Master Upgrades" }), profile).testable, false);
  const up = triageByRules(story({ summary: "AVL Upgrades S21" }), profile);
  assert.equal(up.testable, false);
  assert.match(up.reasoning, /Upgrades/);
  const uc = triageByRules(story({ descriptionText: htmlToText(html) }), profile);
  assert.equal(uc.testable, true);
  assert.equal(uc.acSource, "uc-doc");
  assert.equal(triageByRules(story({ descriptionText: "Blah.\nAC:\nEnvironments are upgraded." }), profile).acSource, "ac-text");
  const open = triageByRules(story({ summary: "Show ETA on stop panel", descriptionText: "x".repeat(100) }), profile);
  assert.equal(open.testable, null);
  assert.equal(open.acSource, "description");
  assert.equal(detectAcSource(story({ descriptionText: "short" }), profile.jira.acSources), "none");
});

test("deriveModule: feature path, then profile module, then epic", () => {
  assert.equal(deriveModule(story({ descriptionText: htmlToText(html) }), profile).module, "admin/import-job");
  assert.equal(deriveModule(story({ summary: "Fix bundle import retry" }), profile).moduleSource, "profile.modules");
  assert.equal(deriveModule(story({ epicKey: "AVLN-9", epicSummary: "Maps" }), profile).module, "epic:AVLN-9 Maps");
  assert.equal(deriveModule(story(), profile).module, "(no epic)");
});

test("resolveScope builds JQL for each scope kind", () => {
  assert.match(resolveScope("project", profile).jql, /^project = AVLN AND issuetype in \("Story"\)/);
  assert.match(resolveScope("epic:AVLN-2574", profile).jql, /parent = AVLN-2574/);
  assert.match(resolveScope("sprint:active", profile).jql, /openSprints\(\)/);
  assert.match(resolveScope("issues:AVLN-1, AVLN-2", profile).jql, /^key in \(AVLN-1, AVLN-2\)/);
  const mod = resolveScope("module:admin/import-job", profile);
  assert.equal(mod.moduleFilter, "admin/import-job");
  assert.match(resolveScope("project", profile, { since: "2026-10-01" }).jql, /updated >= "2026-10-01"/);
  assert.throws(() => resolveScope("bogus:1", profile), /Unknown scope kind/);
  assert.throws(() => resolveScope("issues:not-a-key", profile), /expects Jira keys/);
});

test("summarizeTokens splits multi-story calls, ignores reused calls and separates agents", () => {
  const s = summarizeTokens([
    { stage: "triage", model: "h", jiraKeys: ["A", "B"], input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
    { stage: "match", model: "o", jiraKeys: ["A"], input_tokens: 10, output_tokens: 10, cache_read_tokens: 80, cache_creation_tokens: 0 },
    { stage: "match", model: "o", jiraKeys: ["B"], reused: true, input_tokens: 999, output_tokens: 999 },
    { stage: "agent:module-scout", model: "s", jiraKeys: [], input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
  ]);
  assert.equal(s.total.total_tokens, 310);
  assert.equal(s.pipeline.total_tokens, 300);
  assert.equal(s.agents.total_tokens, 10);
  assert.equal(s.total.reused, 1);
  assert.equal(s.byStory.A.total_tokens, 200);
  assert.equal(s.byStory.B.total_tokens, 100);
  assert.equal("cost_usd" in s.total, false);
  assert.ok(Math.abs(s.total.cache_hit_ratio - 80 / 195) < 1e-9);
});

test("TokenLog never stores money", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cov-")), "t.jsonl");
  const log = new TokenLog(file);
  log.add({ stage: "x", input_tokens: 1, cost_usd: 5 });
  assert.equal(fs.readFileSync(file, "utf8").includes("cost"), false);
  assert.equal(new TokenLog(file).records.length, 1); // a later process sees earlier records
});

test("module scope with keywords: JQL text search, keyword assignment, fallback keyword", () => {
  // A module that is not in modules.json: given keywords only, folder name as fallback.
  const plain = resolveScope("module:dispatch/trip", profile, { keywords: "trip list, tms.dispatch.trip" });
  assert.match(plain.jql, /text ~ "\\"trip list\\"" OR text ~ "\\"tms.dispatch.trip\\""/);
  assert.deepEqual(plain.keywords, ["trip list", "tms.dispatch.trip"]);
  assert.deepEqual(resolveScope("module:dispatch/trip", profile).keywords, ["trip"]);
  assert.equal(plain.moduleConf.name, null);
  const override = { module: "admin/conductor", keywords: ["conductor page"] };
  assert.equal(deriveModule(story({ summary: "Fix the Conductor-page filter" }), profile, override).moduleSource, "keywords");
  assert.equal(deriveModule(story({ summary: "Setup Conductor environment" }), profile, override).moduleSource, "none");
  // A UC doc naming another feature path wins over keywords.
  assert.equal(deriveModule(story({ summary: "conductor page", descriptionText: htmlToText(html) }), profile, override).module, "admin/import-job");
  const rx = keywordRegex(["import job"]);
  for (const text of ["Import-Job page", "the importjob list", "Import Job"]) assert.ok(rx.test(text), text);
  assert.ok(!rx.test("important jobs"));
});

function tempRun(stories) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-run-"));
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    profile: "avl", runAt: "t", scope: resolveScope("issues:AVLN-1", profile), stories, runLog: [], stagesDone: ["scope", "requirements", "code", "match"], codeCommits: [], repos: {}, budgetHit: null,
  }));
  fs.mkdirSync(path.join(runDir, "review"));
  return { runDir, ctx: () => RunContext.load(runDir) };
}

test("agent reviews merge into state, record the agent and are safe to re-apply", () => {
  const e = (id, extra = {}) => ({ id, storyKey: "AVLN-1", source: "story", flow: "main", title: id, type: "positive", steps: [], expected: "", reasoning: "orig", ...extra });
  const { runDir, ctx: load } = tempRun([
    { story: story({ key: "AVLN-1" }), triage: { testable: true, decidedBy: "rule", reasoning: "r" }, expected: [e("AVLN-1:S01"), e("AVLN-1:S02"), e("AVLN-1:CODE-01", { codeOnly: true })], matches: [{ expectedId: "AVLN-1:S01", verdict: "Partial", matchedKeys: ["QA-T1"], confidence: "Medium", reasoning: "p" }], errors: [] },
    { story: story({ key: "AVLN-2", id: 2 }), triage: { testable: true, decidedBy: "rule", reasoning: "r" }, expected: [], matches: [], errors: [] },
  ]);
  const write = (k, v) => fs.writeFileSync(path.join(runDir, "review", `${k}.json`), JSON.stringify(v));
  write("scout", { dropStories: [{ key: "AVLN-2", reasoning: "customer project" }] });
  write("requirements", { dropScenarios: [{ id: "AVLN-1:S02", reasoning: "duplicate of S01" }], addScenarios: [{ storyKey: "AVLN-1", title: "New one", flow: "exception", type: "validation", steps: ["x"], expected: "y", evidence: "AC: y", reasoning: "AC 3 untested" }], flags: [{ key: "AVLN-1", issue: "AC 2 is vague" }] });
  write("code", { decisions: [{ id: "AVLN-1:CODE-01", decision: "needs-confirmation", suspectedBug: true, reasoning: "no permission check" }] });
  write("context", { overrides: [{ expectedId: "AVLN-1:S01", verdict: "Covered", matchedKeys: ["QA-T1"], confidence: "High", reasoning: "QA-T1 step 4" }] });
  const ctx = load();
  for (let i = 0; i < 2; i++) { applyScoutReview(ctx); applyRequirementsReview(ctx); applyCodeReview(ctx); applyContextReview(ctx); }
  assert.equal(ctx.R("AVLN-2").dropped.by, "agent:module-scout");
  assert.deepEqual(ctx.testable().map((r) => r.story.key), ["AVLN-1"]);
  const r = ctx.R("AVLN-1");
  assert.deepEqual(r.expected.map((x) => x.id), ["AVLN-1:S01", "AVLN-1:CODE-01", "AVLN-1:A01"]);
  assert.equal(r.droppedScenarios.length, 1);
  assert.equal(r.flags.length, 1);
  assert.equal(r.expected[1].codeReview, "needs PO confirmation");
  assert.equal(r.expected[1].suspectedBug, true);
  assert.equal(r.matches[0].verdict, "Covered");
  assert.equal(r.matches[0].decidedBy, "agent:context-builder");
  assert.equal(r.matches[0].autoAccepted, true);
  assert.equal(r.matches[0].reasoning.match(/Agent context-builder/g).length, 1);
  write("code", { decisions: [{ id: "AVLN-1:CODE-01", decision: "maybe", reasoning: "x" }] });
  assert.throws(() => applyCodeReview(ctx), /does not match schema/);
});

test("summary.md and workbook contain tokens but no money", async () => {
  const { ctx: load } = tempRun(minimalRun().stories);
  const ctx = load();
  ctx.tokenLog.add({ stage: "match", model: "m", jiraKeys: ["AVLN-1"], input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 1 });
  const { text } = renderSummary({ ctx, built: { counts: { expected: 1 } }, workbookPath: "w.xlsx", handoffs: [{ order: 1, agent: "module-scout", status: "ok", findings: ["picked x"], tokens: 10 }] });
  assert.match(text, /Tokens used/);
  assert.match(text, /picked x/);
  assert.doesNotMatch(text, /cost|usd|\$/i);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cov-")), "w.xlsx");
  await buildWorkbook({ file, ...minimalRun(), tokenRecords: ctx.tokenLog.records, handoffs: [{ agent: "module-scout", status: "ok", findings: ["picked x"], tokens: 10 }] });
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const cells = [];
  wb.eachSheet((ws) => ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.text ?? c.value)))));
  assert.ok(!cells.some((c) => /\bcost\b|usd/i.test(c)), cells.find((c) => /\bcost\b|usd/i.test(c)));
  assert.ok(cells.some((c) => c.includes("Agent sessions")));
});

test("modules.json: names/aliases resolve, keywords merge, include/exclude stories", () => {
  assert.equal(resolveModule(profile, "Bundle Import").path, "admin/import-job");
  assert.equal(resolveModule(profile, "conductors").path, "admin/conductor");
  assert.equal(resolveModule(profile, "admin/conductor").name, "conductor");
  assert.equal(resolveModule(profile, "job"), null);
  const s = resolveScope("module:import job", profile, { keywords: "data bundle" });
  assert.equal(s.value, "admin/import-job");
  assert.equal(s.moduleFilter, "admin/import-job");
  assert.ok(s.keywords.includes("tms.admin.importjob") && s.keywords.includes("data bundle"));
  assert.match(s.jql, /OR key in \(AVLN-2398\)/);
  assert.deepEqual(resolveScope("module:conductor", profile).moduleConf.excludeStories.slice(0, 2), ["AVLN-282", "AVLN-284"]);
  // Catalogue keywords also assign older stories in non-module scopes.
  assert.equal(deriveModule(story({ summary: "Bundle import retry fails" }), profile).module, "admin/import-job");
});

test("modules.json is validated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m-"));
  fs.writeFileSync(path.join(dir, "modules.json"), JSON.stringify({ modules: { x: { keywords: ["a"] } } }));
  assert.throws(() => loadModulesCatalog(dir), /must have required property 'path'/);
  fs.writeFileSync(path.join(dir, "modules.json"), JSON.stringify({ modules: { x: { path: "a/b", excludeStories: ["nope"] } } }));
  assert.throws(() => loadModulesCatalog(dir), /must match pattern/);
});

test("module ranking: plain words, plurals and compact names", () => {
  const mods = ["admin/import-job", "export-job", "incident", "admin/incident-template", "admin/user", "admin", "admin/conductor"].map((p) => ({ path: p }));
  assert.equal(findModules("import job", mods)[0].path, "admin/import-job");
  assert.equal(findModules("importjob", mods)[0].path, "admin/import-job");
  assert.equal(findModules("incidents", mods)[0].path, "incident");
  assert.equal(findModules("users", mods)[0].path, "admin/user");
  assert.deepEqual(findModules("zzz", mods), []);
});

test("agent allowlists: own stage only, review file only, Zephyr read-only, UI by mode", () => {
  const byName = Object.fromEntries(Object.entries(AGENTS).map(([name, def]) => [name, allowedTools({ name, ...def }, "runs/avl/x")]));
  assert.ok(byName["module-scout"].includes("Bash(node scripts/run.mjs --stage scope *)"));
  assert.ok(!byName["module-scout"].some((t) => t.includes("--stage context")));
  assert.ok(byName["context-builder"].includes("Edit(./runs/avl/x/review/*.json)"));
  assert.ok(!Object.values(byName).flat().some((t) => /create_test_case|update_test|link_test_case/.test(t)));
  assert.ok(!byName.reporter.some((t) => t.startsWith("Edit")));
  for (const n of ["requirements-analyst", "code-analyst", "ui-explorer", "zephyr-explorer", "context-builder", "test-designer", "coverage-validator"]) {
    assert.ok(!byName[n].some((t) => t.includes("--stage")), n);
  }
  assert.ok(byName["ui-explorer"].includes("mcp__playwright__browser_click"));
  assert.ok(!Object.entries(byName).some(([n, tools]) => n !== "ui-explorer" && tools.some((t) => t.startsWith("mcp__playwright"))));
  const observe = allowedTools({ name: "ui-explorer", ...AGENTS["ui-explorer"] }, "runs/avl/x", { uiMode: "observe" });
  assert.ok(observe.includes("mcp__playwright__browser_snapshot") && !observe.includes("mcp__playwright__browser_click"));
  const prompt = buildPrompt({ agent: { name: "context-builder", ...AGENTS["context-builder"] }, rel: "runs/avl/x", profile, moduleWords: "import job", previous: [{ agent: "code-analyst", status: "ok", findings: ["CODE-14 suspected bug"], forwardNotes: "check T10870" }] });
  assert.match(prompt, /CODE-14 suspected bug/);
  assert.match(prompt, /Forwarded to you: check T10870/);
  assert.match(prompt, /context stage has ALREADY been run/);
  const uiPrompt = buildPrompt({ agent: { name: "ui-explorer", ...AGENTS["ui-explorer"] }, rel: "runs/avl/x", profile, moduleWords: "import job", previous: [], ui: { envName: "test", baseUrl: "https://t.example", mode: "read-only", maxPages: 5, outputDir: "runs/avl/x/ui" } });
  assert.match(uiPrompt, /no script stage/);
  assert.match(uiPrompt, /blocks every POST/);
  assert.match(uiPrompt, /at most 5 distinct pages/);
});

test("config.yaml: the shipped pipeline is valid; bad pipelines are refused", () => {
  const cfg = loadRunConfig();
  const phases = resolvePipeline(cfg);
  assert.deepEqual(phases.map((p) => p.phase), ["scope", "explore", "context", "design", "validate", "report"]);
  assert.deepEqual(phases[1].agents.map((x) => x.name), ["requirements-analyst", "code-analyst", "ui-explorer", "zephyr-explorer"]);
  const base = (pipeline) => ({ pipeline });
  const ok = [{ phase: "scope", agents: ["module-scout"] }, { phase: "explore", agents: ["requirements-analyst"] }, { phase: "context", agents: ["context-builder"] }];
  assert.equal(resolvePipeline(base(ok)).length, 3);
  assert.throws(() => resolvePipeline(base([...ok, { phase: "design", agents: ["nobody"] }])), /unknown agent 'nobody'/);
  assert.throws(() => resolvePipeline(base([...ok, { phase: "design", agents: ["reporter"] }])), /belongs in phase 'report'/);
  assert.throws(() => resolvePipeline(base(ok.slice(0, 2))), /required agent\(s\) missing.*context-builder/);
  assert.throws(() => resolvePipeline(base([...ok, { phase: "context", agents: [] }])), /listed twice/);
});

test("UI environment and modes: full needs allowWrites; Playwright stays on the environment's origin", () => {
  const cfg = { environment: "test", environments: { test: { uiBaseUrl: "https://avl-test.example/app/", login: { method: "none" } }, sandbox: { uiBaseUrl: "https://sb.example", allowWrites: true } } };
  const env = resolveEnvironment(cfg);
  assert.equal(env.name, "test");
  assert.throws(() => resolveEnvironment(cfg, "prod"), /environment 'prod' not found/);
  assert.throws(() => checkUiMode("full", env), /allowWrites/);
  checkUiMode("full", resolveEnvironment(cfg, "sandbox"));
  assert.throws(() => uiTools("wild"), /must be one of/);
  for (const mode of ["observe", "read-only", "full"]) {
    assert.ok(!uiTools(mode).some((t) => /evaluate|run_code|file_upload|route|cookie|storage|localstorage/.test(t)), mode);
  }
  const args = playwrightArgs({ pkg: "@playwright/mcp@0.0.83", env, outputDir: "out", storageStatePath: "s.json", initScriptPath: "b.js" });
  assert.deepEqual(args.slice(args.indexOf("--allowed-origins"), args.indexOf("--allowed-origins") + 2), ["--allowed-origins", "https://avl-test.example"]);
  assert.ok(args.includes("--isolated") && args.includes("--headless"));
  assert.equal(args[args.indexOf("--storage-state") + 1], "s.json");
  assert.equal(args[args.indexOf("--init-script") + 1], "b.js");
});

test("read-only init script blocks writes from the page but lets reads and allowed URLs through", async () => {
  class XHR { open() {} send() { this.sent = true; } abort() { this.aborted = true; } dispatchEvent() {} }
  const listeners = [];
  const sandbox = {
    window: { fetch: async (url) => `ok ${url}` }, XMLHttpRequest: XHR, ProgressEvent: class {}, navigator: { sendBeacon: () => true },
    document: { addEventListener: (type, fn) => listeners.push(fn) }, console: { warn() {} },
  };
  vm.runInNewContext(blockWritesScript(["/api/grid/search$"]), sandbox);
  const w = sandbox.window;
  assert.equal(await w.fetch("/api/jobs"), "ok /api/jobs");
  await assert.rejects(w.fetch("/api/jobs", { method: "POST" }), /read-only/);
  assert.equal(await w.fetch("/api/grid/search", { method: "post" }), "ok /api/grid/search");
  const x = new XHR();
  x.open("DELETE", "/api/jobs/1");
  x.send();
  assert.ok(x.aborted && !x.sent);
  assert.equal(sandbox.navigator.sendBeacon("/api/log"), false);
  let prevented = false;
  listeners[0]({ target: { method: "post", action: "/save" }, preventDefault: () => (prevented = true), stopImmediatePropagation() {} });
  assert.ok(prevented);
  assert.deepEqual([...w.__blockedWrites], ["POST /api/jobs", "DELETE /api/jobs/1", "POST /api/log", "POST /save"]);
  assert.throws(() => blockWritesScript(["("]), /Invalid regular expression/);
});

test("scope: status-category filter, except for named stories and includeStories", () => {
  const done = resolveScope("module:admin/import-job", profile, { statusCategories: ["Done"] });
  assert.match(done.jql, /statusCategory in \("Done"\)\) OR key in \(AVLN-2398\)/);
  assert.equal(done.baselineKey, "module-admin-import-job");
  assert.doesNotMatch(resolveScope("issues:AVLN-1", profile, { statusCategories: ["Done"] }).jql, /statusCategory/);
  assert.doesNotMatch(resolveScope("project", profile).jql, /statusCategory/);
});

test("validateGap: undrafted, duplicate by name, extend target ignored", () => {
  const cases = [{ key: "QA-T1", name: "AVL - Import Job - Upload rejected bundle shows error" }, { key: "QA-T2", name: "Unrelated grid column order" }];
  assert.equal(validateGap({ gapId: "G1", draftError: "timeout" }, cases).verdict, "undrafted");
  const dup = validateGap({ gapId: "G2", draft: { name: "Import Job - Upload rejected bundle shows error" } }, cases);
  assert.equal(dup.verdict, "possible-duplicate");
  assert.deepEqual(dup.duplicateOf, ["QA-T1"]);
  assert.equal(validateGap({ gapId: "G3", draft: { name: "Import Job - Upload rejected bundle shows error", action: "extend", extendKey: "QA-T1" } }, cases).verdict, "ok");
  assert.equal(validateGap({ gapId: "G4", draft: { name: "Export stops grid timetable" } }, cases).verdict, "ok");
});

test("UI, Zephyr and validation reviews merge into state and are safe to re-apply", () => {
  const e = (id, extra = {}) => ({ id, storyKey: "AVLN-1", source: "story", flow: "main", title: id, type: "positive", steps: [], expected: "", reasoning: "orig", ...extra });
  const { runDir, ctx: load } = tempRun([
    { story: story({ key: "AVLN-1" }), triage: { testable: true, acSource: "uc-doc", decidedBy: "rule", reasoning: "r" }, expected: [e("AVLN-1:S01")], candidates: [{ key: "QA-T1", why: "linked", linked: true }, { key: "QA-T2", why: "kw", linked: false }], matches: [],
      gaps: [{ gapId: "GAP-1", draft: { name: "Dup", suggestedDecision: "Approve", decisionReasoning: "clear" } }], errors: [] },
    { story: story({ key: "AVLN-3", id: 3, updated: "2026-09-01" }), triage: { testable: true, acSource: "ac-text", decidedBy: "rule", reasoning: "r" }, expected: [], matches: [], errors: [] },
  ]);
  const write = (k, v) => fs.writeFileSync(path.join(runDir, "review", `${k}.json`), JSON.stringify(v));
  write("ui", {
    scenarios: [{ title: "Empty grid shows 'No jobs'", flow: "alt", type: "positive", steps: ["Open Import Job with no jobs"], expected: "Message 'No jobs'", evidence: { url: "https://t/import-job", element: "No jobs" }, reasoning: "seen on the empty list" }],
    observations: [{ id: "AVLN-1:S01", status: "different", reasoning: "button is labelled Upload, not Add" }],
  });
  write("zephyr", { candidates: [{ storyKey: "AVLN-1", add: ["QA-T3", "QA-T404"], remove: ["QA-T1", "QA-T2"], reasoning: "found by search" }] });
  write("validation", { results: [{ gapId: "GAP-1", verdict: "duplicate", duplicateOf: ["QA-T3"], reasoning: "QA-T3 steps 2-4 do the same" }] });
  const ctx = load();
  const zephyr = { byKey: new Map(["QA-T1", "QA-T2", "QA-T3"].map((k) => [k, { key: k }])) };
  for (let i = 0; i < 2; i++) { applyUiReview(ctx); applyZephyrReview(ctx, zephyr); applyValidationReview(ctx); }
  const r = ctx.R("AVLN-1");
  assert.equal(primaryStory(ctx.testable()).story.key, "AVLN-1"); // owns the UC doc
  assert.deepEqual(r.expected.map((x) => [x.id, x.source]), [["AVLN-1:S01", "story"], ["AVLN-1:UI-01", "ui"]]);
  assert.match(r.expected[0].uiCheck, /^different: button is labelled Upload/);
  assert.match(r.expected[1].evidence, /^UI https:\/\/t\/import-job — No jobs/);
  assert.deepEqual(r.candidates.map((c) => c.key), ["QA-T1", "QA-T3"]); // linked QA-T1 stays, unknown QA-T404 ignored
  assert.equal(r.gaps[0].validation.verdict, "duplicate");
  assert.equal(r.gaps[0].draft.suggestedDecision, "Reject");
  assert.equal(r.gaps[0].draft.decisionReasoning.match(/Agent coverage-validator/g).length, 1);
});

test("steps survive the Excel text round-trip, including edits", () => {
  const steps = [
    { description: "Open Admin → Import Job", testData: "", expectedResult: "The list shows" },
    { description: "Click Add", testData: "a valid ZIP", expectedResult: "Upload starts => progress shown" },
  ];
  assert.deepEqual(parseSteps(formatSteps(steps)), steps);
  assert.deepEqual(parseSteps("1. Do a thing => It works\n2. Another => Fine"), [
    { description: "Do a thing", testData: "", expectedResult: "It works" },
    { description: "Another", testData: "", expectedResult: "Fine" },
  ]);
});

test("selectCandidates puts linked cases first and finds keyword matches", () => {
  const cases = [
    { key: "QA-T1", name: "AVL - Admin - Import Job - Upload a bundle", folderId: 9, folderPath: "Ridango > AVL > Bundle Import", issueIds: [1] },
    { key: "QA-T2", name: "AVL - Admin - Import Job - Reimport bundle", folderId: 9, folderPath: "Ridango > AVL > Bundle Import", issueIds: [] },
    { key: "QA-T3", name: "Reimport bundle import job logs export", folderId: 5, folderPath: "Ridango > AVL > Other", issueIds: [] },
    { key: "QA-T4", name: "Unrelated thing", folderId: 5, folderPath: "Ridango > AVL > Other", issueIds: [] },
  ];
  const zephyr = { byKey: new Map(cases.map((c) => [c.key, c])), inScopeCases: cases, issueIndex: new Map([[1, ["QA-T1"]]]) };
  const got = selectCandidates({
    story: story({ id: 1, summary: "Import job reimport", module: "admin/import-job" }), zephyr,
    expected: [{ title: "Reimport bundle logs" }], limits: { candidateCasesPerStory: 10, keywordCandidates: 5 },
  });
  assert.deepEqual(got.map((c) => [c.key, c.linked]), [["QA-T1", true], ["QA-T2", false], ["QA-T3", false]]);
});

test("compactSource drops imports and blank runs", () => {
  assert.equal(compactSource("import { a } from 'b';\nimport {\n  c\n} from 'd';\n\n\nclass X {}\n"), "class X {}");
});

test("hash is stable regardless of key order", () => {
  assert.equal(hash({ a: 1, b: [1, { c: 2, d: 3 }] }), hash({ b: [1, { d: 3, c: 2 }], a: 1 }));
});

const minimalRun = (overrides = {}) => ({
  profile, scope: resolveScope("issues:AVLN-1", profile),
  stories: [{
    story: story({ status: "Done", created: "2026-01-01", module: "m" }),
    triage: { testable: true, decidedBy: "rule", rule: "ac-text", acSource: "ac-text", reasoning: "Has AC." },
    linkCheck: { linkedKeys: [], result: "No tests linked — guaranteed gap", reasoning: "No case links to AVLN-1." },
    expected: [{ id: "AVLN-1:S01", source: "story", flow: "main", title: "It works", type: "positive", steps: ["Do"], expected: "Works", evidence: "AC: works", reasoning: "From AC." }],
    candidates: [], orphans: [],
    matches: [{ expectedId: "AVLN-1:S01", verdict: "Missing", matchedKeys: [], confidence: "High", missingAspects: "", autoAccepted: false, decidedBy: "rule", reasoning: "Nothing found." }],
    gaps: [{
      gapId: "GAP-AVLN-1-S01", expectedId: "AVLN-1:S01", scenario: "It works", source: "story", type: "positive", verdict: "Missing", matchedKeys: [], reasoning: "Nothing found.",
      draft: { action: "create", name: "AVL - X - It works", objective: "o", precondition: "p", priority: "High", priorityReasoning: "main", labels: ["AVL_X"], folderId: 7, folderPath: "R > AVL > X", folderReasoning: "f", steps: [{ description: "Do", testData: "", expectedResult: "Works" }], bdd: "", suggestedDecision: "Approve", decisionReasoning: "clear gap" },
    }],
    ...overrides,
  }],
  zephyr: { byKey: new Map(), folders: [] },
  tokenRecords: [{ stage: "match", model: "m", jiraKeys: ["AVLN-1"], input_tokens: 5, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.01 }],
  runLog: [{ step: "scope", at: "t", notes: "n" }],
  runInfo: { runAt: "t", zephyrExportedAt: "t", codeCommits: "", autoAccept: "High", models: "" },
  urls: { jira: (k) => `https://x/browse/${k}`, zephyr: (k) => `https://x/${k}`, code: () => null },
});

test("buildWorkbook writes all sheets, prefills the review decision and reads back", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cov-")), "w.xlsx");
  const out = await buildWorkbook({ file, ...minimalRun() });
  assert.deepEqual(out.sheets, ["Summary", "1_Module_Context", "2_Story_Triage", "3_Link_Check", "4_Expected_Scenarios", "5_UI_Exploration", "6_Zephyr_Cases", "7_Matching", "8_Test_Design", "9_Gaps", "10_Orphan_Zephyr", "11_Agents", "12_Agent_Reviews", "13_Run_Log", "14_Token_Usage"]);
  const back = await readGapSheet(file);
  assert.equal(back.profileName, "avl");
  assert.equal(back.rows[0]["Review decision"], "Approve");
  assert.equal(back.rows[0]["Story issue id"], "1");
  assert.deepEqual(parseSteps(back.rows[0]["Steps (n. action [data: x] => expected)"]), [{ description: "Do", testData: "", expectedResult: "Works" }]);
});

test("buildWorkbook refuses rows without reasoning", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cov-")), "w.xlsx");
  const run = minimalRun();
  run.stories[0].triage.reasoning = "";
  await assert.rejects(buildWorkbook({ file, ...run }), /without reasoning[\s\S]*2_Story_Triage: AVLN-1/);
});

test("readGapSheet still reads older workbooks whose review sheet is 6_Gaps", async () => {
  const { default: ExcelJS } = await import("exceljs");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cov-")), "old.xlsx");
  const wb = new ExcelJS.Workbook();
  wb.subject = "avl";
  const ws = wb.addWorksheet("6_Gaps");
  ws.addRow(["Gap ID", "Review decision"]);
  ws.addRow(["GAP-1", "Reject"]);
  await wb.xlsx.writeFile(file);
  const back = await readGapSheet(file);
  assert.deepEqual([back.ws.name, back.rows[0]["Gap ID"], back.rows[0]["Review decision"]], ["6_Gaps", "GAP-1", "Reject"]);
});

// A miniature of the AVL export wiring: page → client-linked service → job model ← handlers (one per grid).
const exportRepo = [
  ["fe/features/export-job/page.ts", "import { ExportJobService } from 'x';\nexport class ExportJobPage { svc = inject(ExportJobService); }"],
  ["fe/services/export-job.service.ts", "export class ExportJobService { run(m: ExportTimedJobModul) { return ExportServiceClient; } }"],
  ["fe/features/asset/asset-page.ts", "export class AssetPage {\n  private readonly exportService = inject(ExportJobService);\n  colDefs = DateHelper.x;\n  go() {\n    this.exportService.run({\n      exportModule: ExportTimedJobModul.ASSET,\n    });\n  }\n}"],
  ["be/rest/ExportService.java", "public class ExportService extends RestBase { ExportTimedJob job; DateHelper d; ExportHandler h; }"],
  ["be/model/ExportTimedJob.java", "public class ExportTimedJob { ExportTimedJobModul modul; }"],
  ["be/model/ExportTimedJobModul.java", "public enum ExportTimedJobModul { ASSET, TRIP }"],
  ["be/handler/ExportHandlerBase.java", "public abstract class ExportHandlerBase { ExportXlsxWriter w; ExportTimedJob j; }"],
  ["be/handler/ExportXlsxWriter.java", "public class ExportXlsxWriter { }"],
  ["be/handler/ExportHandler.java", "public class ExportHandler extends ExportHandlerBase { ExportAssetHandler a; }"],
  ["be/handler/ExportAssetHandler.java", "public class ExportAssetHandler extends ExportHandlerBase {\n  headers.add(new ExportColumn(\"registrationNumber\", REG));\n  AssetDao dao;\n}"],
  ["be/handler/ExportTripHandler.java", "public class ExportTripHandler extends ExportHandlerBase { TripDao dao; }"],
  ["be/dal/AssetDao.java", "public class AssetDao { }"],
  ["be/timers/ExportsRemoveTimer.java", "public class ExportsRemoveTimer extends TimeScheduledJob { ExportTimedJob j; }"],
  ["be/gtfs/GtfsExportFeedHandler.java", "public class GtfsExportFeedHandler { GtfsFeed f; }"],
  ["be/core/RestBase.java", "public class RestBase { }"],
  ["be/core/DateHelper.java", "public class DateHelper { }"],
  ...Array.from({ length: 10 }, (_, i) => [`be/x${i}/Other${i}.java`, `public class Other${i} extends RestBase { DateHelper d; }`]),
];

test("parseSource reads declarations, parents and references of Java, TS and AngularJS", () => {
  const java = parseSource("A.java", "// uses Ignored\npublic class ExportAssetHandler extends ExportHandlerBase<Row, Map<A,B>> implements Closeable {\n String s = \"NotAType\"; AssetDao dao; }");
  assert.deepEqual(java.declares, ["ExportAssetHandler"]);
  assert.deepEqual(java.parents, ["ExportHandlerBase", "Closeable"]);
  assert.ok(java.refs.includes("AssetDao") && !java.refs.includes("Ignored") && !java.refs.includes("NotAType"));
  assert.deepEqual(parseSource("a.ts", "export interface ExportOptions {}\nexport const ExportFormatterType = {};").declares, ["ExportOptions", "ExportFormatterType"]);
  assert.deepEqual(parseSource("a.js", "angular.module('m').service('ExportJobService', function ($http) {});").declares, ["ExportJobService"]);
});

test("moduleTokens and nameMatches use distinctive words only", () => {
  assert.deepEqual(moduleTokens("admin/export-job"), ["export"]);
  assert.ok(nameMatches("ExportsRemoveTimer", ["export"]));
  assert.ok(nameMatches("export-job.service", ["export"]));
  assert.ok(!nameMatches("ImportJobService", ["export"]));
});

test("discoverImplementation follows references, finds the handler family and callers, skips helpers and look-alikes", () => {
  const index = buildIndex(exportRepo.map(([p, c]) => parseSource(p, c)));
  const found = discoverImplementation(index, {
    seeds: ["fe/features/export-job/page.ts"], links: [{ path: "be/rest/ExportService.java", via: "backend link" }],
    tokens: ["export"], maxSpread: 3, familyMin: 2,
  });
  const role = (p) => found.get(p)?.role;
  assert.equal(role("fe/services/export-job.service.ts"), "core");
  assert.equal(role("be/model/ExportTimedJob.java"), "core");
  assert.equal(role("be/handler/ExportHandlerBase.java"), "core");
  assert.equal(role("be/handler/ExportXlsxWriter.java"), "core");
  assert.equal(role("be/timers/ExportsRemoveTimer.java"), "core");
  assert.equal(role("be/handler/ExportAssetHandler.java"), "variant");
  assert.equal(role("be/handler/ExportTripHandler.java"), "variant");
  assert.equal(role("be/handler/ExportHandler.java"), "variant");
  assert.equal(role("fe/features/asset/asset-page.ts"), "caller");
  assert.ok(!found.has("be/dal/AssetDao.java"), "variants are not expanded");
  assert.ok(!found.has("be/core/DateHelper.java"), "widely used helper skipped");
  assert.ok(!found.has("be/gtfs/GtfsExportFeedHandler.java"), "same word, unrelated code");
});

test("digestSource and usageSnippet keep what a tester needs", () => {
  const digest = digestSource("public class ExportAssetHandler extends ExportHandlerBase {\n  private int n = 0;\n  logger.info(\"start\");\n  headers.add(new ExportColumn(\"vin\", VIN));\n  @Override\n  public void write(Row r) {\n    n++;\n  }\n}");
  assert.equal(digest, "public class ExportAssetHandler extends ExportHandlerBase {\nheaders.add(new ExportColumn(\"vin\", VIN));\n@Override\npublic void write(Row r) {");
  const usage = usageSnippet(exportRepo[2][1], ["ExportJobService", "ExportTimedJobModul"]);
  assert.match(usage, /this\.exportService\.run\(\{\nexportModule: ExportTimedJobModul\.ASSET,/);
  assert.ok(!usage.includes("DateHelper"));
});

test("packWithinBudget gives full source by priority, digests the rest and never cuts a file", () => {
  const items = [
    { path: "engine", role: "core", priority: 3, full: "E".repeat(50), small: "e".repeat(10), via: "" },
    { path: "variant", role: "variant", priority: 6, full: null, small: "v".repeat(10), via: "" },
    { path: "caller", role: "caller", priority: 7, full: null, small: "c".repeat(10), via: "" },
    { path: "helper", role: "helper", priority: 8, full: null, small: "h".repeat(40), via: "" },
  ];
  const { files, dropped, used } = packWithinBudget(items, 100);
  assert.deepEqual(files.map((f) => `${f.path}:${f.form}`), ["engine:full", "variant:digest", "caller:usage"]);
  assert.deepEqual(dropped, ["helper"]);
  assert.equal(used, 70);
});

test("phraseWords and wordsMatch: ordered, adjacent words; compound one-word phrases", () => {
  assert.deepEqual(phraseWords("Export to CSV"), ["export", "csv"]);
  assert.deepEqual(phraseWords("ExportJobServices"), ["export", "job", "service"]);
  assert.ok(wordsMatch(phraseWords("data export"), phraseWords("DataExportJob")));
  assert.ok(!wordsMatch(phraseWords("data export"), phraseWords("GtfsExportData")));
  assert.ok(!wordsMatch(phraseWords("data export"), phraseWords("ExportAdminDataSession")));
  assert.ok(wordsMatch(phraseWords("importjob"), phraseWords("ImportJobService")));
  assert.ok(!wordsMatch(phraseWords("job"), phraseWords("ImportJobService").slice(0, 1)));
});

test("keyword sweep: declarations seed, mentions are listed, TS export keyword and generic phrases do not count", () => {
  const files = [
    { path: "app/services/export/grid-export.service.ts", content: "export class GridExportService { run() {} }" },
    { path: "app/pages/user-page.ts", content: ["export class UserPage {", "  // grid export of the user list", "  onExport() { this.gridExportService.run(); }", "}"].join("\n") },
    { path: "app/pages/job-page.ts", content: "export class JobPage { load() {} }" },
    ...["A", "B", "C", "D"].map((x) => ({ path: `gen/Thing${x}.java`, content: `class DataExport${x} {}` })),
  ];
  assert.deepEqual(keywordHits(files[2].path, files[2].content, ["export job"]), []);
  const res = sweepKeywords(files, ["grid export", "data export"], { maxSeedsPerPhrase: 3 });
  assert.deepEqual(res.seeds.map((s) => s.path), ["app/services/export/grid-export.service.ts"]);
  const user = res.mentions.find((m) => m.path === "app/pages/user-page.ts");
  assert.deepEqual(user.phrases, ["grid export"]);
  assert.equal(user.count, 2); // the gridExportService identifier and the comment
  assert.deepEqual(res.generic.map((g) => g.phrase), ["data export"]);
  assert.equal(res.mentions.filter((m) => m.path.startsWith("gen/")).length, 4, "files of a too-generic phrase stay listed as mentions");
  const snip = mentionSnippet(files[1].content, ["grid export"]);
  assert.match(snip, /gridExportService\.run/);
  assert.match(snip, /grid export of the user list/);
});

test("extra stories (Rovo): project keys only, de-duplicated, fetched only as stories of the project", () => {
  assert.deepEqual(normalizeExtraStories([{ key: "AVLN-4695", query: "grid export" }, "QA-43", "AVLN-4695", "bad"], "AVLN").map((x) => [x.key, x.source, x.query]), [["AVLN-4695", "rovo", "grid export"]]);
  assert.deepEqual(normalizeExtraStories("AVLN-1, AVLN-2", "AVLN").map((x) => x.key), ["AVLN-1", "AVLN-2"]);
  const scope = resolveScope("module:admin/import-job", profile, { extraStories: [{ key: "AVLN-4695" }] });
  assert.ok(scope.jql.includes('OR (key in (AVLN-4695) AND project = AVLN AND issuetype in ("Story"))'));
  assert.equal(scope.extraStories.length, 1);
});

test("cross-cutting module: only the use cases of another page's QA doc that mention a keyword are kept", () => {
  const doc = parseUcDoc(html);
  const { doc: kept, skipped } = useCasesMentioning(doc, keywordRegex(["reimport"]), { storyKey: "AVLN-2398", moduleName: '"reimport"' });
  assert.ok(kept.useCases.some((u) => u.id === "UC-04"));
  assert.ok(!kept.useCases.some((u) => u.id === "UC-01"));
  assert.equal(kept.useCases.length + skipped.length, doc.useCases.length);
  assert.match(skipped.find((x) => x.uc === "UC-01").reasoning, /no step or flow about "reimport"/);
  assert.ok(skipped.every((x) => x.offTopic));
  assert.deepEqual(useCasesMentioning(doc, null).doc, doc);
});

test("cross-cutting focus: derived or configured term, UCs kept whole or narrowed, free-text split", () => {
  const kw = ["grid export", "data export", "export to csv", "export to excel", "csv export", "excel export", "export button", "exportformatter"];
  assert.equal(focusRegex(null, kw).source, "\\bexport");
  assert.equal(focusRegex({ focusPattern: "\\bdownload" }, kw).source, "\\bdownload");
  assert.equal(focusRegex(null, ["route import", "stop list", "driver shift"]), null);
  assert.equal(focusRegex(null, ["grid export"]), null);

  const uc = (id, title, main, alternatives = [], exceptions = []) => ({ id, title, actor: "", preconditions: [], trigger: "", main, alternatives, exceptions, postconditions: [], notes: "" });
  const doc = { useCases: [
    uc("UC-08", "Export the outbox", ["Click Export", "Download the file"]),
    uc("UC-11", "Permission denial", ["Send button hidden", "Export button hidden"], [{ id: "a", label: "Export", text: "Export with no rights → toast" }]),
    uc("UC-01", "View a sent message", ["Open the row", "See details"]),
  ] };
  const { doc: kept, skipped } = useCasesMentioning(doc, keywordRegex(kw), { storyKey: "AVLN-1", moduleName: '"grid export"', focusRx: focusRegex(null, kw) });
  assert.deepEqual(kept.useCases.map((u) => u.id), ["UC-08", "UC-11"]);
  assert.deepEqual(kept.useCases[0].main, ["Click Export", "Download the file"]); // title names it: whole UC
  assert.deepEqual(kept.useCases[1].main, ["Export button hidden"]);
  assert.equal(kept.useCases[1].title, "Permission denial (grid export parts)");
  assert.deepEqual(skipped.map((s) => [s.uc, s.offTopic]), [["UC-01", true]]);
  // A narrowed UC with no main step left yields only its flows.
  const flowsOnly = { useCases: [{ ...uc("UC-02", "Filter", ["Pick a value"], [{ id: "a", label: "Export", text: "Export keeps the filter" }]), narrowed: true, main: [] }] };
  assert.deepEqual(ucDocToScenarios(flowsOnly, { storyKey: "AVLN-1" }).scenarios.map((s) => s.flow), ["alt"]);

  const sc = [{ title: "Export headers carry group prefix", steps: [], expected: "" }, { title: "Clear row", steps: ["Click clear"], expected: "Row kept" }, { title: "Grid columns", steps: ["Open file"], expected: "CSV export matches grid" }];
  const { keep, drop } = splitByFocus(sc, /\bexport/i);
  assert.deepEqual(keep.map((e) => e.title), ["Export headers carry group prefix", "Grid columns"]);
  assert.deepEqual(drop.map((e) => e.title), ["Clear row"]);
  assert.equal(splitByFocus(sc, null).keep.length, 3);
});

test("selectCandidates (module scope): the module's Zephyr folder and keyword-named cases are candidates too", () => {
  const cases = [
    { key: "QA-T7", name: "Export XLSX - Users grid", folderId: 3, folderPath: "Ridango > AVL > Data Export (grid Export)", issueIds: [] },
    { key: "QA-T8", name: "Grid export of the alarm list", folderId: 4, folderPath: "Ridango > AVL > Alarms", issueIds: [] },
    { key: "QA-T9", name: "Schedule paging" /* in the folder, shares no word with the story */, folderId: 3, folderPath: "Ridango > AVL > Data Export (grid Export)", issueIds: [] },
  ];
  const zephyr = { byKey: new Map(cases.map((c) => [c.key, c])), inScopeCases: cases, issueIndex: new Map() };
  const args = { story: story({ id: 2, summary: "Users list export", module: "grid-export" }), zephyr, expected: [{ title: "Export users to XLSX" }], limits: { candidateCasesPerStory: 10, keywordCandidates: 0, moduleCandidates: 5 } }; // word overlap off: module step only
  assert.deepEqual(selectCandidates(args).map((c) => c.key), []);
  const got = selectCandidates({ ...args, module: { zephyrFolder: "Data Export (grid Export)", rx: keywordRegex(["grid export"]) } });
  assert.deepEqual(got.map((c) => c.key).sort(), ["QA-T7", "QA-T8"]);
  assert.match(got.find((c) => c.key === "QA-T7").why, /module's Zephyr folder/);
  assert.match(got.find((c) => c.key === "QA-T8").why, /name contains a module keyword/);
});

test("keyword triangulation: candidates, scoring, choice, code bridge, location and Zephyr folder", () => {
  assert.deepEqual(segments("Export XLSX — Historical > Drives"), ["Export XLSX", "Historical", "Drives"]);
  const texts = ["Data Export (grid Export) - Export XLSX - Users", "Data Export (grid Export) - Export XLSX - Alarms", "grid export button disabled", "Grid column order"];
  const cands = candidatePhrases("grid data export", texts).map((c) => c.phrase);
  assert.equal(cands[0], "grid data export", "the user's own phrase is always first");
  assert.ok(cands.includes("grid export") && cands.includes("export xlsx"));
  assert.ok(!cands.includes("grid column"), "texts naming all distinctive words anchor the candidates");
  assert.ok(!cands.some((c) => c.includes("xlsx users")), "phrases never span a separator");

  const scored = [
    scoreKeyword({ phrase: "grid export", codeDeclares: 0, codeMentions: 1, jira: 3, zephyr: 88 }),
    scoreKeyword({ phrase: "export xlsx", codeDeclares: 1, codeMentions: 2, jira: 0, zephyr: 88 }),
    scoreKeyword({ phrase: "export", codeDeclares: 198, codeMentions: 400, jira: 181, zephyr: 174 }),
    scoreKeyword({ phrase: "grid data export", codeDeclares: 0, codeMentions: 0, jira: 0, zephyr: 0 }),
  ];
  assert.ok(scored[2].generic && /too generic in code/.test(scored[2].reason));
  assert.deepEqual(scored[0].sources, ["code", "jira", "zephyr"]);
  assert.deepEqual(chooseKeywords(scored).map((c) => c.phrase), ["grid export", "export xlsx"]);

  const stories = ["Export job fails for big grids", "Grid export: export job never finishes", "Users list export", "Alarm export columns", "Export admin page"];
  const bridge = bridgeToCode([{ phrase: "export job", declares: 13 }, { phrase: "export admin", declares: 21 }, { phrase: "export timed", declares: 0 }], stories, (p) => keywordRegex([p]));
  assert.deepEqual(bridge.map((b) => b.phrase), ["export job"], "one story in passing is not enough");

  assert.deepEqual(locateModule({ frontendFiles: ["admin/import-job/a.ts", "admin/import-job/b.ts", "admin/x/c.ts"], otherFiles: [], slugName: "import-job" }).path, "admin/import-job");
  const cross = locateModule({ frontendFiles: ["admin/a/x.ts", "dispatch/b/y.ts"], otherFiles: ["be/export/Svc.java", "be/export/Dto.java"], slugName: "grid-data-export" });
  assert.equal(cross.crossCutting, true);
  assert.equal(cross.codePaths[0], "be/export");

  const folder = dominantFolder(["Ridango > AVL > Data Export (grid Export)", "Ridango > AVL > Data Export (grid Export)", "Ridango > AVL > GTFS"], "Ridango > AVL");
  assert.deepEqual([folder.folder, folder.cases, folder.of], ["Data Export (grid Export)", 2, 3]);
});

test("agent results: blocked requests and console errors are parsed from Playwright console logs", async () => {
  const { parseBlockedRequests, parseConsoleErrors } = await import("../scripts/lib/agent-results.mjs");
  const log = [
    "[    4894ms] [WARNING] [read-only] blocked POST ./rest/filter-provider @ C:/run/ui/block-writes.js:6",
    "[    5763ms] [WARNING] [read-only] blocked post ./rest/filter-provider @ C:/run/ui/block-writes.js:6",
    "[    5765ms] [ERROR] [TMS Exception]: %o No user logged in! @ https://avl.example/main.min.js:0",
    "[    5766ms] [ERROR] [TMS Exception]: %o No user logged in! @ https://avl.example/main.min.js:0",
  ].join("\n");
  assert.deepEqual(parseBlockedRequests(log), [{ request: "POST ./rest/filter-provider", count: 2 }]);
  assert.deepEqual(parseConsoleErrors(log), [{ message: "[TMS Exception]: %o No user logged in!", count: 2 }]);
  assert.deepEqual(parseBlockedRequests(""), []);
});

test("agent results: a review file flattens to one row per item with id, title and reasoning", async () => {
  const { flattenReview } = await import("../scripts/lib/agent-results.mjs");
  const rows = flattenReview({
    drops: [{ id: "K-1:CODE-12", reasoning: "Other page" }],
    inventory: [{ id: "UI-001", functionality: "Export menu entry", confidence: "HIGH" }],
    note: "free text",
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.section, r.id, r.title, r.reasoning]), [
    ["drops", "K-1:CODE-12", "", "Other page"], ["inventory", "UI-001", "Export menu entry", ""], ["note", "", "free text", ""],
  ]);
  assert.match(rows[1].detail, /"confidence":"HIGH"/);
});

test("agent results: forwarded notes as text, list or JSON list string all become plain lines", async () => {
  const { notesText } = await import("../scripts/lib/agent-results.mjs");
  assert.equal(notesText("Check QA-T1"), "Check QA-T1");
  assert.equal(notesText(["a", "b"]), "• a\n• b");
  assert.equal(notesText('["a","b"]'), "• a\n• b");
  assert.equal(notesText("[draft] not JSON"), "[draft] not JSON");
  assert.equal(notesText(undefined), "");
});

const SAMPLE_CONTEXT = {
  overview: "CSV/Excel export from every grid page.",
  screens: [{ name: "Users grid", route: "#/admin/user/list", reachedFrom: "Admin > Users", elements: ["Tools menu > Export"], sources: ["UI-001"] }],
  workflows: [{ name: "Export a filtered grid", steps: ["Apply a filter", "Tools > Export"], outcome: "Toast 'Export finished for: Users' with Download", sources: ["AVLN-2655 UC-12", "CODE-16"] }],
  rules: [{ id: "R-01", kind: "permission", rule: "Export needs EXPORTS.VIEW", expected: "Export entry hidden without it", status: "needs-confirmation", sources: ["CODE-02"] }],
  apis: [{ method: "POST", path: "/rest/exportjob/export/{n}", purpose: "Start an export job", sources: ["ExportService.java"] }],
  uiTexts: [{ text: "Export finished for:", where: "toast", sources: ["AVLN-2655"] }],
  testData: [{ need: "User without EXPORTS.VIEW", how: "Admin > Users, role without the permission" }],
  existingCoverage: { folders: ["Data Export (grid Export)"], namingPattern: "AVL - Export XLSX - <page>", summary: "XLSX per page; no CSV." },
  openQuestions: [{ question: "Must POST /download require EXPORTS.VIEW?", affects: ["R-01"], sources: ["CODE-02"] }],
  knownIssues: [{ issue: "POST /download has no permission check", sources: ["CODE-02"] }],
};

test("module context: the context review schema accepts a full module context and rejects items without sources", async () => {
  const { default: Ajv } = await import("ajv");
  const fsm = await import("node:fs");
  const validate = new Ajv({ allErrors: true }).compile(JSON.parse(fsm.readFileSync(new URL("../schema/review/context.schema.json", import.meta.url))));
  assert.ok(validate({ moduleContext: SAMPLE_CONTEXT, overrides: [] }), JSON.stringify(validate.errors));
  const bad = structuredClone(SAMPLE_CONTEXT);
  bad.rules[0].sources = [];
  assert.equal(validate({ moduleContext: bad }), false);
});

test("module context: renders a markdown brief and one workbook row per item", async () => {
  const { renderModuleContext, moduleContextRows } = await import("../scripts/lib/module-context.mjs");
  const md = renderModuleContext(SAMPLE_CONTEXT, { title: "Module context — grid export" });
  assert.match(md, /^# Module context — grid export/);
  assert.match(md, /\*\*R-01\*\* \[permission, needs-confirmation\] Export needs EXPORTS.VIEW/);
  assert.match(md, /  1\. Apply a filter/);
  assert.match(md, /"Export finished for:" — toast/);
  const rows = moduleContextRows(SAMPLE_CONTEXT);
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((r) => r.section), ["Overview", "Screen", "Workflow", "Rule (permission)", "API", "UI text", "Test data", "Existing coverage", "Open question", "Known issue"]);
  assert.equal(renderModuleContext(null), "");
  assert.deepEqual(moduleContextRows(null), []);
});

test("run outputs: shared run header and file index; coverage.json carries results, agents.json no review copies", async () => {
  const { runHeader, runFiles, coverageJson, agentsJson, OUTPUT_VERSION } = await import("../scripts/lib/run-outputs.mjs");
  const runDir = path.join(os.tmpdir(), "runs", "avl", "2026-10-19_agents-x_v001");
  const run = runHeader({ runDir, profile: { name: "avl" }, state: { runAt: "t", scope: { kind: "module", value: "shared/x", moduleFilter: "shared/x", keywords: ["export"], jql: "q" }, codeCommits: ["abc"] } });
  assert.deepEqual(run, { name: "2026-10-19_agents-x_v001", runAt: "t", profile: "avl", scope: { kind: "module", value: "shared/x", module: "shared/x", keywords: ["export"], jql: "q" }, zephyrExportedAt: null, codeCommits: ["abc"] });

  const plain = runFiles({ runDir, workbookPath: path.join(runDir, "w.xlsx") });
  assert.equal(plain.workbook, "w.xlsx");
  assert.deepEqual([plain.agents, plain.moduleContext, plain.ui], [null, null, null]);
  const outside = path.join(os.tmpdir(), "elsewhere.xlsx");
  assert.equal(runFiles({ runDir, workbookPath: outside }).workbook, outside.split(path.sep).join("/"));
  const files = runFiles({ runDir, workbookPath: path.join(runDir, "w.xlsx"), agentRun: true, hasContext: true, hasUi: true });
  assert.deepEqual([files.agents, files.moduleContext, files.moduleContextBrief, files.ui], ["agents.json", "module-context.json", "module-context.md", "ui/"]);

  const r = minimalRun().stories[0];
  r.linkCheck.linkedKeys = ["QA-T1"];
  r.orphans = [{ key: "QA-T9", reasoning: "other feature", extra: 1 }];
  const ui = { inventory: [{ id: "UI-001" }], observations: [], scenarios: [], blockedRequests: [], consoleErrors: [], screenshots: ["ui/UI-001_a.png"] };
  const cov = coverageJson({ run, files, counts: { gaps: 1 }, moduleContext: SAMPLE_CONTEXT, ui, stories: [r] });
  assert.equal(cov.version, OUTPUT_VERSION);
  assert.deepEqual(Object.keys(cov), ["version", "run", "files", "counts", "moduleContext", "testDesign", "gapReport", "ui", "stories"]);
  assert.deepEqual(Object.keys(cov.stories[0]), ["key", "summary", "module", "testable", "dropped", "linkedCases", "scenarios", "verdicts", "gaps", "orphans"]);
  assert.deepEqual([cov.stories[0].linkedCases, cov.stories[0].orphans], [["QA-T1"], [{ key: "QA-T9", reasoning: "other feature" }]]);
  assert.equal(cov.ui.screenshots[0], "ui/UI-001_a.png");
  assert.equal(coverageJson({ run, files, stories: [] }).ui, null);

  const ag = agentsJson({ run, files, agents: [{ agent: "ui-explorer", review: { inventory: [] }, reviewFile: "review/ui.json" }, { agent: "reporter", review: null, reviewFile: null }] });
  assert.deepEqual(ag.agents.map((a) => [a.agent, a.reviewWritten, "review" in a]), [["ui-explorer", true, false], ["reporter", false, false]]);
});

test("workbook rows for agent runs: UI screenshots link only when saved; reviews point to sheets instead of copying them", async () => {
  const { uiEvidenceRows, agentReviewRows, SHEETS } = await import("../scripts/lib/workbook.mjs");
  const rows = uiEvidenceRows({
    inventory: [{ id: "UI-001", functionality: "Export", screenshot: "UI-001_a.png" }, { id: "UI-002", functionality: "Missing", screenshot: "UI-002_b.png" }],
    observations: [], scenarios: [], blockedRequests: [], consoleErrors: [], screenshots: ["ui/UI-001_a.png", "ui/extra.png"],
  });
  assert.deepEqual(rows.map((r) => [r.kind, r.screenshot, r.screenshotUrl]), [
    ["inventory", "ui/UI-001_a.png", "ui/UI-001_a.png"], ["inventory", "UI-002_b.png (file not saved)", null], ["screenshot", "ui/extra.png", "ui/extra.png"],
  ]);
  assert.deepEqual(uiEvidenceRows(null), []);

  const rev = agentReviewRows([
    { agent: "context-builder", review: { moduleContext: SAMPLE_CONTEXT, overrides: [{ expectedId: "K:S1", verdict: "Covered", reasoning: "steps match" }] } },
    { agent: "ui-explorer", review: { inventory: [{ id: "UI-001" }, { id: "UI-002" }] } },
    { agent: "reporter", review: null },
  ]);
  assert.deepEqual(rev.map((r) => [r.agent, r.section, r.title]), [
    ["context-builder", "moduleContext", `1 item(s), shown in ${SHEETS.context}`], ["context-builder", "overrides", "Covered"],
    ["ui-explorer", "inventory", `2 item(s), shown in ${SHEETS.ui}`],
  ]);
});

test("collectScreenshots moves only images saved since the agent started into ui/", async () => {
  const { collectScreenshots } = await import("../scripts/lib/agent-results.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cov-"));
  const old = path.join(root, "old.png");
  fs.writeFileSync(old, "x");
  fs.utimesSync(old, new Date(2020, 0, 1), new Date(2020, 0, 1));
  const since = Date.now() - 1000;
  fs.writeFileSync(path.join(root, "UI-001_a.png"), "x");
  fs.writeFileSync(path.join(root, "notes.txt"), "x");
  const toDir = path.join(root, "run", "ui");
  assert.deepEqual(collectScreenshots({ fromDir: root, toDir, since }), ["UI-001_a.png"]);
  assert.ok(fs.existsSync(path.join(toDir, "UI-001_a.png")) && fs.existsSync(old) && fs.existsSync(path.join(root, "notes.txt")));
});

test("test design: suite is normalised, checked against the right cases, and uncovered cases become gaps", async () => {
  const { needsDraft, designInput, normalizeSuite, checkCandidates, untracedScenarioGaps, designGap } = await import("../scripts/lib/test-design.mjs");
  const row = (key, ids, matches, candidates = []) => ({
    story: { key, summary: `${key} story` }, candidates,
    expected: ids.map((id) => ({ id, title: `t ${id}`, source: "story" })), matches,
  });
  const m = (expectedId, verdict, matchedKeys = [], confidence = "High") => ({ expectedId, verdict, matchedKeys, confidence, missingAspects: "", reasoning: "r" });
  const rows = [
    row("A-1", ["A-1:S01", "A-1:S02", "A-1:S03"], [m("A-1:S01", "Covered", ["QA-T1"]), m("A-1:S02", "Missing"), m("A-1:S03", "Partial", ["QA-T9"])], [{ key: "QA-T1" }]),
    row("A-2", ["A-2:S01"], [m("A-2:S01", "Missing")], [{ key: "QA-T9" }]),
  ];

  assert.deepEqual([needsDraft("Missing", "High"), needsDraft("Partial", "High"), needsDraft("Covered", "High"), needsDraft("Covered", "Medium"), needsDraft("Covered", "Low")], [true, true, false, false, true]);

  const input = designInput({ moduleContext: { overview: "o", by: "context-builder" }, rows, maxContextChars: 1000 });
  assert.equal(input.moduleContext.includes("context-builder"), false);
  assert.deepEqual(input.scenarios.map((x) => [x.id, x.verdict]), [["A-1:S01", "Covered"], ["A-1:S02", "Missing"], ["A-1:S03", "Partial"], ["A-2:S01", "Missing"]]);

  const { cases, notes } = normalizeSuite([
    { tcId: "TC-01", title: "x", storyKey: "A-1", basis: ["R-01"], scenarioIds: ["A-1:S02", "NOPE"], whyNeeded: "R-01 says so" },
    { tcId: "TC-01", title: "y", storyKey: "OTHER-9", basis: [], scenarioIds: ["A-2:S01"], whyNeeded: "" },
    { tcId: "TC 03", title: "z", storyKey: "", basis: ["R-02"], scenarioIds: [], whyNeeded: "w" },
  ], rows, "A-1");
  assert.deepEqual(cases.map((c) => [c.tcId, c.storyKey, c.scenarioIds]), [["TC-01", "A-1", ["A-1:S02"]], ["TC-01-2", "A-2", ["A-2:S01"]], ["TC-03", "A-1", []]]);
  assert.match(cases[1].whyNeeded, /A-2:S01/);
  assert.equal(notes.length, 2);

  // A-1's own candidates, plus QA-T9 (a candidate of A-2) because the traced scenario S03 matched it.
  const pool = checkCandidates(rows[0], [{ scenarioIds: ["A-1:S03"] }], rows).map((c) => c.key);
  assert.deepEqual(pool, ["QA-T1", "QA-T9"]);

  // S03 (Partial) is traced by no designed case, so it stays a scenario gap; S01 is covered.
  assert.deepEqual(untracedScenarioGaps(rows, cases).map((x) => x.match.expectedId), ["A-1:S03"]);

  const g = designGap(cases[0], { verdict: "Partial", matchedKeys: ["QA-T9"], confidence: "High", missingAspects: "the file content", reasoning: "QA-T9 step 2 only queues the job" }, [{ id: "R-01", status: "needs-confirmation" }]);
  assert.equal(g.gapId, "GAP-A-1-TC-01");
  assert.equal(g.source, "context");
  assert.equal(g.codeReview, "needs PO confirmation");
  assert.match(g.reasoning, /^Should be covered: R-01 says so \(from R-01, A-1:S02\)\. Only partly covered by QA-T9: .* Missing: the file content$/);
});

test("buildWorkbook writes the designed suite and rejects designed cases without a check reasoning", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-"));
  const tc = { tcId: "TC-01", storyKey: "AVLN-1", title: "Export selected rows", whyNeeded: "R-04 needs it", basis: ["R-04"], scenarioIds: ["AVLN-1:S01"], flow: "main", type: "positive", steps: ["Select", "Export"], expected: "Only selected rows", check: { verdict: "Missing", matchedKeys: [], confidence: "High", missingAspects: "", reasoning: "No case opens the file." }, gapId: "GAP-AVLN-1-TC-01" };
  const out = await buildWorkbook({ file: path.join(dir, "a.xlsx"), ...minimalRun(), testDesign: { cases: [tc] } });
  assert.ok(out.sheets.includes("8_Test_Design"));
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, "a.xlsx"));
  const ws = wb.getWorksheet("8_Test_Design");
  assert.deepEqual([ws.getCell(2, 1).value, ws.getCell(2, 11).value, ws.getCell(2, 16).value], ["TC-01", "Missing", "GAP-AVLN-1-TC-01"]);
  await assert.rejects(buildWorkbook({ file: path.join(dir, "b.xlsx"), ...minimalRun(), testDesign: { cases: [{ ...tc, check: { ...tc.check, reasoning: "" } }] } }), /8_Test_Design: TC-01 has no reasoning/);
});

test("test design: a designed case keeps a settled scenario verdict instead of being judged again", async () => {
  const { inheritedCheck } = await import("../scripts/lib/test-design.mjs");
  const m = (expectedId, verdict, matchedKeys, autoAccepted, confidence = "High") => [expectedId, { expectedId, verdict, matchedKeys, autoAccepted, confidence, reasoning: "no case opens the file" }];
  const matchById = new Map([m("A:S1", "Covered", ["QA-T1"], true), m("A:S2", "Covered", ["QA-T2"], true), m("A:S3", "Missing", [], false, "Medium"), m("A:S4", "Partial", ["QA-T3"], false), m("A:S5", "Covered", ["QA-T4"], false, "Medium"), m("B:S1", "Missing", [], false)]);
  const storyOf = new Map([["A:S1", "A"], ["A:S2", "A"], ["A:S3", "A"], ["A:S4", "A"], ["A:S5", "A"], ["B:S1", "B"]]);
  const tc = (scenarioIds) => ({ tcId: "TC-01", storyKey: "A", scenarioIds });
  const covered = inheritedCheck(tc(["A:S1", "A:S2"]), matchById, storyOf);
  assert.deepEqual([covered.verdict, covered.matchedKeys, covered.decidedBy], ["Covered", ["QA-T1", "QA-T2"], "scenario verdict"]);
  const missing = inheritedCheck(tc(["A:S3"]), matchById, storyOf);
  assert.deepEqual([missing.verdict, missing.confidence], ["Missing", "Medium"]);
  // Not settled: no scenarios, a Partial, a Covered that was not auto-accepted, mixed verdicts, or another story's scenario.
  for (const ids of [[], ["A:S4"], ["A:S5"], ["A:S1", "A:S3"], ["B:S1"], ["A:UNKNOWN"]]) assert.equal(inheritedCheck(tc(ids), matchById, storyOf), null, ids.join(","));
});

test("output.fields: validated, added to the stage schema and prompt only, and turned into cells", () => {
  const fields = outputFields({ output: { fields: [{ name: "riskLevel", stages: ["draft", "design"], description: "Risk.", values: ["Low", "High"], header: "Risk" }, { name: "testData", stage: "extract-ac", description: "Data.", list: true }] } }, loadLlmSchema);
  assert.deepEqual(fields.map((f) => [f.name, f.stages, f.header]), [["riskLevel", ["draft", "design"], "Risk"], ["testData", ["extract-ac"], "testData"]]);
  const draft = loadLlmSchema("draft");
  const ext = withExtraFields(draft, "draft", fields);
  assert.deepEqual(ext.properties.drafts.items.properties.riskLevel, { enum: ["Low", "High"] });
  assert.ok(ext.properties.drafts.items.required.includes("riskLevel"));
  assert.equal(draft.properties.drafts.items.properties.riskLevel, undefined, "input schema untouched");
  assert.deepEqual(withExtraFields(loadLlmSchema("extract-ac"), "extract-ac", fields).properties.stories.items.properties.scenarios.items.properties.testData, { type: "array", items: { type: "string" } });
  const match = loadLlmSchema("match");
  assert.equal(withExtraFields(match, "match", fields), match, "a stage without extra fields keeps its schema (and its cache)");
  assert.match(extraFieldsPrompt(fields, "draft"), /`riskLevel` \(one of Low \| High\): Risk\./);
  assert.equal(extraFieldsPrompt(fields, "match"), "");
  assert.deepEqual(extraCells({ testData: ["a", "b"] }, fields), { x_riskLevel: "", x_testData: "a, b" });
  assert.deepEqual(pickExtras({ riskLevel: "Low" }, fields), { riskLevel: "Low", testData: null });
  for (const [f, rx] of [
    [{ name: "verdict", stages: ["match"], description: "x" }, /already has a field "verdict"/],
    [{ name: "gapId", stages: ["draft"], description: "x" }, /used by the pipeline/],
    [{ name: "risk", stages: ["triage"], description: "x" }, /unknown stage "triage"/],
    [{ name: "risk", stages: ["draft"] }, /description is required/],
    [{ name: "Risk level", stages: ["draft"], description: "x" }, /camelCase/],
  ]) assert.throws(() => outputFields({ output: { fields: [f] } }, loadLlmSchema), rx);
});

test("output.workbook: sheets can be dropped and columns picked, hidden or renamed, but IDs, reasoning and create-approved columns stay", () => {
  assert.equal(sheetKey("7_Matching"), "matching");
  assert.equal(sheetKey("Run log"), "runLog");
  assert.equal(sheetKey("nope"), null);
  const pick = layoutColumns("matching", COLUMNS.matching, { columns: ["Verdict", "story"], rename: { "Match reasoning": "Why" } });
  assert.deepEqual(pick.map((c) => c.header), ["Verdict", "Story", "Expected ID", "Why"]);
  assert.equal(layoutColumns("expected", COLUMNS.expected, { hide: ["Module"] }).some((c) => c.key === "module"), false);
  assert.equal(layoutColumns("runLog", COLUMNS.runLog, false), null);
  assert.equal(layoutColumns("tokens", COLUMNS.tokens, undefined), COLUMNS.tokens);
  assert.throws(() => layoutColumns("gaps", COLUMNS.gaps, false), /cannot be switched off/);
  assert.throws(() => layoutColumns("matching", COLUMNS.matching, { hide: ["Match reasoning"] }), /cannot be hidden/);
  assert.throws(() => layoutColumns("gaps", COLUMNS.gaps, { rename: { "Draft name": "Name" } }), /cannot be renamed/);
  assert.throws(() => layoutColumns("matching", COLUMNS.matching, { hide: ["Nope"] }), /no column "Nope"/);
  assert.throws(() => layoutColumns("matching", COLUMNS.matching, { columns: ["Verdict"], hide: ["Scope"] }), /not both/);
  assert.throws(() => checkOutputConfig({ workbook: { sheets: { "99_Nope": false } } }), /unknown sheet "99_Nope"/);
  assert.doesNotThrow(() => checkOutputConfig(loadRunConfig().output));
});

test("buildWorkbook and coverage.json follow config output: dropped sheets, chosen columns, extra fields", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-"));
  const file = path.join(dir, "a.xlsx");
  const run = minimalRun();
  run.stories[0].matches[0].businessImpact = "Blocks exports";
  run.stories[0].gaps[0].draft.riskLevel = "High";
  const output = {
    fields: [{ name: "businessImpact", stages: ["match"], description: "x", header: "Impact" }, { name: "riskLevel", stages: ["draft"], description: "x", header: "Risk" }],
    workbook: { sheets: { "13_Run_Log": false, Matching: { columns: ["Expected ID", "Verdict", "Impact"] } } },
  };
  const out = await buildWorkbook({ file, ...run, output });
  assert.equal(out.sheets.includes("13_Run_Log"), false);
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const m = wb.getWorksheet("7_Matching");
  assert.deepEqual(m.getRow(1).values.slice(1), ["Expected ID", "Verdict", "Impact", "Match reasoning"]);
  assert.deepEqual(m.getRow(2).values.slice(1), ["AVLN-1:S01", "Missing", "Blocks exports", "Nothing found."]);
  const gaps = await readGapSheet(file);
  assert.equal(gaps.rows[0].Risk, "High");
  const summary = [];
  wb.getWorksheet("Summary").eachRow((r) => summary.push(String(r.getCell(1).value?.text ?? r.getCell(1).value ?? "")));
  assert.equal(summary.includes("13_Run_Log"), false);
  const json = coverageJson({ run: {}, files: {}, fields: outputFields({ output }), stories: run.stories.map((s) => ({ ...s, triage: s.triage })) });
  assert.equal(json.stories[0].verdicts[0].businessImpact, "Blocks exports");
  assert.equal(json.stories[0].gaps[0].draft.riskLevel, "High");
});

test("gaps workbook: requirement candidates come from flags, unconfirmed code behaviour, skipped UCs and the module context", async () => {
  const { collectGapItems } = await import("../scripts/lib/gap-report.mjs");
  const urls = minimalRun().urls;
  const r = minimalRun().stories[0];
  r.flags = [{ by: "agent:requirements-analyst", issue: "AC does not say what happens on an empty grid" }];
  r.skippedUcs = [{ uc: "UC-03", title: "Audit log", reasoning: "Admin-only UC skipped by profile rule" }, { uc: "UC-09", title: "Other page", reasoning: "off topic", offTopic: true }];
  r.expected.push({ id: "AVLN-1:CODE-02", storyKey: "AVLN-1", source: "backend", flow: "exception", title: "Download without permission", type: "permission", steps: [], expected: "403", evidence: { path: "api/Export.java", symbol: "download", detail: "no check" }, repo: "gtms", codeOnly: true, codeReview: "needs PO confirmation", reasoning: "Found in code." });
  r.expected.push({ ...r.expected.at(-1), id: "AVLN-1:CODE-03", title: "Export ignores filter", suspectedBug: true });
  const items = collectGapItems({ stories: [r], moduleContext: SAMPLE_CONTEXT, urls: { ...urls, code: (repo, p) => `https://code/${repo}/${p}` } });
  const req = items.filter((i) => i.category === "Requirement");
  assert.deepEqual(req.map((i) => [i.id, i.source, i.hint]), [
    ["REQ-01", "ac-flag", "Unclear"], ["REQ-02", "skipped-uc", "Incomplete"], ["REQ-03", "code-only", "Unclear"],
    ["REQ-04", "suspected-bug", "Incomplete"], // a suspected bug wins over "needs PO confirmation"
    ["REQ-05", "open-question", "Open question"], ["REQ-06", "rule-needs-confirmation", "Unclear"], ["REQ-07", "known-issue", "Incomplete"],
  ]);
  const code = req[2].refs.find((x) => x.kind === "Code");
  assert.deepEqual([code.ref, code.url], ["api/Export.java :: download", "https://code/gtms/api/Export.java"]);
  // CODE-02 in the module context is the scenario AVLN-1:CODE-02, not a Jira key.
  assert.equal(req[4].refs[0].kind, "Code");
  assert.equal(items.filter((i) => i.category === "Test case").length, 1);
});

test("gaps workbook: test-case gaps map Partial to Incomplete and suggest the draft as the fix", async () => {
  const { collectGapItems } = await import("../scripts/lib/gap-report.mjs");
  const run = minimalRun();
  const r = run.stories[0];
  r.gaps.push({ ...r.gaps[0], gapId: "GAP-AVLN-1-S02", verdict: "Partial", matchedKeys: ["QA-T5"], missingAspects: "no error path", draft: { ...r.gaps[0].draft, action: "extend", extendKey: "QA-T5" }, validation: { verdict: "possible-duplicate", duplicateOf: ["QA-T7"], by: "rule", reasoning: "x" } });
  const tc = collectGapItems({ stories: [r], urls: run.urls }).filter((i) => i.category === "Test case");
  assert.deepEqual(tc.map((i) => [i.id, i.gapType]), [["GAP-AVLN-1-S01", "Missing"], ["GAP-AVLN-1-S02", "Incomplete"]]);
  assert.match(tc[0].suggestedFix, /^Create "AVL - X - It works" in R > AVL > X \(1 steps\)$/);
  assert.match(tc[1].suggestedFix, /^Extend QA-T5: add 1 step\(s\).*possible duplicate of QA-T7/);
  assert.match(tc[1].description, /Missing: no error path/);
  assert.deepEqual(tc[1].refs.filter((x) => x.kind === "Zephyr case").map((x) => [x.ref, x.url]), [["QA-T5", "https://x/QA-T5"], ["QA-T7", "https://x/QA-T7"]]);
});

test("gaps workbook: reviews apply only to the gap they were made for; otherwise severity comes from rules", async () => {
  const { collectGapItems, applyGapReview, reviewSignature, finalizeGapReport, defaultSeverity } = await import("../scripts/lib/gap-report.mjs");
  const run = minimalRun();
  const r = run.stories[0];
  r.expected[0].flow = "main";
  r.flags = [{ issue: "Vague AC" }, { issue: "Not a real problem" }];
  const items = collectGapItems({ stories: [r], urls: run.urls });
  const [a, b, tc] = items;
  const reviews = {
    [a.id]: { sig: reviewSignature(a), keep: true, gapType: "Incomplete", title: "Empty grid not specified", description: "d", gapReason: "AC silent on empty grid", suggestedFix: "Add AC: Given no rows…", severity: 2, severityReasoning: "Traceability only." },
    [b.id]: { sig: reviewSignature(b), keep: false, keepReasoning: "Duplicate of REQ-01" },
    [tc.id]: { sig: "stale", severity: 3, severityReasoning: "old" },
  };
  const { kept, dropped } = applyGapReview(items, reviews);
  assert.deepEqual(dropped.map((d) => [d.id, d.dropReasoning]), [[b.id, "Duplicate of REQ-01"]]);
  const byId = Object.fromEntries(kept.map((k) => [k.id, k]));
  assert.deepEqual([byId[a.id].gapType, byId[a.id].suggestedFix, byId[a.id].reviewedBy], ["Incomplete", "Add AC: Given no rows…", "Claude"]);
  // The stale review is ignored: a Missing main-flow test gets severity 1 by rule.
  assert.deepEqual([byId[tc.id].severity, byId[tc.id].reviewedBy], [1, "rule"]);
  // Without a review a requirement gap still gets a suggested fix, from its kind.
  const unreviewed = applyGapReview([a]).kept[0];
  assert.equal(unreviewed.suggestedFix, "Clarify the acceptance criteria in AVLN-1: Vague AC");
  assert.match(byId[tc.id].severityReasoning, /^Rule default — not reviewed by Claude/);
  assert.equal(defaultSeverity({ category: "Test case", gapType: "Incomplete", flow: "alt" }).severity, 3);

  const report = finalizeGapReport(kept);
  assert.deepEqual(report.items.map((i) => i.id), [tc.id, a.id], "sorted by severity");
  const story = report.evidence.find((e) => e.kind === "Jira story");
  assert.deepEqual(story.usedBy.sort(), [a.id, tc.id].sort(), "one evidence row shared by both gaps");
  assert.ok(report.items.every((i) => i.evidence.includes(story.id)));
});

test("gaps workbook: Summary, Gaps and Supporting Evidence sheets; rows without reasoning are rejected; the full workbook is unchanged", async () => {
  const { collectGapItems, applyGapReview, finalizeGapReport, buildGapsWorkbook } = await import("../scripts/lib/gap-report.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cov-"));
  const run = minimalRun();
  const report = finalizeGapReport(applyGapReview(collectGapItems({ stories: run.stories, urls: run.urls })).kept);
  await buildGapsWorkbook({ file: path.join(dir, "g.xlsx"), report, title: "Gaps — t", runAt: "t", urls: run.urls, tokens: 1234, storySummary: { "AVLN-1": "Some feature" } });
  const { default: ExcelJS } = await import("exceljs");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(dir, "g.xlsx"));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ["Summary", "Gaps", "Supporting Evidence"]);
  const gaps = wb.getWorksheet("Gaps");
  assert.deepEqual(gaps.getRow(1).values.slice(1, 4), ["ID", "Category", "Story"]);
  assert.equal(gaps.getRow(2).getCell(1).value, "GAP-AVLN-1-S01");
  assert.equal(gaps.getRow(2).getCell(12).value, report.items[0].evidence.join(", "));
  const summary = [];
  wb.getWorksheet("Summary").eachRow((r) => summary.push(r.values.slice(1).map((v) => (v && typeof v === "object" ? `${v.text}->${v.hyperlink}` : v)).join(" | ")));
  const text = summary.join("\n");
  assert.match(text, /Gap-review tokens \| 1,234/);
  assert.match(text, /Gaps->#'Gaps'!A1 \| 1 \|/);
  assert.match(text, /Test case \| Missing \| 1 \| 1 \| 0 \| 0/, "a Missing test of the main flow is severity 1 by rule");
  assert.match(text, /AVLN-1->https:\/\/x\/browse\/AVLN-1 \| Some feature \| 0 \| 1/);
  assert.match(text, /GAP-AVLN-1-S01->#'Gaps'!A2/, "severity-1 list links to the gap's row");
  assert.doesNotMatch(text, /cost|usd|\$/i);
  const ev = wb.getWorksheet("Supporting Evidence");
  assert.equal(ev.getRow(2).getCell(1).value, "EV-01");
  const bad = { ...report, items: report.items.map((i) => ({ ...i, severityReasoning: "" })) };
  await assert.rejects(buildGapsWorkbook({ file: path.join(dir, "b.xlsx"), report: bad, title: "t", runAt: "t", urls: run.urls }), /GAP-AVLN-1-S01 has no severity reasoning/);

  const out = await buildWorkbook({ file: path.join(dir, "full.xlsx"), ...minimalRun() });
  assert.deepEqual(out.sheets, ["Summary", ...Object.values((await import("../scripts/lib/workbook.mjs")).SHEETS)]);
});
