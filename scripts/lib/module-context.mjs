// The module context: everything known about one module or feature (stories, code, UI, Zephyr), written by
// the context-builder (review/context.json → moduleContext). Test design works from it. Saved next to the run
// as module-context.json / module-context.md, included in coverage.json and shown in the 1_Module_Context sheet.
import fs from "node:fs";
import path from "node:path";
import { writeJson } from "./util.mjs";

const src = (s) => (s?.length ? ` _(${s.join(", ")})_` : "");

/** module-context.md: a readable brief of the feature. */
export function renderModuleContext(mc, { title = "Module context" } = {}) {
  if (!mc) return "";
  const L = [`# ${title}`, "", mc.overview ?? "", ""];
  const section = (name, list, line) => {
    if (!list?.length) return;
    L.push(`## ${name}`);
    for (const x of list) L.push(...[line(x)].flat());
    L.push("");
  };
  section("Screens", mc.screens, (s) => [
    `- **${s.name}**${s.route ? ` \`${s.route}\`` : ""}${s.reachedFrom ? ` — reached from ${s.reachedFrom}` : ""}${src(s.sources)}`,
    ...(s.elements ?? []).map((e) => `  - ${e}`),
  ]);
  section("Workflows", mc.workflows, (w) => [
    `- **${w.name}**${src(w.sources)}`, ...w.steps.map((s, i) => `  ${i + 1}. ${s}`), `  - Outcome: ${w.outcome}`,
  ]);
  section("Rules", mc.rules, (r) => `- **${r.id}** [${r.kind}, ${r.status}] ${r.rule} → ${r.expected}${src(r.sources)}`);
  section("APIs", mc.apis, (a) => `- \`${a.method} ${a.path}\` — ${a.purpose}${a.permission ? ` (permission ${a.permission})` : ""}${src(a.sources)}`);
  section("Exact UI texts", mc.uiTexts, (t) => `- "${t.text}" — ${t.where}${src(t.sources)}`);
  section("Test data and preconditions", mc.testData, (t) => `- ${t.need}: ${t.how}`);
  if (mc.existingCoverage) {
    const c = mc.existingCoverage;
    L.push("## Existing coverage");
    if (c.folders?.length) L.push(`- Folders: ${c.folders.join("; ")}`);
    if (c.namingPattern) L.push(`- Naming: ${c.namingPattern}`);
    if (c.summary) L.push(`- ${c.summary}`);
    L.push("");
  }
  section("Open questions", mc.openQuestions, (q) => `- ${q.question}${q.affects?.length ? ` (affects ${q.affects.join(", ")})` : ""}${src(q.sources)}`);
  section("Known issues", mc.knownIssues, (k) => `- ${k.issue}${src(k.sources)}`);
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

/** One row per item for the 1_Module_Context sheet. */
export function moduleContextRows(mc) {
  if (!mc) return [];
  const rows = [{ section: "Overview", item: "", detail: mc.overview ?? "", status: "", sources: "" }];
  const s = (x) => (x ?? []).join(", ");
  for (const x of mc.screens ?? []) rows.push({ section: "Screen", item: x.name, detail: [x.route, x.reachedFrom && `reached from ${x.reachedFrom}`, ...(x.elements ?? [])].filter(Boolean).join("\n"), status: "", sources: s(x.sources) });
  for (const x of mc.workflows ?? []) rows.push({ section: "Workflow", item: x.name, detail: `${x.steps.map((t, i) => `${i + 1}. ${t}`).join("\n")}\n=> ${x.outcome}`, status: "", sources: s(x.sources) });
  for (const x of mc.rules ?? []) rows.push({ section: `Rule (${x.kind})`, id: x.id, item: x.rule, detail: x.expected, status: x.status, sources: s(x.sources) });
  for (const x of mc.apis ?? []) rows.push({ section: "API", item: `${x.method} ${x.path}`, detail: x.purpose, status: x.permission ?? "", sources: s(x.sources) });
  for (const x of mc.uiTexts ?? []) rows.push({ section: "UI text", item: x.text, detail: x.where, status: "", sources: s(x.sources) });
  for (const x of mc.testData ?? []) rows.push({ section: "Test data", item: x.need, detail: x.how, status: "", sources: "" });
  if (mc.existingCoverage) {
    const c = mc.existingCoverage;
    rows.push({ section: "Existing coverage", item: s(c.folders), detail: [c.namingPattern && `Naming: ${c.namingPattern}`, c.summary].filter(Boolean).join("\n"), status: "", sources: "" });
  }
  for (const x of mc.openQuestions ?? []) rows.push({ section: "Open question", item: x.question, detail: s(x.affects), status: "needs-confirmation", sources: s(x.sources) });
  for (const x of mc.knownIssues ?? []) rows.push({ section: "Known issue", item: x.issue, detail: "", status: "suspected-bug", sources: s(x.sources) });
  return rows;
}

/** Writes module-context.json and .md into the run directory; returns the file paths (or null without a context). */
export function writeModuleContext(runDir, mc, { title } = {}) {
  if (!mc) return null;
  const json = path.join(runDir, "module-context.json");
  const md = path.join(runDir, "module-context.md");
  writeJson(json, mc);
  fs.writeFileSync(md, renderModuleContext(mc, { title }));
  return { json, md };
}
