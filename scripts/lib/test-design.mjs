// Context-first test design. After the context-builder, the draft stage designs the test suite the module
// SHOULD have from the module context (design), checks every designed case against the existing Zephyr cases
// (check), and drafts only the designed cases that no existing case covers. Pure helpers; the Claude calls are
// in stages.mjs.
import { truncate } from "./util.mjs";

/** A verdict needs a draft unless it is Covered and either auto-accepted or not Low confidence (same rule as scenario gaps). */
export function needsDraft(verdict, confidence, autoAccept = ["High"]) {
  if (verdict !== "Covered") return true;
  return !autoAccept.includes(confidence) && confidence === "Low";
}

/** Input of the design call: the whole module context, the stories and every scenario with its verdict. */
export function designInput({ moduleContext, rows, maxContextChars = 40000 }) {
  return {
    moduleContext: truncate(JSON.stringify({ ...moduleContext, by: undefined }), maxContextChars),
    stories: rows.map((r) => ({ key: r.story.key, summary: r.story.summary })),
    scenarios: rows.flatMap((r) => {
      const verdict = new Map((r.matches ?? []).map((m) => [m.expectedId, m]));
      return r.expected.map((e) => {
        const m = verdict.get(e.id);
        return { id: e.id, story: r.story.key, title: e.title, source: e.source, verdict: m?.verdict ?? "Missing", matchedKeys: m?.matchedKeys ?? [] };
      });
    }),
  };
}

/**
 * Cleans the designed suite: unique tcIds, known scenario ids only, and a storyKey of a story in scope (the
 * designer's choice, else the story of its first scenario, else the fallback story). Returns the cases and notes
 * on what was fixed.
 */
export function normalizeSuite(cases, rows, fallbackStoryKey) {
  const keys = new Set(rows.map((r) => r.story.key));
  const storyOf = new Map(rows.flatMap((r) => r.expected.map((e) => [e.id, r.story.key])));
  const seen = new Set();
  const notes = [];
  const out = [];
  for (const [i, c] of cases.entries()) {
    let tcId = (c.tcId || `TC-${String(i + 1).padStart(2, "0")}`).replace(/[^\w-]/g, "-");
    if (seen.has(tcId)) {
      let n = 2;
      while (seen.has(`${tcId}-${n}`)) n++;
      notes.push(`${tcId} used twice; the second is ${tcId}-${n}.`);
      tcId = `${tcId}-${n}`;
    }
    seen.add(tcId);
    const scenarioIds = (c.scenarioIds ?? []).filter((id) => storyOf.has(id));
    let storyKey = c.storyKey;
    if (!keys.has(storyKey)) {
      const derived = storyOf.get(scenarioIds[0]) ?? fallbackStoryKey;
      if (storyKey) notes.push(`${tcId}: story ${storyKey} is not in scope; attached to ${derived}.`);
      storyKey = derived;
    }
    const basis = c.basis ?? [];
    const whyNeeded = c.whyNeeded?.trim() || `Designed from ${[...basis, ...scenarioIds].join(", ") || "the module context"} (the design gave no reason).`;
    out.push({ ...c, tcId, storyKey, scenarioIds, basis, whyNeeded });
  }
  return { cases: out, notes };
}

/**
 * Existing cases a designed case is checked against: the candidates of its own story, plus every case that
 * matched (fully or partly) a scenario it traces to, wherever that case was found.
 */
export function checkCandidates(row, cases, rows) {
  const byKey = new Map(rows.flatMap((r) => (r.candidates ?? []).map((c) => [c.key, c])));
  const matched = new Map(rows.flatMap((r) => (r.matches ?? []).map((m) => [m.expectedId, m.matchedKeys])));
  const out = new Map((row.candidates ?? []).map((c) => [c.key, c]));
  for (const tc of cases) {
    for (const id of tc.scenarioIds) for (const k of matched.get(id) ?? []) if (!out.has(k) && byKey.has(k)) out.set(k, byKey.get(k));
  }
  return [...out.values()];
}

