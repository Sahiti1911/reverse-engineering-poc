import ExcelJS from "exceljs";
import { summarizeTokens, totalTokens } from "./tokens.mjs";
import { flattenReview } from "./agent-results.mjs";
import { moduleContextRows } from "./module-context.mjs";

export const REVIEW_OPTIONS = ["Approve", "Reject", "Review"];

/** "1. Click Add [data: a ZIP] => The dialog opens" — one line per step; edited text is parsed back by create-approved. */
export function formatSteps(steps = []) {
  return steps
    .map((s, i) => `${i + 1}. ${s.description}${s.testData ? ` [data: ${s.testData}]` : ""} => ${s.expectedResult ?? ""}`)
    .join("\n");
}

export function parseSteps(text) {
  return String(text ?? "")
    .split(/\r?\n(?=\s*\d+\.\s)/)
    .map((line) => line.replace(/^\s*\d+\.\s*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [left, ...right] = line.split(" => ");
      const data = left.match(/\s*\[data:\s*([^\]]*)\]\s*$/);
      return {
        description: (data ? left.slice(0, data.index) : left).trim(),
        testData: data?.[1].trim() ?? "",
        expectedResult: right.join(" => ").trim(),
      };
    });
}

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const VERDICT_FILL = {
  Covered: "FFC6EFCE", Partial: "FFFFEB9C", Missing: "FFFFC7CE",
  Approve: "FFC6EFCE", Review: "FFFFEB9C", Reject: "FFD9D9D9",
};

function addTable(wb, name, columns, rows, { freeze = true } = {}) {
  const ws = wb.addWorksheet(name, { views: freeze ? [{ state: "frozen", ySplit: 1 }] : [] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18, hidden: !!c.hidden }));
  ws.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  ws.getRow(1).height = 30;
  for (const row of rows) {
    const values = {};
    for (const c of columns) values[c.key] = row[c.key] ?? "";
    const r = ws.addRow(values);
    for (const c of columns) {
      const cell = r.getCell(c.key);
      if (c.link && row[c.link]) cell.value = { text: String(row[c.key] ?? ""), hyperlink: row[c.link] };
      if (c.link && row[c.link]) cell.font = { color: { argb: "FF0563C1" }, underline: true };
      if (c.wrap) cell.alignment = { wrapText: true, vertical: "top" };
      else cell.alignment = { vertical: "top" };
      if (c.color && VERDICT_FILL[row[c.key]]) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: VERDICT_FILL[row[c.key]] } };
    }
  }
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  return ws;
}

/**
 * Sheet names in workbook order: what the feature is, what should be tested, what exists, the verdicts, the
 * review list, then how the run went. Every sheet is always written (agent-only ones stay empty in a plain
 * pipeline run), so the numbers never shift between runs.
 */
export const SHEETS = {
  context: "1_Module_Context", triage: "2_Story_Triage", links: "3_Link_Check", expected: "4_Expected_Scenarios",
  ui: "5_UI_Exploration", cases: "6_Zephyr_Cases", matching: "7_Matching", design: "8_Test_Design", gaps: "9_Gaps",
  orphans: "10_Orphan_Zephyr", agents: "11_Agents", reviews: "12_Agent_Reviews", runLog: "13_Run_Log", tokens: "14_Token_Usage",
};

const SHEET_INFO = {
  context: "What the feature is: screens, workflows, rules, APIs, exact UI texts, test data, open questions (context-builder)",
  triage: "Each story: testable or not, module source, AC quality flags",
  links: "Zephyr cases already linked to each story or a related story",
  expected: "What should be tested (story / code / UI), evidence, agent review",
  ui: "What the UI explorer saw and did: inventory, checked scenarios, new scenarios, blocked requests, console errors, screenshots",
  cases: "Existing Zephyr cases compared, and why",
  matching: "Covered / Partial / Missing per expected scenario, with confidence",
  design: "The test suite the module should have, designed from the module context, and which existing case covers each one",
  gaps: "Drafts, validation and suggested decision. WHERE YOU REVIEW: set Review decision",
  orphans: "Linked cases that match no requirement",
  agents: "One row per agent: status, tokens, findings, forwarded notes, what a later stage applied",
  reviews: "Every item of every agent's review file, with its reasoning",
  runLog: "Every step, review merge, skip and error",
  tokens: "One row per Claude call and agent session",
};
const AGENT_ONLY = new Set(["context", "ui", "design", "agents", "reviews"]);

/** Review sections that have their own sheet; 11_Agent_Reviews shows one pointer row for them instead of a copy. */
const OWN_SHEET = {
  "context-builder": { moduleContext: SHEETS.context },
  "ui-explorer": { inventory: SHEETS.ui, observations: SHEETS.ui, scenarios: SHEETS.ui },
};

