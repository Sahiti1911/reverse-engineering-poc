// The gaps workbook (gaps_<profile>_<scope>.xlsx): a short second Excel next to the full one, with two sheets.
//   Gaps                 requirement gaps (Unclear / Missing / Incomplete / Open question) and test-case gaps
//                        (Missing / Incomplete), each with reason, suggested fix, severity and evidence ids
//   Supporting Evidence  one row per source (story, AC, code, UI, Zephyr case, module context), shared by gaps
// Candidates and evidence are collected by script (0 tokens); the gap-review stage (prompts/gap-review.md) sets
// severity for every gap and writes the requirement gaps' type, wording and suggested fix. Without that review
// (dry run, budget, error) a rule decides severity and says so.
import ExcelJS from "exceljs";
import { HEADER_FILL } from "./workbook.mjs";
import { hash } from "./util.mjs";

export const SEVERITY = { 1: "1 – Impacts functionality", 2: "2 – Impacts traceability", 3: "3 – Good to have" };
export const GAP_TYPES = { Requirement: ["Unclear", "Missing", "Incomplete", "Open question"], "Test case": ["Missing", "Incomplete"] };
const SEVERITY_FILL = { 1: "FFFFC7CE", 2: "FFFFEB9C", 3: "FFD9E1F2" };

// ---------------------------------------------------------------- evidence references
const zephyrRef = (key, detail, urls) => ({ kind: "Zephyr case", ref: key, detail, url: urls.zephyr(key) });
const storyRef = (key, r, urls) => ({ kind: "Jira story", ref: key, detail: r?.story.summary ?? "", url: urls.jira(key) });

// Pipeline ids that look like Jira keys but are not: scenario, UC, rule, designed-case and UI ids.
const LOCAL_ID = /^(CODE|UC|S|R|TC|UI|UIX)-\d+/;

/** A module-context source string: scenario id, UI id, story key (optionally with a UC), Zephyr key or file path. */
function sourceRef(src, ctx) {
  const s = String(src).trim();
  const e = ctx.scenarioById.get(s) ?? (LOCAL_ID.test(s) ? [...ctx.scenarioById.values()].find((x) => x.id.endsWith(`:${s}`)) : null);
  if (e) return scenarioRefs(e, ctx)[0] ?? { kind: "Module context", ref: s, detail: "", url: null };
  if (/^UI-\d+/.test(s)) return uiInventoryRef(s, ctx) ?? { kind: "UI", ref: s, detail: "", url: null };
  if (LOCAL_ID.test(s)) return { kind: "Module context", ref: s, detail: "", url: null };
  if (/^[A-Z][A-Z0-9_]*-T\d+$/.test(s)) return zephyrRef(s, "Named as a source in the module context", ctx.urls);
  const story = s.match(/^([A-Z][A-Z0-9_]*-\d+)(?:\s+(.+))?$/);
  if (story) {
    const ref = storyRef(story[1], ctx.byKey.get(story[1]), ctx.urls);
    return story[2] ? { ...ref, kind: "Acceptance criteria", ref: s } : ref;
  }
  if (/[/\\]/.test(s) || /\.\w{1,5}$/.test(s)) return { kind: "Code", ref: s, detail: "", url: null };
  return { kind: "Module context", ref: s, detail: "", url: null };
}

function screenshotUrl(file, ctx) {
  if (!file) return null;
  const p = file.includes("/") ? file : `ui/${file}`;
  return ctx.screenshots.has(p) ? p : null;
}

function uiInventoryRef(id, ctx) {
  const i = ctx.ui?.inventory?.find((x) => x.id === id);
  if (!i) return null;
  return { kind: "UI", ref: `${i.id} ${i.screen ?? ""}`.trim(), detail: [i.functionality, i.action, i.result].filter(Boolean).join(" → "), url: screenshotUrl(i.screenshot, ctx) ?? i.url ?? null };
}

