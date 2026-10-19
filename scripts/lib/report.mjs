// summary.md: the short, human-readable result of a run (tokens only, no money), next to the workbook,
// and copied to runs/<profile>/latest-summary.md.
import fs from "node:fs";
import path from "node:path";
import { summarizeTokens } from "./tokens.mjs";
import { writeJson } from "./util.mjs";

const n = (x) => Number(x ?? 0).toLocaleString("en-US");

export function renderSummary({ ctx, built, workbookPath, handoffs = [] }) {
  const { state, profile } = ctx;
  const scope = state.scope;
  const tok = summarizeTokens(ctx.tokenLog.records);
  const all = ctx.stories;
  const testable = ctx.testable();
  const matches = testable.flatMap((r) => r.matches ?? []);
  const count = (v) => matches.filter((m) => m.verdict === v).length;
  const cov = matches.length ? Math.round((100 * (count("Covered") + 0.5 * count("Partial"))) / matches.length) : null;
  const gaps = testable.flatMap((r) => (r.gaps ?? []).map((g) => ({ ...g, story: r.story.key })));
  const decision = (g) => g.reviewDecision ?? g.draft?.suggestedDecision ?? "Review";
  const bugs = testable.flatMap((r) => r.expected.filter((e) => e.suspectedBug).map((e) => ({ ...e, story: r.story.key })));
  const flags = all.flatMap((r) => (r.flags ?? []).map((f) => `${r.story.key}: ${f.issue}`));
  const orphans = testable.flatMap((r) => (r.orphans ?? []).map((o) => `${o.key} (linked to ${r.story.key}): ${o.reasoning}`));
  const L = [];

  L.push(`# Coverage summary — ${scope.moduleFilter ? `module \`${scope.moduleFilter}\`` : `${scope.kind}${scope.value ? ` ${scope.value}` : ""}`}`);
  L.push("");
  L.push(`- Profile: **${profile.name}** (Jira ${profile.jira.projectKey}, Zephyr ${profile.zephyr.projectKey} under "${profile.zephyr.folderRoot}")`);
  if (scope.moduleFilter) L.push(`- Keywords: ${scope.keywords.map((k) => `\`${k}\``).join(", ")}`);
  L.push(`- Run: ${state.runAt} · code ${state.codeCommits.join(", ") || "not analysed"} · Zephyr export ${state.zephyrExportedAt ?? "?"}`);
  L.push(`- Workbook: \`${workbookPath}\``);
  L.push("");

  const blocked = handoffs.find((h) => h.status !== "ok");
  if (blocked) {
    L.push(`> **The agent chain stopped at \`${blocked.agent}\` (${blocked.status}).** ${blocked.question ?? blocked.forwardNotes ?? ""}`);
    L.push("");
  }
  const reporter = handoffs.find((h) => h.agent === "reporter" && h.status === "ok");
  if (reporter?.findings?.length) {
    L.push("## Executive summary");
    for (const f of reporter.findings) L.push(`- ${f}`);
    L.push("");
  }

  L.push("## Results");
  L.push(`| Stories in scope | Testable | Not testable | Undecided | Dropped by agent | Expected scenarios | Covered | Partial | Missing | Coverage | Gaps |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  L.push(`| ${all.length} | ${testable.length} | ${all.filter((r) => r.triage?.testable === false && !r.dropped).length} | ${all.filter((r) => r.triage?.testable === null && !r.dropped).length} | ${all.filter((r) => r.dropped).length} | ${built?.counts.expected ?? testable.reduce((s, r) => s + r.expected.length, 0)} | ${count("Covered")} | ${count("Partial")} | ${count("Missing")} | ${cov === null ? "—" : `${cov}%`} | ${gaps.length} |`);
  L.push("");
  if (gaps.length) {
    L.push("### Gaps by suggested decision");
    for (const d of ["Approve", "Review", "Reject"]) {
      const list = gaps.filter((g) => decision(g) === d);
      if (!list.length) continue;
      L.push(`**${d} (${list.length})**`);
      for (const g of list.slice(0, 25)) L.push(`- \`${g.gapId}\` ${g.verdict}: ${g.draft?.name ?? g.scenario}${g.codeReview ? ` _(${g.codeReview})_` : ""}`);
      if (list.length > 25) L.push(`- … ${list.length - 25} more in the workbook (6_Gaps)`);
      L.push("");
    }
  }
  if (bugs.length) {
    L.push("### Suspected bugs (from code review)");
    for (const b of bugs) L.push(`- ${b.story}: ${b.title} — ${b.reasoning.split(" | ").pop()}`);
    L.push("");
  }
  if (flags.length) {
    L.push("### Requirement quality flags");
    for (const f of flags) L.push(`- ${f}`);
    L.push("");
  }
  if (orphans.length) {
    L.push("### Linked cases that match no requirement");
    for (const o of orphans.slice(0, 15)) L.push(`- ${o}`);
    L.push("");
  }

  if (handoffs.length) {
    L.push("## Agent chain");
    for (const h of handoffs) {
      L.push(`### ${h.order ?? ""} ${h.agent} — ${h.status}${h.tokens ? ` · ${n(h.tokens)} tokens` : ""}`);
      for (const f of h.findings ?? []) L.push(`- ${f}`);
      if (h.forwardNotes) L.push(`- _Forwarded:_ ${h.forwardNotes}`);
      L.push("");
    }
  }

  L.push("## Tokens used");
  L.push("| Stage / agent | Calls | From cache | Input | Output | Cache read | Cache write | Total |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const [stage, t] of Object.entries(tok.byStage)) {
    L.push(`| ${stage} | ${t.calls} | ${t.reused} | ${n(t.input_tokens)} | ${n(t.output_tokens)} | ${n(t.cache_read_tokens)} | ${n(t.cache_creation_tokens)} | ${n(t.total_tokens)} |`);
  }
  for (const [label, t] of [["**Pipeline**", tok.pipeline], ["**Agents**", tok.agents], ["**Total**", tok.total]]) {
    L.push(`| ${label} | ${t.calls} | ${t.reused} | ${n(t.input_tokens)} | ${n(t.output_tokens)} | ${n(t.cache_read_tokens)} | ${n(t.cache_creation_tokens)} | **${n(t.total_tokens)}** |`);
  }
  if (testable.length) L.push(`\nTokens per testable story: ${n(Math.round(tok.total.total_tokens / testable.length))} (pipeline ${n(Math.round(tok.pipeline.total_tokens / testable.length))}).`);
  L.push("");
  L.push("## Next");
  L.push("1. Open the workbook, sheet `6_Gaps`: set **Review decision** per row (pre-filled with the suggestion).");
  L.push(`2. Dry run: \`node scripts/run.mjs --create-approved "${workbookPath}"\` — then add \`--yes\` to create. Zephyr has no delete.`);
  return { text: L.join("\n") + "\n", tok };
}

export function writeSummary({ ctx, built, workbookPath, handoffs }) {
  const { text, tok } = renderSummary({ ctx, built, workbookPath, handoffs });
  const file = path.join(ctx.runDir, "summary.md");
  fs.writeFileSync(file, text);
  fs.writeFileSync(path.join(path.dirname(ctx.runDir), "latest-summary.md"), text);
  writeJson(path.join(ctx.runDir, "summary.json"), {
    runAt: ctx.state.runAt, profile: ctx.profile.name, scope: ctx.state.scope, counts: built?.counts ?? null,
    tokens: { total: tok.total, pipeline: tok.pipeline, agents: tok.agents, byStage: tok.byStage }, workbook: workbookPath,
  });
  return { file, text };
}