/** 8_Test_Design rows: every designed case with its coverage verdict and, when not covered, its gap id. */
export function testDesignRows(testDesign, urls) {
  return (testDesign?.cases ?? []).map((tc) => ({
    tcId: tc.tcId, story: tc.storyKey, storyUrl: urls.jira(tc.storyKey), title: tc.title, whyNeeded: tc.whyNeeded,
    basis: tc.basis.join(", "), scenarios: tc.scenarioIds.join(", "), flow: tc.flow, type: tc.type,
    steps: (tc.steps ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n"), expected: tc.expected,
    verdict: tc.check?.verdict ?? "", matched: (tc.check?.matchedKeys ?? []).join(", "), confidence: tc.check?.confidence ?? "",
    missing: tc.check?.missingAspects ?? "", reasoning: tc.check?.reasoning ?? "", gapId: tc.gapId ?? "",
  }));
}

/** 11_Agents rows: one per configured agent, in pipeline order. */
export function agentRows(agents = []) {
  return agents.map((a) => ({
    ...a, duration: Math.round((a.durationMs ?? 0) / 1000), reusedFrom: a.reusedFrom ? `earlier run ${a.reusedFrom}` : "this run",
    findings: a.findings.map((f) => `• ${f}`).join("\n"), reviewFile: a.reviewFile ? (a.review ? a.reviewFile : `${a.reviewFile} (not written)`) : "",
  }));
}

/** 12_Agent_Reviews rows: every review item, except sections shown in their own sheet (one pointer row each). */
export function agentReviewRows(agents = []) {
  return agents.flatMap((a) => {
    if (!a.review) return [];
    const own = OWN_SHEET[a.agent] ?? {};
    const pointers = Object.entries(a.review).filter(([k]) => own[k]).map(([k, v]) => ({
      agent: a.agent, section: k, id: "", title: `${Array.isArray(v) ? v.length : 1} item(s), shown in ${own[k]}`, reasoning: "Has its own sheet.", detail: "",
    }));
    const rest = Object.fromEntries(Object.entries(a.review).filter(([k]) => !own[k]));
    return [...pointers, ...flattenReview(rest).map((r) => ({ agent: a.agent, ...r, detail: r.detail.slice(0, 4000) }))];
  });
}

/** 5_UI_Exploration rows. A screenshot links only when the file is in ui/; images no row refers to are listed last. */
export function uiEvidenceRows(ui) {
  if (!ui) return [];
  const saved = new Set(ui.screenshots);
  const used = new Set();
  const shot = (s) => {
    if (!s) return { screenshot: "", screenshotUrl: null };
    const p = s.includes("/") ? s : `ui/${s}`;
    used.add(p);
    return saved.has(p) ? { screenshot: p, screenshotUrl: p } : { screenshot: `${s} (file not saved)`, screenshotUrl: null };
  };
  const rows = [
    ...ui.inventory.map((i) => ({
      kind: "inventory", id: i.id, screen: i.screen ?? "", url: i.url ?? "", what: i.functionality, action: i.action ?? "", result: i.result ?? "",
      element: i.element ?? "", confidence: i.confidence ?? "", ...shot(i.screenshot), reasoning: i.uncertainty ?? "",
    })),
    ...ui.observations.map((o) => ({ kind: "observation", id: o.id, what: "Expected scenario checked in the UI", result: o.status, reasoning: o.reasoning })),
    ...ui.scenarios.map((s) => ({
      kind: "new scenario", id: s.storyKey ?? "", url: s.evidence?.url ?? "", what: s.title, action: (s.steps ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n"),
      result: s.expected, element: s.evidence?.element ?? "", ...shot(s.evidence?.screenshot), reasoning: s.reasoning,
    })),
    ...ui.blockedRequests.map((b) => ({ kind: "blocked request", what: b.request, result: `blocked ${b.count}×`, reasoning: "Read-only mode stopped this request. If it only reads data, add it to agents.ui-explorer.allowedWriteUrls." })),
    ...ui.consoleErrors.map((e) => ({ kind: "console error", what: e.message, result: `${e.count}×` })),
  ];
  for (const s of ui.screenshots.filter((x) => !used.has(x))) rows.push({ kind: "screenshot", what: s.split("/").pop(), screenshot: s, screenshotUrl: s });
  return rows;
}

/** Every decision row must say why. Fails the build with the offending rows. */
function checkReasoning(sheet, rows, key, idKey) {
  return rows.filter((r) => !String(r[key] ?? "").trim()).map((r) => `${sheet}: ${r[idKey]} has no ${key}`);
}

/** Read the 9_Gaps sheet back as objects keyed by header text (used by re-runs and create-approved). Older workbooks call it 8_Gaps or 6_Gaps. */
export async function readGapSheet(file) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEETS.gaps) ?? wb.worksheets.find((w) => /^\d+_Gaps$/.test(w.name));
  if (!ws) throw new Error(`${file} has no ${SHEETS.gaps} sheet`);
  const headers = [];
  ws.getRow(1).eachCell((cell, col) => (headers[col] = String(cell.value)));
  const text = (v) => (v && typeof v === "object" ? (v.text ?? v.richText?.map((t) => t.text).join("") ?? v.result ?? "") : v ?? "");
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const obj = { _row: n };
    headers.forEach((h, col) => h && (obj[h] = String(text(row.getCell(col).value)).trim()));
    rows.push(obj);
  });
  return { wb, ws, headers, rows, profileName: wb.subject };
}