/** Where a scenario comes from: its code location, its AC / UC text or its UI evidence, plus what the UI explorer saw. */
function scenarioRefs(e, ctx) {
  const refs = [];
  if (e.evidence && typeof e.evidence === "object") {
    refs.push({ kind: "Code", ref: `${e.evidence.path}${e.evidence.symbol ? ` :: ${e.evidence.symbol}` : ""}`, detail: e.evidence.detail ?? "", url: ctx.urls.code(e.repo, e.evidence.path) });
  } else if (e.evidence) {
    const ui = e.uiOnly || /^UI\b/.test(e.evidence);
    const shot = String(e.evidence).match(/screenshot ([^)\s]+)\)/)?.[1];
    refs.push({ kind: ui ? "UI" : "Acceptance criteria", ref: e.uc ? `${e.storyKey} ${e.uc}` : e.id, detail: String(e.evidence), url: ui ? screenshotUrl(shot, ctx) : ctx.urls.jira(e.storyKey) });
  }
  const seen = ctx.ui?.observations?.find((o) => o.id === e.id);
  if (seen) refs.push({ kind: "UI", ref: `checked ${e.id}`, detail: `${seen.status}: ${seen.reasoning}`, url: null });
  return refs;
}

// ---------------------------------------------------------------- candidates
const short = (s, n = 90) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ""));

/**
 * Requirement-gap candidates from what the pipeline already recorded: AC-quality flags, undecided triage, stories
 * without scenarios, skipped UCs, behaviour found only in code or UI, and the module context's open questions,
 * unconfirmed rules and known issues. `hint` is the suggested gap type; gap-review may change it.
 */
export function requirementGapCandidates({ stories, moduleContext, ctx }) {
  const out = [];
  const add = (o) => out.push({ category: "Requirement", story: "", ...o });
  for (const r of stories) {
    if (r.dropped) continue;
    const key = r.story.key;
    const story = storyRef(key, r, ctx.urls);
    for (const f of r.flags ?? []) add({ story: key, hint: "Unclear", source: "ac-flag", title: `AC: ${short(f.issue)}`, description: f.issue, gapReason: `The requirements-analyst flagged the acceptance criteria: ${f.issue}`, refs: [story] });
    if (r.triage?.testable === null) add({ story: key, hint: "Unclear", source: "triage", title: `Cannot tell whether ${key} is testable`, description: r.story.summary, gapReason: r.triage.reasoning || "Triage could not decide.", refs: [story] });
    if (r.extractNote) add({ story: key, hint: "Incomplete", source: "no-scenarios", title: `No testable scenario in ${key}`, description: r.story.summary, gapReason: r.extractNote, refs: [story] });
    for (const sk of r.skippedUcs ?? []) {
      if (sk.offTopic) continue;
      add({ story: key, hint: "Incomplete", source: "skipped-uc", title: `${sk.uc} ${short(sk.title, 70)} not analysed`, description: sk.title, gapReason: sk.reasoning, refs: [{ ...story, kind: "Acceptance criteria", ref: `${key} ${sk.uc}`, detail: sk.title }] });
    }
    for (const e of r.expected ?? []) {
      if (!e.codeOnly && !e.uiOnly && !e.suspectedBug && e.codeReview !== "needs PO confirmation") continue;
      const where = e.uiOnly ? "the UI" : "the code";
      const hint = e.suspectedBug ? "Incomplete" : e.codeReview === "needs PO confirmation" ? "Unclear" : "Missing";
      const why = e.suspectedBug ? `Suspected bug: ${where} behaves in a way no requirement explains.`
        : e.codeReview === "needs PO confirmation" ? `Found in ${where}; the code-analyst could not tell whether it is intended.`
        : `Behaviour exists in ${where} but no story describes it.`;
      add({ story: key, hint, source: e.suspectedBug ? "suspected-bug" : e.uiOnly ? "ui-only" : "code-only", scenarioId: e.id, title: short(e.title), description: `${e.title}. Expected: ${e.expected}`, gapReason: `${why} ${e.reasoning ?? ""}`.trim(), refs: [story, ...scenarioRefs(e, ctx)] });
    }
  }
  const mc = moduleContext ?? {};
  for (const q of mc.openQuestions ?? []) {
    add({ hint: "Open question", source: "open-question", title: short(q.question), description: q.question, gapReason: `Open question in the module context${q.affects?.length ? `; affects ${q.affects.join(", ")}` : ""}.`, refs: (q.sources ?? []).map((s) => sourceRef(s, ctx)) });
  }
  const RULE_HINT = { "needs-confirmation": "Unclear", "code-only": "Missing", "ui-only": "Missing", "suspected-bug": "Incomplete" };
  for (const rule of mc.rules ?? []) {
    if (!RULE_HINT[rule.status]) continue;
    add({ hint: RULE_HINT[rule.status], source: `rule-${rule.status}`, ruleId: rule.id, title: `${rule.id}: ${short(rule.rule, 80)}`, description: `${rule.rule}${rule.expected ? ` Expected: ${rule.expected}` : ""}`, gapReason: `Module-context rule ${rule.id} (${rule.kind}) has status ${rule.status}.`, refs: (rule.sources ?? []).map((s) => sourceRef(s, ctx)) });
  }
  for (const k of mc.knownIssues ?? []) {
    add({ hint: "Incomplete", source: "known-issue", title: short(k.issue), description: k.issue, gapReason: "Known issue recorded in the module context.", refs: (k.sources ?? []).map((s) => sourceRef(s, ctx)) });
  }
  return out.map((o, i) => ({ id: `REQ-${String(i + 1).padStart(2, "0")}`, ...o }));
}

