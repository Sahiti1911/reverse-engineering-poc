#!/usr/bin/env node
// Compact, token-friendly views of a run's state for the agents (and for people).
//   node scripts/inspect.mjs --run-dir <dir> --what stories|story|scenarios|code|ui|inventory|context|candidates|matches|design|gaps|validation|handoffs [--key AVLN-1] [--filter text]
import path from "node:path";
import { parseArgs } from "node:util";
import { readJson } from "./lib/util.mjs";

const { values: a } = parseArgs({ options: { "run-dir": { type: "string" }, what: { type: "string" }, key: { type: "string" }, filter: { type: "string" }, max: { type: "string" } } });
if (!a["run-dir"] || !a.what) {
  console.error("Usage: node scripts/inspect.mjs --run-dir <dir> --what stories|story|scenarios|code|ui|inventory|context|candidates|matches|design|gaps|validation|handoffs [--key KEY] [--filter text] [--max n]");
  process.exit(2);
}
const runDir = path.resolve(a["run-dir"]);
const state = readJson(path.join(runDir, "state.json"));
const max = Number(a.max ?? 400);
const cut = (s, n) => (s = String(s ?? "").replace(/\s+/g, " "), s.length > n ? s.slice(0, n - 1) + "…" : s);
const rows = state.stories.filter((r) => !a.key || r.story.key === a.key);
const out = [];
const keep = (line) => (!a.filter || line.toLowerCase().includes(a.filter.toLowerCase())) && out.push(line);

