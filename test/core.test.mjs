import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUcDoc, ucDocToScenarios, useCasesMentioning } from "../scripts/lib/uc-parser.mjs";
import { triageByRules, deriveModule, detectAcSource, keywordRegex } from "../scripts/lib/triage-rules.mjs";
import { resolveScope, normalizeExtraStories } from "../scripts/lib/scope.mjs";
import { summarizeTokens, TokenLog } from "../scripts/lib/tokens.mjs";
import { findModules } from "../scripts/modules.mjs";
import { CHAIN, allowedTools, buildPrompt } from "../scripts/agents.mjs";
import { RunContext } from "../scripts/lib/context.mjs";
import { applyRequirementsReview, applyCodeReview, applyMatchReview, applyScoutReview } from "../scripts/lib/reviews.mjs";
import { renderSummary } from "../scripts/lib/report.mjs";
import { formatSteps, parseSteps, buildWorkbook, readGapSheet } from "../scripts/lib/workbook.mjs";
import { selectCandidates } from "../scripts/lib/candidates.mjs";
import { segments, candidatePhrases, scoreKeyword, chooseKeywords, bridgeToCode, locateModule, dominantFolder } from "../scripts/lib/vocab.mjs";
import { loadProfile, resolveModule, loadModulesCatalog } from "../scripts/lib/config.mjs";
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
  write("match", { overrides: [{ expectedId: "AVLN-1:S01", verdict: "Covered", matchedKeys: ["QA-T1"], confidence: "High", reasoning: "QA-T1 step 4" }] });
  const ctx = load();
  for (let i = 0; i < 2; i++) { applyScoutReview(ctx); applyRequirementsReview(ctx); applyCodeReview(ctx); applyMatchReview(ctx); }
  assert.equal(ctx.R("AVLN-2").dropped.by, "agent:module-scout");
  assert.deepEqual(ctx.testable().map((r) => r.story.key), ["AVLN-1"]);
  const r = ctx.R("AVLN-1");
  assert.deepEqual(r.expected.map((x) => x.id), ["AVLN-1:S01", "AVLN-1:CODE-01", "AVLN-1:A01"]);
  assert.equal(r.droppedScenarios.length, 1);
  assert.equal(r.flags.length, 1);
  assert.equal(r.expected[1].codeReview, "needs PO confirmation");
  assert.equal(r.expected[1].suspectedBug, true);
  assert.equal(r.matches[0].verdict, "Covered");
  assert.equal(r.matches[0].decidedBy, "agent:coverage-matcher");
  assert.equal(r.matches[0].autoAccepted, true);
  assert.equal(r.matches[0].reasoning.match(/Agent coverage-matcher/g).length, 1);
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

test("agent allowlists: own stage only, review file only, Zephyr read-only", () => {
  const byName = Object.fromEntries(CHAIN.map((c) => [c.name, allowedTools(c, "runs/avl/x")]));
  assert.ok(byName["module-scout"].includes("Bash(node scripts/run.mjs --stage scope *)"));
  assert.ok(!byName["module-scout"].some((t) => t.includes("--stage match")));
  assert.ok(byName["coverage-matcher"].includes("Edit(./runs/avl/x/review/*.json)"));
  assert.ok(!Object.values(byName).flat().some((t) => /create_test_case|update_test|link_test_case/.test(t)));
  assert.ok(!byName.reporter.some((t) => t.startsWith("Edit")));
  const prompt = buildPrompt({ agent: CHAIN[3], rel: "runs/avl/x", profile, moduleWords: "import job", previous: [{ agent: "code-analyst", status: "ok", findings: ["CODE-14 suspected bug"], forwardNotes: "check T10870" }] });
  assert.match(prompt, /CODE-14 suspected bug/);
  assert.match(prompt, /Forwarded to you: check T10870/);
  assert.match(prompt, /match stage has ALREADY been run/);
  assert.ok(!byName["coverage-matcher"].some((t) => t.includes("--stage")));
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
  assert.deepEqual(out.sheets, ["Summary", "1_Story_Triage", "2_Link_Check", "3_Expected_Scenarios", "4_Zephyr_Cases", "5_Matching", "6_Gaps", "7_Orphan_Zephyr", "8_Run_Log", "9_Token_Usage"]);
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
  await assert.rejects(buildWorkbook({ file, ...run }), /without reasoning[\s\S]*1_Story_Triage: AVLN-1/);
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
  assert.match(skipped.find((x) => x.uc === "UC-01").reasoning, /does not mention "reimport"/);
  assert.deepEqual(useCasesMentioning(doc, null).doc, doc);
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