/** Test-case gaps from the existing gaps (9_Gaps): Missing stays Missing, Partial becomes Incomplete. */
export function testCaseGapItems({ stories, ctx }) {
  const out = [];
  for (const r of stories) {
    for (const g of r.gaps ?? []) {
      const d = g.draft ?? {};
      const e = ctx.scenarioById.get(g.expectedId) ?? null;
      const scenarios = (g.scenarioIds ?? []).map((id) => ctx.scenarioById.get(id)).filter(Boolean);
      const fix = d.name
        ? d.action === "extend" && d.extendKey ? `Extend ${d.extendKey}: add ${d.steps?.length ?? 0} step(s) — ${d.name}` : `Create "${d.name}"${d.folderPath ? ` in ${d.folderPath}` : ""} (${d.steps?.length ?? 0} steps)`
        : "Write a test case for this scenario (no draft was produced).";
      const dup = g.validation?.duplicateOf?.length ? ` Check first: possible duplicate of ${g.validation.duplicateOf.join(", ")}.` : "";
      out.push({
        id: g.gapId, category: "Test case", story: r.story.key, hint: g.verdict === "Partial" ? "Incomplete" : "Missing", gapType: g.verdict === "Partial" ? "Incomplete" : "Missing",
        source: g.source, flow: e?.flow ?? scenarios[0]?.flow ?? "", suspectedBug: !!g.suspectedBug,
        title: short(g.scenario, 120), description: `${g.scenario}${g.missingAspects ? ` Missing: ${g.missingAspects}` : ""}`,
        gapReason: g.reasoning, suggestedFix: fix + dup,
        refs: [
          storyRef(r.story.key, r, ctx.urls),
          ...[e, ...scenarios].filter(Boolean).flatMap((x) => scenarioRefs(x, ctx)),
          ...(g.matchedKeys ?? []).map((k) => zephyrRef(k, "Covers part of this scenario", ctx.urls)),
          ...(g.validation?.duplicateOf ?? []).map((k) => zephyrRef(k, "Possible duplicate of the draft", ctx.urls)),
        ],
      });
    }
  }
  return out;
}

/** Everything the gap report needs from a run, keyed for lookups. */
export function gapContext({ stories, ui = null, urls }) {
  return {
    urls, ui,
    byKey: new Map(stories.map((r) => [r.story.key, r])),
    scenarioById: new Map(stories.flatMap((r) => (r.expected ?? []).map((e) => [e.id, e]))),
    screenshots: new Set(ui?.screenshots ?? []),
  };
}