switch (a.what) {
  case "stories":
    out.push(`scope: ${state.scope?.jql}\nmodule: ${state.scope?.moduleFilter ?? "-"} keywords: ${(state.scope?.keywords ?? []).join(", ")}\nstages done: ${state.stagesDone.join(", ")}`);
    out.push("key | testable | ac | module (source) | linked | expected | summary");
    for (const r of rows) {
      const t = r.dropped ? "DROPPED" : r.triage.testable === null ? "?" : r.triage.testable ? "yes" : "no";
      keep(`${r.story.key} | ${t} | ${r.triage.acSource} | ${r.story.module} (${r.story.moduleSource}${r.story.keywordHit ? `:"${r.story.keywordHit}"` : ""}) | ${r.linkCheck?.linkedKeys.length ?? "-"} | ${r.expected.length} | ${cut(r.story.summary, 90)}`);
    }
    break;
  case "story":
    for (const r of rows) {
      out.push(`${r.story.key} — ${r.story.summary}\nstatus ${r.story.status} · epic ${r.story.epicKey ?? "-"} ${r.story.epicSummary ?? ""} · module ${r.story.module}`);
      out.push(`triage: ${r.triage.testable} by ${r.triage.decidedBy} — ${r.triage.reasoning}`);
      out.push(`links: ${(r.story.related ?? []).map((x) => `${x.key} (${x.type})`).join(", ") || "-"} · linked cases: ${r.linkCheck?.linkedKeys.join(", ") || "-"}`);
      const text = r.story.descriptionText ?? "";
      const lim = Number(a.max ?? 15000);
      out.push(`--- description (${text.length} chars${text.length > lim ? `; this VIEW shows the first ${lim} — the Jira text itself is complete, use --max to see more` : ""}) ---`);
      out.push(text.slice(0, lim));
      if (r.skippedUcs?.length) out.push(`--- UCs skipped by profile rule (not missing): ${r.skippedUcs.map((s) => `${s.uc} ${s.title}`).join("; ")}`);
    }
    break;
  case "scenarios":
  case "code":
  case "ui":
    out.push("id | source | flow | type | review | title");
    for (const r of rows) {
      for (const e of r.expected.filter((x) => (a.what === "code" ? x.codeOnly : a.what === "ui" ? x.source === "ui" || x.uiCheck : true))) {
        const ev = typeof e.evidence === "object" ? `${e.evidence.path} :: ${e.evidence.symbol}` : cut(e.evidence, 60);
        keep(`${e.id} | ${e.source} | ${e.flow} | ${e.type} | ${e.codeReview ?? ""}${e.suspectedBug ? " BUG?" : ""} | ${cut(e.title, 80)}${e.uiCheck ? `
    ui: ${cut(e.uiCheck, 160)}` : ""}${a.what !== "scenarios" ? `\n    evidence: ${ev}\n    expected: ${cut(e.expected, 160)}` : ""}`);
      }
      for (const e of r.droppedScenarios ?? []) keep(`${e.id} | DROPPED by ${e.droppedBy} | ${cut(e.title, 80)}`);
      if (a.what === "scenarios") for (const s of r.skippedUcs ?? []) keep(`${r.story.key}:${s.uc} | SKIPPED by profile rule (manual audit, not missing) | ${cut(s.title, 80)}`);
    }
    break;
  case "matches":
    out.push("expectedId | verdict | confidence | decidedBy | matched | missing / reasoning");
    for (const r of rows) {
      const title = new Map(r.expected.map((e) => [e.id, e.title]));
      for (const m of r.matches ?? []) keep(`${m.expectedId} | ${m.verdict} | ${m.confidence} | ${m.decidedBy} | ${m.matchedKeys.join(",") || "-"} | ${cut(title.get(m.expectedId), 60)} :: ${cut(m.missingAspects || m.reasoning, 160)}`);
      for (const o of r.orphans ?? []) keep(`ORPHAN ${o.key} (story ${r.story.key}) :: ${cut(o.reasoning, 160)}`);
    }
    break;
  case "design": {
    // The test suite designed from the module context (draft stage), with each case's coverage verdict.
    const cases = (state.testDesign?.cases ?? []).filter((c) => !a.key || c.storyKey === a.key);
    if (!state.testDesign) out.push("No test design in this run (no module context, or the draft stage has not run).");
    else out.push("tcId | story | verdict | covered by | gapId | basis | title");
    for (const c of cases) {
      keep(`${c.tcId} | ${c.storyKey} | ${c.check?.verdict ?? "-"}/${c.check?.confidence ?? "-"} | ${c.check?.matchedKeys?.join(",") || "-"} | ${c.gapId ?? "-"} | ${c.basis.join(",")} | ${cut(c.title, 80)}
    why: ${cut(c.whyNeeded, 200)}
    check: ${cut(c.check?.missingAspects || c.check?.reasoning, 200)}`);
    }
    if (state.testDesign?.notes) out.push(`notes: ${state.testDesign.notes}`);
    break;
  }
  case "candidates":
    for (const r of rows) for (const c of r.candidates ?? []) keep(`${r.story.key} | ${c.key} | linked=${c.linked} | steps=${c.steps?.length ?? "-"} | ${cut(c.name, 70)} | ${c.why}`);
    break;
  case "gaps":
    out.push("gapId | verdict | action | priority | folderId | suggested | name");
    for (const r of rows) {
      for (const g of r.gaps ?? []) {
        const d = g.draft ?? {};
        keep(`${g.gapId} | ${g.verdict} | ${d.action ?? "-"}${d.extendKey ? `:${d.extendKey}` : ""} | ${d.priority ?? "-"} | ${d.folderId ?? "-"} | ${d.suggestedDecision ?? "-"} | ${cut(d.name ?? g.scenario, 90)}${g.draftError ? ` | ERROR ${g.draftError}` : ""}`);
        if (a.key) keep(`    steps: ${(d.steps ?? []).map((s, i) => `${i + 1}. ${s.description} => ${s.expectedResult}`).join(" / ")}\n    labels: ${(d.labels ?? []).join(", ")} · folder: ${d.folderPath ?? "-"}\n    why: ${cut(d.decisionReasoning, 200)}`);
      }
    }
    break;
  case "validation":
    out.push("gapId | verdict | by | duplicate of | draft name | reasoning");
    for (const r of rows) {
      for (const g of r.gaps ?? []) keep(`${g.gapId} | ${g.validation?.verdict ?? "-"} | ${g.validation?.by ?? "-"} | ${g.validation?.duplicateOf?.join(",") || "-"} | ${cut(g.draft?.name ?? g.scenario, 70)} | ${cut(g.validation?.reasoning, 200)}`);
    }
    break;
  case "inventory": {
    // The UI explorer's inventory of what it saw (review/ui.json), for the context-builder.
    const ui = readJson(path.join(runDir, "review", "ui.json"), null);
    for (const i of ui?.inventory ?? []) {
      keep(`${i.id} | ${i.screen} | ${cut(i.functionality, 90)} | ${i.action} => ${cut(i.result, 120)} | ${i.confidence}${i.element ? ` | element: ${cut(i.element, 80)}` : ""}${i.uncertainty ? ` | uncertain: ${cut(i.uncertainty, 100)}` : ""}`);
    }
    if (!ui?.inventory?.length) out.push("No UI inventory in this run (the UI explorer wrote none, or did not run).");
    break;
  }
  case "context": {
    // The module context from the context-builder (saved as module-context.md by the draft stage), for test design.
    const { existsSync, readFileSync } = await import("node:fs");
    const md = path.join(runDir, "module-context.md");
    if (existsSync(md)) for (const line of readFileSync(md, "utf8").split(/\r?\n/)) keep(line);
    else out.push("No module context yet: the context-builder writes it in review/context.json and the draft stage saves it as module-context.md.");
    break;
  }
  case "handoffs": {
    const { readdirSync, existsSync } = await import("node:fs");
    const dir = path.join(runDir, "handoff");
    for (const f of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const h = readJson(path.join(dir, f));
      out.push(`## ${h.agent} (${h.status})\n${(h.findings ?? []).map((x) => `- ${x}`).join("\n")}\nforward: ${h.forwardNotes ?? ""}`);
    }
    break;
  }
  default:
    console.error(`Unknown --what ${a.what}`);
    process.exit(2);
}
// Exact totals up front, so agents never have to count lines.
const live = rows.filter((r) => r.triage?.testable && !r.dropped);
const totals = {
  stories: `TOTAL stories ${rows.length}: testable ${live.length}, not testable ${rows.filter((r) => r.triage?.testable === false && !r.dropped).length}, undecided ${rows.filter((r) => r.triage?.testable === null && !r.dropped).length}, dropped ${rows.filter((r) => r.dropped).length}`,
  scenarios: `TOTAL expected scenarios ${live.reduce((n, r) => n + r.expected.length, 0)} (story ${live.reduce((n, r) => n + r.expected.filter((e) => e.source === "story").length, 0)}, code ${live.reduce((n, r) => n + r.expected.filter((e) => e.codeOnly).length, 0)}, ui ${live.reduce((n, r) => n + r.expected.filter((e) => e.source === "ui").length, 0)}); dropped ${rows.reduce((n, r) => n + (r.droppedScenarios?.length ?? 0), 0)}`,
  ui: `TOTAL UI scenarios ${live.reduce((n, r) => n + r.expected.filter((e) => e.source === "ui").length, 0)}; observations ${live.reduce((n, r) => n + r.expected.filter((e) => e.uiCheck).length, 0)}`,
  validation: (() => {
    const g = live.flatMap((r) => r.gaps ?? []);
    const by = (v) => g.filter((x) => x.validation?.verdict === v).length;
    return `TOTAL gaps ${g.length}: ok ${by("ok")}, possible-duplicate ${by("possible-duplicate")}, duplicate ${by("duplicate")}, redesign ${by("redesign")}, undrafted ${by("undrafted")}`;
  })(),
  design: (() => {
    const c = state.testDesign?.cases ?? [];
    const by = (v) => c.filter((x) => x.check?.verdict === v).length;
    return `TOTAL designed cases ${c.length}: Covered ${by("Covered")}, Partial ${by("Partial")}, Missing ${by("Missing")}; gaps ${c.filter((x) => x.gapId).length}`;
  })(),
  code: `TOTAL code scenarios ${live.reduce((n, r) => n + r.expected.filter((e) => e.codeOnly).length, 0)}`,
  matches: (() => {
    const m = live.flatMap((r) => r.matches ?? []);
    return `TOTAL verdicts ${m.length}: Covered ${m.filter((x) => x.verdict === "Covered").length}, Partial ${m.filter((x) => x.verdict === "Partial").length}, Missing ${m.filter((x) => x.verdict === "Missing").length}`;
  })(),
  gaps: (() => {
    const g = live.flatMap((r) => r.gaps ?? []);
    const by = (d) => g.filter((x) => (x.draft?.suggestedDecision ?? "-") === d).length;
    return `TOTAL gaps ${g.length}: drafted ${g.filter((x) => x.draft).length}; suggested Approve ${by("Approve")}, Review ${by("Review")}, Reject ${by("Reject")}`;
  })(),
}[a.what];
if (totals) out.unshift(totals);
const lineMax = a.what === "story" || a.what === "context" ? Infinity : max;
console.log(out.slice(0, lineMax).join("\n") + (out.length > lineMax ? `\n… ${out.length - lineMax} more lines (use --filter or --key)` : ""));