/**
 * The verdict a designed case inherits from its scenarios, so the check does not judge the same cases twice:
 * Covered when every traced scenario is Covered and auto-accepted (matched, then verified by the context-builder);
 * Missing when every traced scenario of its own story is Missing with no partial match (judged against the same
 * candidate cases). Anything else (mixed, Partial, low confidence, no scenarios) returns null and goes to the check.
 */
export function inheritedCheck(tc, matchById, storyOf) {
  const ms = tc.scenarioIds.map((id) => matchById.get(id));
  if (!ms.length || ms.some((m) => !m)) return null;
  const ids = tc.scenarioIds.join(", ");
  if (ms.every((m) => m.verdict === "Covered" && m.autoAccepted)) {
    const keys = [...new Set(ms.flatMap((m) => m.matchedKeys))];
    return { verdict: "Covered", matchedKeys: keys, confidence: "High", missingAspects: "", decidedBy: "scenario verdict", reasoning: `Its scenario(s) ${ids} are already Covered by ${keys.join(", ")} (High confidence); not judged again.` };
  }
  if (ms.every((m) => m.verdict === "Missing" && !m.matchedKeys.length) && tc.scenarioIds.every((id) => storyOf.get(id) === tc.storyKey)) {
    const confidence = ms.some((m) => m.confidence === "Low") ? "Low" : ms.some((m) => m.confidence === "Medium") ? "Medium" : "High";
    return { verdict: "Missing", matchedKeys: [], confidence, missingAspects: "", decidedBy: "scenario verdict", reasoning: `Its scenario(s) ${ids} were judged Missing against the same existing cases (${truncate(ms[0].reasoning, 200)}); not judged again.` };
  }
  return null;
}

/** Scenario gaps (not safely covered) that no designed case traces to. They keep a scenario-based draft so nothing is lost. */
export function untracedScenarioGaps(rows, cases, autoAccept = ["High"]) {
  const traced = new Set(cases.flatMap((c) => c.scenarioIds));
  return rows.flatMap((r) => (r.matches ?? [])
    .filter((m) => !traced.has(m.expectedId) && r.expected.some((e) => e.id === m.expectedId) && needsDraft(m.verdict, m.confidence, autoAccept))
    .map((m) => ({ row: r, match: m })));
}

/** The gap for a designed case that existing cases do not (safely) cover: why it should exist, and why nothing covers it. */
export function designGap(tc, check, rules = []) {
  const status = new Map(rules.map((r) => [r.id, r.status]));
  const statuses = tc.basis.map((b) => status.get(b)).filter(Boolean);
  const verdict = check.verdict === "Covered" ? "Unverified" : check.verdict;
  const basis = [...tc.basis, ...tc.scenarioIds].join(", ");
  const found = check.verdict === "Covered"
    ? `Possibly covered by ${check.matchedKeys.join(", ")} but only with Low confidence. ${check.reasoning}`
    : `${check.verdict === "Partial" ? `Only partly covered by ${check.matchedKeys.join(", ")}` : "No existing case covers it"}: ${check.reasoning}`;
  return {
    gapId: `GAP-${tc.storyKey}-${tc.tcId}`, expectedId: tc.tcId, scenario: tc.title, source: "context", type: tc.type, verdict,
    matchedKeys: check.matchedKeys, missingAspects: check.missingAspects ?? "", basis: tc.basis, scenarioIds: tc.scenarioIds,
    codeReview: statuses.includes("needs-confirmation") ? "needs PO confirmation" : "",
    suspectedBug: statuses.includes("suspected-bug"),
    reasoning: `Should be covered: ${tc.whyNeeded}${basis ? ` (from ${basis})` : ""}. ${found}${check.missingAspects ? ` Missing: ${check.missingAspects}` : ""}`,
  };
}