/** All gap items of a run, before review: requirement candidates first, then test-case gaps. */
export function collectGapItems({ stories, moduleContext = null, ui = null, urls }) {
  const ctx = gapContext({ stories, ui, urls });
  return [...requirementGapCandidates({ stories, moduleContext, ctx }), ...testCaseGapItems({ stories, ctx })];
}

// ---------------------------------------------------------------- review
/** What gap-review sees of an item (also its signature: a review applies only while this is unchanged). */
export const reviewInput = (it) => ({
  id: it.id, category: it.category, story: it.story, suggestedType: it.hint, source: it.source, title: it.title, description: it.description,
  gapReason: it.gapReason, ...(it.suggestedFix ? { suggestedFix: it.suggestedFix } : {}), ...(it.flow ? { flow: it.flow } : {}),
  evidence: it.refs.map((r) => short(`${r.kind} ${r.ref}${r.detail ? `: ${r.detail}` : ""}`, 240)),
});
export const reviewSignature = (it) => hash(reviewInput(it));

/** Suggested fix for a requirement gap Claude did not review: one standard action per kind of candidate. */
export function defaultFix(it) {
  const where = it.story ? ` in ${it.story}` : "";
  switch (it.source) {
    case "ac-flag": return `Clarify the acceptance criteria${where}: ${it.description}`;
    case "triage": return `Add acceptance criteria to ${it.story} so it can be tested, or mark it as not testable.`;
    case "no-scenarios": return `Add testable acceptance criteria to ${it.story} (Given / When / Then).`;
    case "skipped-uc": return `Decide whether ${it.title.split(" ")[0]}${where} is in scope; if so, include it in the analysis.`;
    case "suspected-bug": case "rule-suspected-bug": return "Confirm with the developer and product owner; log a bug if the behaviour is not intended, or add it to the requirements if it is.";
    case "code-only": case "ui-only": case "rule-code-only": case "rule-ui-only": return `Confirm with the product owner that this behaviour is intended, then add it to the acceptance criteria${where || " of the module's story"}.`;
    case "rule-needs-confirmation": return "Ask the product owner to confirm this rule and record the answer in the story.";
    case "open-question": return `Ask the product owner: ${it.description}`;
    case "known-issue": return "Log a bug (or link the existing one) and add the expected behaviour to the requirements.";
    default: return "";
  }
}

/** Severity when Claude did not review the item. */
export function defaultSeverity(it) {
  if (it.suspectedBug || it.source === "suspected-bug" || it.source === "rule-suspected-bug" || it.source === "known-issue") {
    return { severity: 1, severityReasoning: "Rule default — not reviewed by Claude: a suspected bug or known issue affects how the feature works." };
  }
  if (it.category === "Test case" && it.gapType === "Missing" && it.flow === "main") {
    return { severity: 1, severityReasoning: "Rule default — not reviewed by Claude: the main flow has no test." };
  }
  if (it.category === "Requirement") return { severity: 2, severityReasoning: "Rule default — not reviewed by Claude: an unclear or untraced requirement weakens traceability." };
  return { severity: 3, severityReasoning: "Rule default — not reviewed by Claude: alternative, boundary or partial coverage." };
}

/**
 * Apply stored reviews ({ [id]: { sig, keep, keepReasoning, gapType, title, ..., severity, severityReasoning } }).
 * A review whose signature no longer matches the item (the gap changed since) is ignored. Returns kept and dropped items.
 */
export function applyGapReview(items, reviews = {}) {
  const kept = [];
  const dropped = [];
  for (const it of items) {
    const rv = reviews[it.id];
    if (!rv || rv.sig !== reviewSignature(it)) {
      kept.push({ ...it, gapType: it.gapType ?? it.hint, suggestedFix: it.suggestedFix ?? defaultFix(it), ...defaultSeverity(it), reviewedBy: "rule" });
      continue;
    }
    if (it.category === "Requirement" && rv.keep === false) {
      dropped.push({ ...it, dropReasoning: rv.keepReasoning || "Dropped by gap-review." });
      continue;
    }
    const own = it.category === "Requirement";
    const gapType = own && GAP_TYPES.Requirement.includes(rv.gapType) ? rv.gapType : it.gapType ?? it.hint;
    kept.push({
      ...it, gapType,
      title: (own && rv.title?.trim()) || it.title,
      description: (own && rv.description?.trim()) || it.description,
      gapReason: (own && rv.gapReason?.trim()) || it.gapReason,
      suggestedFix: (own && rv.suggestedFix?.trim()) || it.suggestedFix || defaultFix(it),
      severity: [1, 2, 3].includes(Number(rv.severity)) ? Number(rv.severity) : defaultSeverity(it).severity,
      severityReasoning: rv.severityReasoning?.trim() || defaultSeverity(it).severityReasoning,
      reviewedBy: "Claude",
    });
  }
  return { kept, dropped };
}