export async function buildWorkbook({ file, profile, scope, stories, zephyr, tokenRecords, runLog, runInfo, urls, handoffs = [], agentResults = null, moduleContext = null, testDesign = null }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "coverage-gap-analysis";
  wb.subject = profile.name;
  wb.created = new Date();
  const problems = [];
  const tok = summarizeTokens(tokenRecords);

  // ---------- row sets ----------
  const triageRows = stories.map((s) => ({
    key: s.story.key, url: urls.jira(s.story.key), summary: s.story.summary, epic: s.story.epicKey ? `${s.story.epicKey} ${s.story.epicSummary ?? ""}` : "",
    module: s.story.module, moduleSource: s.story.moduleSource + (s.story.moduleReason ? `: ${s.story.moduleReason}` : ""),
    status: s.story.status, labels: s.story.labels.join(", "), created: s.story.created?.slice(0, 10), updated: s.story.updated?.slice(0, 10),
    acSource: s.triage.acSource,
    testable: s.dropped ? "Dropped" : s.triage.testable === null ? "Undecided" : s.triage.testable ? "Yes" : "No",
    decidedBy: s.dropped ? s.dropped.by : s.triage.decidedBy + (s.triage.rule ? ` (${s.triage.rule})` : ""),
    flags: (s.flags ?? []).map((f) => f.issue).join("\n"),
    reasoning: s.dropped ? `${s.triage.reasoning} | Dropped by ${s.dropped.by}: ${s.dropped.reasoning}` : s.triage.reasoning,
  }));
  problems.push(...checkReasoning(SHEETS.triage, triageRows, "reasoning", "key"));

  const linkRows = stories.filter((s) => s.linkCheck).map((s) => ({
    key: s.story.key, url: urls.jira(s.story.key), module: s.story.module,
    related: s.story.related.map((r) => `${r.key} (${r.type})`).join(", "),
    linked: s.linkCheck.linkedKeys.join(", "), count: s.linkCheck.linkedKeys.length,
    result: s.linkCheck.result, reasoning: s.linkCheck.reasoning,
  }));
  problems.push(...checkReasoning(SHEETS.links, linkRows, "reasoning", "key"));

  const expectedRows = [];
  for (const s of stories) {
    const rows = [...(s.expected ?? []).map((e) => ({ e, dropped: false })), ...(s.droppedScenarios ?? []).map((e) => ({ e, dropped: true }))];
    for (const { e, dropped } of rows) {
      const ev = typeof e.evidence === "object" ? e.evidence : null;
      expectedRows.push({
        id: e.id, story: s.story.key, storyUrl: urls.jira(s.story.key), module: s.story.module, source: e.source,
        uc: e.uc ? `${e.uc} ${e.flow}` : e.flow, scenario: dropped ? `(dropped) ${e.title}` : e.title, type: e.type, priorityHint: e.priorityHint ?? "",
        steps: (e.steps ?? []).map((x, i) => `${i + 1}. ${x}`).join("\n"), expected: e.expected,
        evidence: ev ? `${ev.path}${ev.symbol ? ` :: ${ev.symbol}` : ""}${ev.detail ? ` — ${ev.detail}` : ""}` : e.evidence,
        evidenceUrl: ev ? urls.code(e.repo, ev.path) : null,
        codeOnly: e.codeOnly ? "Yes — verify intended behaviour" : e.uiOnly ? "UI only — verify intended behaviour" : "No",
        agentReview: [dropped ? `dropped by ${e.droppedBy}` : "", e.addedBy ? `added by ${e.addedBy}` : "", e.codeReview ?? "", e.suspectedBug ? "SUSPECTED BUG" : "", e.uiCheck ? `UI ${e.uiCheck}` : ""].filter(Boolean).join("; "),
        reasoning: e.reasoning,
      });
    }
    for (const sk of s.skippedUcs ?? []) {
      expectedRows.push({
        id: `${s.story.key}:${sk.uc}:skipped`, story: s.story.key, storyUrl: urls.jira(s.story.key), module: s.story.module, source: "story",
        uc: sk.uc, scenario: `(skipped) ${sk.title}`, type: "", priorityHint: "", steps: "", expected: "", evidence: sk.uc, codeOnly: "No", agentReview: "", reasoning: sk.reasoning,
      });
    }
  }
  problems.push(...checkReasoning(SHEETS.expected, expectedRows, "reasoning", "id"));

  const caseRows = [];
  const seen = new Set();
  for (const s of stories) {
    for (const c of s.candidates ?? []) {
      if (seen.has(c.key)) continue;
      seen.add(c.key);
      const z = zephyr.byKey.get(c.key);
      caseRows.push({
        key: c.key, url: urls.zephyr(c.key), name: z.name, folder: z.folderPath, labels: z.labels.join(", "), status: z.status,
        priority: z.priority, automation: z.automation, linkedTo: z.issueIds.length ? z.issueIds.join(", ") : "",
        forStories: stories.filter((x) => x.candidates?.some((y) => y.key === c.key)).map((x) => x.story.key).join(", "),
        normalized: [z.objective, z.bdd].filter(Boolean).join(" | ").slice(0, 600),
        reasoning: `Compared because: ${c.why}.`,
      });
    }
  }

  const matchRows = [];
  for (const s of stories) {
    const byId = new Map((s.expected ?? []).map((e) => [e.id, e]));
    for (const m of s.matches ?? []) {
      matchRows.push({
        id: m.expectedId, story: s.story.key, storyUrl: urls.jira(s.story.key), module: s.story.module,
        scenario: byId.get(m.expectedId)?.title ?? "", matched: m.matchedKeys.join(", "), verdict: m.verdict, confidence: m.confidence,
        autoAccepted: m.autoAccepted ? "Yes" : "No", decidedBy: m.decidedBy, missing: m.missingAspects, reasoning: m.reasoning,
        scope: "Gap analysis",
      });
    }
    for (const m of s.auditMatches ?? []) {
      matchRows.push({
        id: m.expectedId, story: s.story.key, storyUrl: urls.jira(s.story.key), module: s.story.module, scenario: `(audit-only) ${m.title}`,
        matched: m.matchedKeys.join(", "), verdict: m.verdict, confidence: m.confidence, autoAccepted: "No", decidedBy: m.decidedBy,
        missing: m.missingAspects, reasoning: m.reasoning, scope: "Audit-only (skipped UC) — never a gap",
      });
    }
  }
  problems.push(...checkReasoning(SHEETS.matching, matchRows, "reasoning", "id"));

  const gapRows = [];
  for (const s of stories) {
    for (const g of s.gaps ?? []) {
      const d = g.draft ?? {};
      gapRows.push({
        gapId: g.gapId, story: s.story.key, storyUrl: urls.jira(s.story.key), storyId: s.story.id, module: s.story.module,
        expectedId: g.expectedId, scenario: g.scenario, source: g.source, type: g.type, verdict: g.verdict, matched: g.matchedKeys.join(", "),
        action: d.action ?? "create", extendKey: d.extendKey ?? "",
        priority: d.priority ?? "", priorityReasoning: d.priorityReasoning ?? "",
        folderId: d.folderId ?? "", folderPath: d.folderPath ?? "", folderReasoning: d.folderReasoning ?? "",
        name: d.name ?? "", objective: d.objective ?? "", precondition: d.precondition ?? "", steps: formatSteps(d.steps), bdd: d.bdd ?? "",
        labels: (d.labels ?? []).join(", "), gapReasoning: g.reasoning,
        agentReview: [g.codeReview, g.suspectedBug ? "SUSPECTED BUG" : "", g.draftEditedBy ? `draft edited by ${g.draftEditedBy}` : "", g.uiCheck ? `UI ${g.uiCheck}` : ""].filter(Boolean).join("; "),
        validation: g.validation ? `${g.validation.verdict}${g.validation.duplicateOf?.length ? ` of ${g.validation.duplicateOf.join(", ")}` : ""} (${g.validation.by}): ${g.validation.reasoning}` : "",
        suggested: d.suggestedDecision ?? "Review", decisionReasoning: d.decisionReasoning ?? g.draftError ?? "",
        decision: g.reviewDecision ?? (d.suggestedDecision === "Approve" ? "Approve" : d.suggestedDecision === "Reject" ? "Reject" : "Review"),
        notes: g.notes ?? "", createdKey: g.createdKey ?? "", createdUrl: g.createdKey ? urls.zephyr(g.createdKey) : null,
      });
    }
  }
  problems.push(...checkReasoning(SHEETS.gaps, gapRows, "gapReasoning", "gapId"));
  problems.push(...checkReasoning(SHEETS.gaps, gapRows, "decisionReasoning", "gapId"));

  const designRows = testDesignRows(testDesign, urls);
  problems.push(...checkReasoning(SHEETS.design, designRows, "whyNeeded", "tcId"));
  problems.push(...checkReasoning(SHEETS.design, designRows, "reasoning", "tcId"));

  const orphanRows = [];
  for (const s of stories) {
    for (const o of s.orphans ?? []) {
      const z = zephyr.byKey.get(o.key);
      orphanRows.push({ key: o.key, url: urls.zephyr(o.key), story: s.story.key, name: z?.name ?? "", folder: z?.folderPath ?? "", reasoning: o.reasoning });
    }
  }
  problems.push(...checkReasoning(SHEETS.orphans, orphanRows, "reasoning", "key"));

  if (problems.length) {
    const err = new Error(`Workbook rejected: ${problems.length} row(s) without reasoning:\n  ${problems.slice(0, 20).join("\n  ")}`);
    err.problems = problems;
    throw err;
  }

  // Agent runs only: module context, UI evidence, agents and their reviews.
  const contextRows = moduleContextRows(moduleContext);
  const uiRows = uiEvidenceRows(agentResults?.ui ?? null);
  const agentSheetRows = agentRows(agentResults?.agents);
  const reviewRows = agentReviewRows(agentResults?.agents);
  const rowCount = {
    context: contextRows.length, triage: triageRows.length, links: linkRows.length, expected: expectedRows.length, ui: uiRows.length,
    cases: caseRows.length, matching: matchRows.length, design: designRows.length, gaps: gapRows.length, orphans: orphanRows.length, agents: agentSheetRows.length,
    reviews: reviewRows.length, runLog: runLog.length, tokens: tokenRecords.length,
  };

  // ---------- Summary ----------
  const ws = wb.addWorksheet("Summary");
  ws.columns = Array.from({ length: 16 }, () => ({ width: 16 }));
  ws.getColumn(1).width = 44;
  const title = (text) => {
    const r = ws.addRow([text]);
    r.font = { bold: true, size: 13, color: { argb: "FF1F3864" } };
  };
  const header = (cells) => {
    const r = ws.addRow(cells);
    r.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = HEADER_FILL; c.alignment = { wrapText: true }; });
    return r;
  };
  // A long text in column `from` spans to column 13 so it stays readable next to the narrow number columns.
  const span = (r, from, lines = 1) => {
    ws.mergeCells(r.number, from, r.number, 13);
    r.getCell(from).alignment = { wrapText: true, vertical: "top" };
    if (lines > 1) r.height = 15 * lines;
  };
  title(`Coverage gap analysis — profile "${profile.name}", scope ${scope.kind}${scope.value ? `:${scope.value}` : ""}`);
  for (const [k, v] of [
    ["Run at", runInfo.runAt], ["JQL", scope.jql], ["Jira project / Zephyr project", `${profile.jira.projectKey} / ${profile.zephyr.projectKey} (${profile.zephyr.folderRoot})`],
    ...(scope.moduleFilter ? [["Module / keywords", `${scope.moduleFilter} / ${scope.keywords.join(", ")}`]] : []),
    ["Zephyr export", runInfo.zephyrExportedAt], ["Code", runInfo.codeCommits || "not analysed"], ["Models", runInfo.models],
    ["Auto-accepted matches", "Covered with confidence " + runInfo.autoAccept + " — filtered out of " + SHEETS.gaps],
  ]) ws.addRow([k, v]);
  ws.addRow([]);

  title("Sheets");
  span(header(["Sheet", "Rows", "What it holds"]), 3);
  for (const [k, name] of Object.entries(SHEETS)) {
    const absent = AGENT_ONLY.has(k) && !agentResults;
    const r = ws.addRow([{ text: name, hyperlink: `#'${name}'!A1` }, absent ? "agent runs only" : rowCount[k], SHEET_INFO[k]]);
    r.getCell(1).font = { color: { argb: "FF0563C1" }, underline: true, bold: k === "gaps" };
    span(r, 3);
  }
  ws.addRow([]);

  const agentList = agentResults?.agents ?? handoffs.map((h) => ({ agent: h.agent, phase: "", status: h.status, tokens: h.tokens ?? 0, findings: h.findings ?? [] }));
  if (agentList.length) {
    title(`Agent chain, in pipeline order (forwarded notes and applied reviews: ${SHEETS.agents})`);
    span(header(["Agent", "Phase", "Status", "Tokens", "Findings"]), 5);
    for (const a of agentList) {
      const r = ws.addRow([a.agent, a.phase, a.status, a.tokens, a.findings.map((f) => `• ${f}`).join("\n")]);
      r.alignment = { vertical: "top" };
      span(r, 5, a.findings.reduce((n, f) => n + Math.ceil((f.length + 2) / 130), 0));
    }
    ws.addRow([]);
  }

  title("Coverage by module");
  header(["Module", "Stories", "Testable", "With linked tests", "Without tests", "Expected scenarios", "Covered", "Partial", "Missing", "Coverage %", "Gaps", "Suggested Approve", "Tokens (this run)"]);
  const modules = new Map();
  for (const s of stories) {
    const m = modules.get(s.story.module) ?? { stories: 0, testable: 0, linked: 0, unlinked: 0, expected: 0, Covered: 0, Partial: 0, Missing: 0, gaps: 0, approve: 0 };
    m.stories++;
    if (s.triage.testable && !s.dropped) {
      m.testable++;
      if (s.linkCheck?.linkedKeys.length) m.linked++; else m.unlinked++;
    }
    m.expected += s.expected?.length ?? 0;
    for (const x of s.matches ?? []) m[x.verdict]++;
    m.gaps += s.gaps?.length ?? 0;
    m.approve += (s.gaps ?? []).filter((g) => g.draft?.suggestedDecision === "Approve").length;
    modules.set(s.story.module, m);
  }
  const total = { stories: 0, testable: 0, linked: 0, unlinked: 0, expected: 0, Covered: 0, Partial: 0, Missing: 0, gaps: 0, approve: 0 };
  const covPct = (m) => (m.Covered + m.Partial + m.Missing ? Math.round((100 * (m.Covered + 0.5 * m.Partial)) / (m.Covered + m.Partial + m.Missing)) : "");
  for (const [name, m] of [...modules].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const k of Object.keys(total)) total[k] += m[k];
    const t = tok.byModule[name];
    ws.addRow([name, m.stories, m.testable, m.linked, m.unlinked, m.expected, m.Covered, m.Partial, m.Missing, covPct(m), m.gaps, m.approve, t?.total_tokens ?? 0]);
  }
  const tr = ws.addRow(["TOTAL", total.stories, total.testable, total.linked, total.unlinked, total.expected, total.Covered, total.Partial, total.Missing, covPct(total), total.gaps, total.approve, tok.total.total_tokens]);
  tr.font = { bold: true };
  ws.addRow(["Coverage % = (Covered + ½ Partial) / expected scenarios that were matched. Tokens per module exclude agent sessions (see below)."]).font = { italic: true, size: 9 };
  ws.addRow([]);

  title("Tokens used by stage and agent (this run; reused = served from cache, 0 new tokens)");
  header(["Stage / agent", "Model", "Calls", "Reused", "Failed", "Input", "Output", "Cache read", "Cache write", "Total tokens"]);
  for (const [stage, t] of Object.entries(tok.byStage)) {
    const model = [...new Set(tokenRecords.filter((r) => r.stage === stage).map((r) => r.model))].join(", ");
    ws.addRow([stage, model, t.calls, t.reused, t.failed, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens, t.total_tokens]);
  }
  const tt = tok.total;
  for (const [label, t] of [["Pipeline stages", tok.pipeline], ["Agent sessions", tok.agents], ["TOTAL", tt]]) {
    ws.addRow([label, "", t.calls, t.reused, t.failed, t.input_tokens, t.output_tokens, t.cache_read_tokens, t.cache_creation_tokens, t.total_tokens]).font = { bold: true };
  }
  ws.addRow([]);

  title("Efficiency (use these to tune config/config.yaml)");
  const per = (n, t = tt.total_tokens) => (n ? Math.round(t / n) : "");
  header(["Metric", "Total tokens", "Pipeline tokens", "Agent tokens"]);
  for (const [label, n] of [["per story in scope", total.stories], ["per testable story", total.testable], ["per expected scenario", total.expected], ["per gap found", total.gaps]]) {
    ws.addRow([label, per(n), per(n, tok.pipeline.total_tokens), per(n, tok.agents.total_tokens)]);
  }
  ws.addRow(["cache hit ratio (cache read / all input)", `${Math.round(tt.cache_hit_ratio * 100)}%`]);
  ws.addRow(["calls served from cache (no new tokens)", `${tt.reused} of ${tt.calls}`]);

  // ---------- detail sheets, in SHEETS order ----------
  addTable(wb, SHEETS.context, [
    { header: "Section", key: "section", width: 20 }, { header: "ID", key: "id", width: 8 }, { header: "Item", key: "item", width: 50, wrap: true },
    { header: "Detail / expected", key: "detail", width: 70, wrap: true }, { header: "Status", key: "status", width: 18 },
    { header: "Sources", key: "sources", width: 40, wrap: true },
  ], contextRows);

  addTable(wb, SHEETS.triage, [
    { header: "Key", key: "key", width: 13, link: "url" }, { header: "Summary", key: "summary", width: 50, wrap: true },
    { header: "Epic", key: "epic", width: 30, wrap: true }, { header: "Module", key: "module", width: 22 },
    { header: "Module source", key: "moduleSource", width: 22, wrap: true }, { header: "Status", key: "status", width: 13 },
    { header: "Labels", key: "labels", width: 14 }, { header: "Created", key: "created", width: 11 }, { header: "Updated", key: "updated", width: 11 },
    { header: "AC source", key: "acSource", width: 12 }, { header: "Testable", key: "testable", width: 10 },
    { header: "Decided by", key: "decidedBy", width: 24 }, { header: "Agent flags (AC quality)", key: "flags", width: 35, wrap: true },
    { header: "Reasoning", key: "reasoning", width: 70, wrap: true },
  ], triageRows);

  addTable(wb, SHEETS.links, [
    { header: "Key", key: "key", width: 13, link: "url" }, { header: "Module", key: "module", width: 22 },
    { header: "Related stories followed", key: "related", width: 26, wrap: true }, { header: "Linked Zephyr cases", key: "linked", width: 40, wrap: true },
    { header: "# linked", key: "count", width: 9 }, { header: "Result", key: "result", width: 30 }, { header: "Reasoning", key: "reasoning", width: 70, wrap: true },
  ], linkRows);

  addTable(wb, SHEETS.expected, [
    { header: "ID", key: "id", width: 28 }, { header: "Story", key: "story", width: 13, link: "storyUrl" }, { header: "Module", key: "module", width: 20 },
    { header: "Source", key: "source", width: 10 }, { header: "UC / flow", key: "uc", width: 14 }, { header: "Scenario", key: "scenario", width: 45, wrap: true },
    { header: "Type", key: "type", width: 12 }, { header: "Priority hint", key: "priorityHint", width: 10 }, { header: "Steps", key: "steps", width: 50, wrap: true },
    { header: "Expected", key: "expected", width: 40, wrap: true }, { header: "Evidence", key: "evidence", width: 45, wrap: true, link: "evidenceUrl" },
    { header: "Code / UI only?", key: "codeOnly", width: 16 }, { header: "Agent review", key: "agentReview", width: 26, wrap: true },
    { header: "Derivation reasoning", key: "reasoning", width: 70, wrap: true },
  ], expectedRows);

  addTable(wb, SHEETS.ui, [
    { header: "Kind", key: "kind", width: 15 }, { header: "ID", key: "id", width: 16 }, { header: "Screen", key: "screen", width: 24, wrap: true },
    { header: "URL", key: "url", width: 30, wrap: true }, { header: "Functionality / item", key: "what", width: 45, wrap: true },
    { header: "Action", key: "action", width: 40, wrap: true }, { header: "Observed result", key: "result", width: 40, wrap: true },
    { header: "Element (role / name / text)", key: "element", width: 35, wrap: true }, { header: "Confidence", key: "confidence", width: 11 },
    { header: "Screenshot", key: "screenshot", width: 30, link: "screenshotUrl" }, { header: "Reasoning / uncertainty", key: "reasoning", width: 60, wrap: true },
  ], uiRows);

  addTable(wb, SHEETS.cases, [
    { header: "Key", key: "key", width: 12, link: "url" }, { header: "Name", key: "name", width: 50, wrap: true }, { header: "Folder", key: "folder", width: 40, wrap: true },
    { header: "Labels", key: "labels", width: 20 }, { header: "Status", key: "status", width: 11 }, { header: "Priority", key: "priority", width: 9 },
    { header: "Automation", key: "automation", width: 13 }, { header: "Linked issue ids", key: "linkedTo", width: 14 }, { header: "Compared for stories", key: "forStories", width: 18 },
    { header: "Objective / BDD (normalized)", key: "normalized", width: 60, wrap: true }, { header: "Reasoning", key: "reasoning", width: 45, wrap: true },
  ], caseRows);

  addTable(wb, SHEETS.matching, [
    { header: "Expected ID", key: "id", width: 28 }, { header: "Story", key: "story", width: 13, link: "storyUrl" }, { header: "Module", key: "module", width: 18 },
    { header: "Scenario", key: "scenario", width: 45, wrap: true }, { header: "Matched case(s)", key: "matched", width: 22, wrap: true },
    { header: "Verdict", key: "verdict", width: 10, color: true }, { header: "Confidence", key: "confidence", width: 11 }, { header: "Auto-accepted", key: "autoAccepted", width: 12 },
    { header: "Decided by", key: "decidedBy", width: 12 }, { header: "Scope", key: "scope", width: 18 },
    { header: "Missing aspects", key: "missing", width: 40, wrap: true }, { header: "Match reasoning", key: "reasoning", width: 70, wrap: true },
  ], matchRows);

  addTable(wb, SHEETS.design, [
    { header: "TC ID", key: "tcId", width: 9 }, { header: "Story", key: "story", width: 13, link: "storyUrl" }, { header: "Designed case", key: "title", width: 45, wrap: true },
    { header: "Should be tested because", key: "whyNeeded", width: 55, wrap: true }, { header: "Basis (rules / workflows)", key: "basis", width: 22, wrap: true },
    { header: "Scenarios", key: "scenarios", width: 24, wrap: true }, { header: "Flow", key: "flow", width: 9 }, { header: "Type", key: "type", width: 11 },
    { header: "Steps", key: "steps", width: 50, wrap: true }, { header: "Expected", key: "expected", width: 40, wrap: true },
    { header: "Verdict", key: "verdict", width: 10, color: true }, { header: "Covered by", key: "matched", width: 16, wrap: true }, { header: "Confidence", key: "confidence", width: 11 },
    { header: "Missing aspects", key: "missing", width: 40, wrap: true }, { header: "Check reasoning", key: "reasoning", width: 60, wrap: true },
    { header: "Gap ID", key: "gapId", width: 22 },
  ], designRows);

  const gapWs = addTable(wb, SHEETS.gaps, [
    { header: "Gap ID", key: "gapId", width: 20 }, { header: "Story", key: "story", width: 13, link: "storyUrl" }, { header: "Module", key: "module", width: 18 },
    { header: "Scenario", key: "scenario", width: 40, wrap: true }, { header: "Source", key: "source", width: 9 }, { header: "Type", key: "type", width: 11 },
    { header: "Verdict", key: "verdict", width: 10, color: true }, { header: "Partially covered by", key: "matched", width: 14 },
    { header: "Why it is a gap", key: "gapReasoning", width: 50, wrap: true }, { header: "Agent review", key: "agentReview", width: 24, wrap: true },
    { header: "Validation", key: "validation", width: 40, wrap: true },
    { header: "Suggested decision", key: "suggested", width: 11, color: true }, { header: "Decision reasoning", key: "decisionReasoning", width: 50, wrap: true },
    { header: "Review decision", key: "decision", width: 11, color: true }, { header: "Reviewer notes", key: "notes", width: 30, wrap: true },
    { header: "Action", key: "action", width: 8 }, { header: "Extend key", key: "extendKey", width: 12 },
    { header: "Draft name", key: "name", width: 45, wrap: true }, { header: "Objective", key: "objective", width: 45, wrap: true },
    { header: "Precondition", key: "precondition", width: 35, wrap: true },
    { header: "Steps (n. action [data: x] => expected)", key: "steps", width: 70, wrap: true },
    { header: "BDD", key: "bdd", width: 40, wrap: true }, { header: "Labels", key: "labels", width: 20 },
    { header: "Priority", key: "priority", width: 9 }, { header: "Priority reasoning", key: "priorityReasoning", width: 40, wrap: true },
    { header: "Folder id", key: "folderId", width: 10 }, { header: "Folder path", key: "folderPath", width: 40, wrap: true }, { header: "Folder reasoning", key: "folderReasoning", width: 40, wrap: true },
    { header: "Created key", key: "createdKey", width: 12, link: "createdUrl" }, { header: "Story issue id", key: "storyId", width: 10, hidden: true },
    { header: "Expected ID", key: "expectedId", width: 10, hidden: true },
  ], gapRows);
  const decisionCol = gapWs.getColumn("decision").number;
  for (let r = 2; r <= gapRows.length + 1; r++) {
    gapWs.getCell(r, decisionCol).dataValidation = { type: "list", allowBlank: false, formulae: [`"${REVIEW_OPTIONS.join(",")}"`] };
  }

  addTable(wb, SHEETS.orphans, [
    { header: "Key", key: "key", width: 12, link: "url" }, { header: "Linked story", key: "story", width: 13 }, { header: "Name", key: "name", width: 50, wrap: true },
    { header: "Folder", key: "folder", width: 40, wrap: true }, { header: "Reasoning", key: "reasoning", width: 70, wrap: true },
  ], orphanRows);

  addTable(wb, SHEETS.agents, [
    { header: "Agent", key: "agent", width: 20 }, { header: "Phase", key: "phase", width: 10 }, { header: "Status", key: "status", width: 10 },
    { header: "Model", key: "model", width: 10 }, { header: "Tokens", key: "tokens", width: 11 }, { header: "Duration s", key: "duration", width: 10 },
    { header: "Result from", key: "reusedFrom", width: 22 }, { header: "Findings", key: "findings", width: 90, wrap: true },
    { header: "Forwarded notes", key: "forwardNotes", width: 50, wrap: true }, { header: "Review file", key: "reviewFile", width: 22 },
    { header: "Applied by a later stage", key: "applied", width: 40, wrap: true },
  ], agentSheetRows);

  addTable(wb, SHEETS.reviews, [
    { header: "Agent", key: "agent", width: 20 }, { header: "Section", key: "section", width: 16 }, { header: "ID", key: "id", width: 28 },
    { header: "Title / decision", key: "title", width: 45, wrap: true }, { header: "Reasoning", key: "reasoning", width: 60, wrap: true },
    { header: "Full item (JSON)", key: "detail", width: 80, wrap: true },
  ], reviewRows);

  addTable(wb, SHEETS.runLog, [
    { header: "Step", key: "step", width: 22 }, { header: "Module / batch", key: "batch", width: 24 }, { header: "Time", key: "at", width: 20 },
    { header: "In", key: "countIn", width: 8 }, { header: "Out", key: "countOut", width: 8 }, { header: "Details / assumptions", key: "notes", width: 80, wrap: true },
    { header: "Skipped + why", key: "skipped", width: 50, wrap: true }, { header: "Errors", key: "errors", width: 50, wrap: true },
  ], runLog);

  addTable(wb, SHEETS.tokens, [
    { header: "Time", key: "at", width: 20 }, { header: "Stage", key: "stage", width: 12 }, { header: "Module", key: "module", width: 20 },
    { header: "Jira keys", key: "keys", width: 24, wrap: true }, { header: "Model", key: "model", width: 18 }, { header: "Reused (cache)", key: "reused", width: 9 },
    { header: "Failed", key: "failed", width: 8 }, { header: "Input", key: "input_tokens", width: 9 }, { header: "Output", key: "output_tokens", width: 9 },
    { header: "Cache read", key: "cache_read_tokens", width: 10 }, { header: "Cache write", key: "cache_creation_tokens", width: 10 }, { header: "Total", key: "total", width: 10 },
    { header: "Duration ms", key: "duration_ms", width: 11 }, { header: "Turns", key: "num_turns", width: 7 },
    { header: "Prompt bytes", key: "input_bytes", width: 11 }, { header: "Items in", key: "items_in", width: 8 }, { header: "Items out", key: "items_out", width: 8 },
    { header: "Error", key: "error", width: 40, wrap: true },
  ], tokenRecords.map(({ cost_usd, ...r }) => ({
    ...r, keys: (r.jiraKeys ?? []).join(", "), reused: r.reused ? "Yes" : "No", failed: r.failed ? "Yes" : "",
    total: r.reused ? 0 : totalTokens(r),
    ...(r.reused ? { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } : {}),
  })));

  await wb.xlsx.writeFile(file);
  return { sheets: wb.worksheets.map((w) => w.name), counts: { triage: triageRows.length, expected: expectedRows.filter((r) => !r.id.endsWith(":skipped") && !r.scenario.startsWith("(dropped)")).length, matches: matchRows.filter((r) => r.scope === "Gap analysis").length, gaps: gapRows.length, orphans: orphanRows.length } };
}
