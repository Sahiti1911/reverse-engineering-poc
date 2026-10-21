// The JSON files of a run and how they fit together. Each one starts with the same `run` header and `files`
// index (paths relative to the run directory), so any one of them leads to the others:
//   coverage.json        the results, twin of the workbook: module context, UI evidence, and per story the
//                        scenarios, verdicts, gaps with drafts, linked and orphan cases
//   agents.json          how the agent chain went: per agent status, tokens, findings, forwarded notes, its review
//                        file and what a later stage applied from it (the review itself stays in review/)
//   summary.json         the numbers: counts and tokens
//   module-context.json  the module context alone; module-context.md is its readable brief
import path from "node:path";

export const OUTPUT_VERSION = 2;

const rel = (runDir, p) => {
  const r = path.relative(runDir, p);
  return (r.startsWith("..") || path.isAbsolute(r) ? p : r).split(path.sep).join("/");
};

/** The `run` header shared by every JSON file of a run. */
export function runHeader({ runDir, state, profile }) {
  const s = state.scope ?? {};
  return {
    name: path.basename(runDir), runAt: state.runAt, profile: profile.name,
    scope: { kind: s.kind ?? null, value: s.value ?? null, module: s.moduleFilter ?? null, keywords: s.keywords ?? [], jql: s.jql ?? null },
    zephyrExportedAt: state.zephyrExportedAt ?? null, codeCommits: state.codeCommits ?? [],
  };
}

/** Index of the run's output files; an entry is null when this run has no such output. */
export function runFiles({ runDir, workbookPath, agentRun = false, hasContext = false, hasUi = false, hasMap = false, hasSweep = false }) {
  return {
    workbook: rel(runDir, workbookPath),
    summary: "summary.md", summaryJson: "summary.json", coverage: "coverage.json",
    agents: agentRun ? "agents.json" : null,
    moduleContext: hasContext ? "module-context.json" : null, moduleContextBrief: hasContext ? "module-context.md" : null,
    ui: hasUi ? "ui/" : null, reviews: agentRun ? "review/" : null, handoffs: agentRun ? "handoff/" : null,
    featureMap: hasMap ? "map/" : null, uiSweep: hasSweep ? "ui-sweep/" : null, stories: "stories/", tokenLog: "token_log.jsonl",
  };
}

/** coverage.json from the run state's story records (ordered as in the workbook). */
export function coverageJson({ run, files, counts = null, moduleContext = null, featureMap = null, testDesign = null, ui = null, stories }) {
  return {
    version: OUTPUT_VERSION, run, files, counts,
    moduleContext,
    featureMap,
    testDesign,
    ui: ui && {
      inventory: ui.inventory, observations: ui.observations, scenarios: ui.scenarios,
      blockedRequests: ui.blockedRequests, consoleErrors: ui.consoleErrors, screenshots: ui.screenshots,
    },
    stories: stories.map((r) => ({
      key: r.story.key, summary: r.story.summary, module: r.story.module, testable: r.triage.testable, dropped: r.dropped ?? null,
      linkedCases: r.linkCheck?.linkedKeys ?? [],
      scenarios: (r.expected ?? []).map(({ id, source, flow, type, title, steps, expected, evidence, uiCheck, codeReview, suspectedBug, reasoning }) => ({ id, source, flow, type, title, steps, expected, evidence, uiCheck, codeReview, suspectedBug, reasoning })),
      verdicts: (r.matches ?? []).map(({ expectedId, verdict, confidence, matchedKeys, missingAspects, decidedBy, reasoning }) => ({ expectedId, verdict, confidence, matchedKeys, missingAspects, decidedBy, reasoning })),
      gaps: (r.gaps ?? []).map(({ gapId, expectedId, verdict, source, draft, validation, reviewDecision, createdKey, reasoning }) => ({ gapId, expectedId, verdict, source, draft, validation, reviewDecision, createdKey, reasoning })),
      orphans: (r.orphans ?? []).map(({ key, reasoning }) => ({ key, reasoning })),
    })),
  };
}

/** agents.json: one entry per configured agent, in pipeline order. Review contents stay in review/<name>.json. */
export function agentsJson({ run, files, agents }) {
  return {
    version: OUTPUT_VERSION, run, files,
    agents: agents.map(({ review, ...a }) => ({ ...a, reviewWritten: !!review })),
  };
}