/** One evidence row per distinct source (EV-01…), and each item's evidence ids. Items sorted by severity, then category. */
export function finalizeGapReport(kept) {
  const evidence = new Map();
  const items = [...kept]
    .sort((a, b) => a.severity - b.severity || (a.category === b.category ? 0 : a.category === "Requirement" ? -1 : 1) || a.id.localeCompare(b.id, "en", { numeric: true }))
    .map((it) => {
      const ids = [];
      for (const r of it.refs) {
        const k = `${r.kind}|${r.ref}|${r.detail}`;
        if (!evidence.has(k)) evidence.set(k, { id: `EV-${String(evidence.size + 1).padStart(2, "0")}`, kind: r.kind, ref: r.ref, detail: r.detail, url: r.url ?? null, usedBy: [] });
        const ev = evidence.get(k);
        if (!ev.usedBy.includes(it.id)) ev.usedBy.push(it.id);
        if (!ids.includes(ev.id)) ids.push(ev.id);
      }
      const { refs, ...rest } = it;
      return { ...rest, evidence: ids };
    });
  return { items, evidence: [...evidence.values()] };
}

// ---------------------------------------------------------------- workbook
const GAP_COLUMNS = [
  { header: "ID", key: "id", width: 20 }, { header: "Category", key: "category", width: 12 }, { header: "Story", key: "story", width: 13, link: "storyUrl" },
  { header: "Title", key: "title", width: 45, wrap: true }, { header: "Description", key: "description", width: 55, wrap: true },
  { header: "Gap type", key: "gapType", width: 14 }, { header: "Gap reason", key: "gapReason", width: 55, wrap: true },
  { header: "Suggested fix", key: "suggestedFix", width: 55, wrap: true }, { header: "Severity", key: "severityLabel", width: 24, severity: true },
  { header: "Severity reasoning", key: "severityReasoning", width: 50, wrap: true }, { header: "Reviewed by", key: "reviewedBy", width: 11 },
  { header: "Evidence", key: "evidenceIds", width: 22, wrap: true },
];
const EVIDENCE_COLUMNS = [
  { header: "Evidence ID", key: "id", width: 11 }, { header: "Kind", key: "kind", width: 18 }, { header: "Reference", key: "ref", width: 45, wrap: true, link: "url" },
  { header: "Detail", key: "detail", width: 80, wrap: true }, { header: "Used by gaps", key: "usedByText", width: 30, wrap: true },
];

/** A table starting at `top`: header row, rows, links, wrapping, severity colours, filter. */
function writeTable(ws, top, columns, rows) {
  columns.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });
  const head = ws.getRow(top);
  columns.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = HEADER_FILL;
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  head.height = 30;
  rows.forEach((row, n) => {
    const r = ws.getRow(top + 1 + n);
    columns.forEach((c, i) => {
      const cell = r.getCell(i + 1);
      const v = row[c.key] ?? "";
      cell.value = c.link && row[c.link] ? { text: String(v), hyperlink: row[c.link] } : v;
      if (c.link && row[c.link]) cell.font = { color: { argb: "FF0563C1" }, underline: true };
      cell.alignment = c.wrap ? { wrapText: true, vertical: "top" } : { vertical: "top" };
      if (c.severity && SEVERITY_FILL[row.severity]) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEVERITY_FILL[row.severity] } };
    });
  });
  ws.views = [{ state: "frozen", ySplit: top }];
  if (rows.length) ws.autoFilter = { from: { row: top, column: 1 }, to: { row: top, column: columns.length } };
}

/**
 * Summary sheet, laid out like the full workbook's: run facts, sheet index, gaps by category and type, by severity,
 * by story, the severity-1 gaps to act on first (linked to their Gaps row) and what gap-review dropped.
 */
function writeSummary(ws, { report, title, runAt, urls, tokens, facts, storySummary, sheets }) {
  ws.columns = Array.from({ length: 9 }, () => ({ width: 16 }));
  ws.getColumn(1).width = 30;
  ws.getColumn(2).width = 30;
  const titleRow = (text) => { ws.addRow([text]).font = { bold: true, size: 13, color: { argb: "FF1F3864" } }; };
  const header = (cells) => {
    const r = ws.addRow(cells);
    r.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = HEADER_FILL; c.alignment = { wrapText: true, vertical: "middle" }; });
  };
  // A long text in column `from` spans to column 9 so it stays readable next to the narrow number columns.
  const span = (r, from) => { ws.mergeCells(r.number, from, r.number, 9); r.getCell(from).alignment = { wrapText: true, vertical: "top" }; };
  const link = (cell, text, target) => { cell.value = { text, hyperlink: target }; cell.font = { color: { argb: "FF0563C1" }, underline: true }; };
  const sevFill = (cell, s) => { if (SEVERITY_FILL[s]) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: SEVERITY_FILL[s] } }; };
  const items = report.items;
  const count = (f) => items.filter(f).length;
  const bySev = (f) => [1, 2, 3].map((s) => count((i) => f(i) && i.severity === s));
  const total = (f) => count(f);

  titleRow(title);
  const reviewed = count((i) => i.reviewedBy === "Claude");
  for (const [k, v] of [
    ["Run at", runAt],
    ...facts,
    ["Gaps", `${items.length} (${count((i) => i.category === "Requirement")} requirement, ${count((i) => i.category === "Test case")} test case)`],
    ["Reviewed by Claude", `${reviewed} of ${items.length}${reviewed < items.length ? ` — the rest have severity and fix by rule (dry run, token budget or error)` : ""}`],
    ["Gap-review tokens", Number(tokens).toLocaleString("en-US")],
  ]) span(ws.addRow([k, v]), 2);
  ws.addRow([]);

  titleRow("Sheets");
  header(["Sheet", "Rows", "What it holds"]);
  span(ws.lastRow, 3);
  for (const [name, rows, what] of sheets) {
    const r = ws.addRow(["", rows, what]);
    link(r.getCell(1), name, `#'${name}'!A1`);
    span(r, 3);
  }
  ws.addRow([]);

  titleRow("Severity");
  header(["Severity", "Requirement", "Test case", "Total"]);
  for (const s of [1, 2, 3]) {
    const r = ws.addRow([SEVERITY[s], count((i) => i.severity === s && i.category === "Requirement"), count((i) => i.severity === s && i.category === "Test case"), count((i) => i.severity === s)]);
    sevFill(r.getCell(1), s);
  }
  ws.addRow(["TOTAL", count((i) => i.category === "Requirement"), count((i) => i.category === "Test case"), items.length]).font = { bold: true };
  ws.addRow([]);

  titleRow("Gaps by category and type");
  header(["Category", "Gap type", "Total", "Severity 1", "Severity 2", "Severity 3"]);
  for (const [cat, types] of Object.entries(GAP_TYPES)) {
    for (const t of types) {
      const f = (i) => i.category === cat && i.gapType === t;
      if (total(f)) ws.addRow([cat, t, total(f), ...bySev(f)]);
    }
  }
  ws.addRow(["TOTAL", "", items.length, ...bySev(() => true)]).font = { bold: true };
  ws.addRow([]);

  titleRow("Gaps by story (module-level items have no story)");
  header(["Story", "Summary", "Requirement", "Test case", "Severity 1", "Severity 2", "Severity 3", "Total"]);
  const stories = [...new Set(items.map((i) => i.story))]
    .map((key) => ({ key, f: (i) => i.story === key }))
    .sort((a, b) => total(b.f) - total(a.f) || a.key.localeCompare(b.key));
  for (const { key, f } of stories) {
    const r = ws.addRow(["", key ? storySummary[key] ?? "" : "Module context (no single story)", count((i) => f(i) && i.category === "Requirement"), count((i) => f(i) && i.category === "Test case"), ...bySev(f), total(f)]);
    if (key) link(r.getCell(1), key, urls.jira(key)); else r.getCell(1).value = "(module)";
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
  }
  ws.addRow([]);

  const first = items.map((it, n) => ({ it, row: n + 2 })).filter(({ it }) => it.severity === 1);
  titleRow(`Severity 1 — impacts functionality, act first (${first.length})`);
  header(["Gap", "Title", "Category / type", "Suggested fix"]);
  span(ws.lastRow, 4);
  for (const { it, row } of first) {
    const r = ws.addRow(["", it.title, `${it.category} / ${it.gapType}`, it.suggestedFix]);
    link(r.getCell(1), it.id, `#'Gaps'!A${row}`);
    r.getCell(2).alignment = { wrapText: true, vertical: "top" };
    span(r, 4);
  }
  ws.addRow([]);

  if (report.dropped?.length) {
    titleRow(`Dropped by gap-review as not a requirement gap (${report.dropped.length})`);
    header(["Candidate", "Title", "Why dropped"]);
    span(ws.lastRow, 3);
    for (const d of report.dropped) {
      const r = ws.addRow([d.id, d.title, d.dropReasoning]);
      r.getCell(2).alignment = { wrapText: true, vertical: "top" };
      span(r, 3);
    }
    ws.addRow([]);
  }
  ws.addRow(["Severity: 1 users get wrong results, lose data or are blocked, or the main flow is untested · 2 it likely works but requirements and tests do not show it · 3 cosmetic, rare edge case, wording. Test-case gap ids match sheet 9_Gaps of the full workbook, where drafts are reviewed and approved."]).font = { italic: true, size: 9 };
}

/** gaps_<profile>_<scope>.xlsx. Throws when a gap has no reason or no severity reasoning. */
export async function buildGapsWorkbook({ file, report, title, runAt, urls, tokens = 0, facts = [], storySummary = {} }) {
  const missing = report.items.flatMap((it) => [
    ...(String(it.gapReason ?? "").trim() ? [] : [`Gaps: ${it.id} has no gap reason`]),
    ...(String(it.severityReasoning ?? "").trim() ? [] : [`Gaps: ${it.id} has no severity reasoning`]),
  ]);
  if (missing.length) {
    const err = new Error(`Gaps workbook rejected: ${missing.length} row(s) without reasoning:\n  ${missing.slice(0, 20).join("\n  ")}`);
    err.problems = missing;
    throw err;
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = "coverage-gap-analysis";
  wb.created = new Date();

  writeSummary(wb.addWorksheet("Summary"), {
    report, title, runAt, urls, tokens, facts, storySummary,
    sheets: [
      ["Gaps", report.items.length, "Requirement and test-case gaps: type, reason, suggested fix, severity, evidence ids. Sorted by severity."],
      ["Supporting Evidence", report.evidence.length, "One row per source (story, AC / UC, code, UI, Zephyr case, module context), with the gaps that use it."],
    ],
  });

  const ws = wb.addWorksheet("Gaps");
  writeTable(ws, 1, GAP_COLUMNS, report.items.map((it) => ({
    ...it, storyUrl: it.story ? urls.jira(it.story) : null, severityLabel: SEVERITY[it.severity], evidenceIds: it.evidence.join(", "),
  })));

  const ev = wb.addWorksheet("Supporting Evidence");
  writeTable(ev, 1, EVIDENCE_COLUMNS, report.evidence.map((e) => ({ ...e, usedByText: e.usedBy.join(", ") })));

  await wb.xlsx.writeFile(file);
  return { gaps: report.items.length, evidence: report.evidence.length };
}
