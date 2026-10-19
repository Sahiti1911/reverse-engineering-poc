// Agent review files → state. Each agent writes runs/<run>/review/<key>.json (schema/review/<key>.schema.json);
// the next stage merges it here. Every change records which agent made it and why, and re-applying the same
// review is harmless (stages can be re-run).
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { ROOT } from "./config.mjs";
import { readJson } from "./util.mjs";

export const REVIEW_AGENTS = {
  scout: "module-scout",
  requirements: "requirements-analyst",
  code: "code-analyst",
  match: "coverage-matcher",
  drafts: "test-designer",
};

const ajv = new Ajv({ allErrors: true, strict: false });
const validators = {};

export function loadReview(ctx, key) {
  const file = ctx.reviewFile(key);
  if (!fs.existsSync(file)) return null;
  const review = readJson(file);
  validators[key] ??= ajv.compile(readJson(path.join(ROOT, "schema", "review", `${key}.schema.json`)));
  if (!validators[key](review)) {
    const details = validators[key].errors.map((e) => `${e.instancePath || "(root)"} ${e.message}`).join("; ");
    throw new Error(`review/${key}.json does not match schema/review/${key}.schema.json: ${details}`);
  }
  return review;
}

const by = (key) => `agent:${REVIEW_AGENTS[key]}`;

export function appendReason(old, agentKey, reason) {
  const note = `Agent ${REVIEW_AGENTS[agentKey]}: ${reason}`;
  return String(old ?? "").includes(note) ? old : [old, note].filter(Boolean).join(" | ");
}

function finish(ctx, key, applied, missing) {
  ctx.step("apply-review", {
    batch: REVIEW_AGENTS[key], out: applied,
    notes: `Applied ${applied} change(s) from review/${key}.json.`,
    skipped: missing.length ? `Not found (already applied or wrong id): ${missing.slice(0, 10).join(", ")}` : "",
  });
}

/** module-scout: drop unrelated stories. */
export function applyScoutReview(ctx) {
  const review = loadReview(ctx, "scout");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  for (const d of review.dropStories ?? []) {
    const r = ctx.R(d.key);
    if (!r) { missing.push(d.key); continue; }
    r.dropped = { by: by("scout"), reasoning: d.reasoning };
    applied++;
  }
  finish(ctx, "scout", applied, missing);
  return applied;
}

/** requirements-analyst: triage overrides, scenario drop/add/edit, AC quality flags. */
export function applyRequirementsReview(ctx) {
  const review = loadReview(ctx, "requirements");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  for (const o of review.triageOverrides ?? []) {
    const r = ctx.R(o.key);
    if (!r) { missing.push(o.key); continue; }
    r.triage = { ...r.triage, testable: o.testable, decidedBy: by("requirements"), reasoning: appendReason(r.triage.reasoning, "requirements", o.reasoning) };
    applied++;
  }
  for (const d of review.dropScenarios ?? []) {
    const r = ctx.stories.find((x) => x.expected.some((e) => e.id === d.id));
    if (!r) { missing.push(d.id); continue; }
    const e = r.expected.find((x) => x.id === d.id);
    r.expected = r.expected.filter((x) => x.id !== d.id);
    (r.droppedScenarios ??= []).push({ ...e, droppedBy: by("requirements"), reasoning: appendReason(e.reasoning, "requirements", `dropped — ${d.reasoning}`) });
    applied++;
  }
  for (const a of review.addScenarios ?? []) {
    const r = ctx.R(a.storyKey);
    if (!r) { missing.push(a.storyKey); continue; }
    if (r.expected.some((e) => e.title === a.title)) continue;
    const n = r.expected.filter((e) => e.id.startsWith(`${a.storyKey}:A`)).length + 1;
    r.expected.push({
      id: `${a.storyKey}:A${String(n).padStart(2, "0")}`, storyKey: a.storyKey, source: "story", uc: "", flow: a.flow, title: a.title, type: a.type,
      steps: a.steps, expected: a.expected, evidence: a.evidence, priorityHint: a.flow === "main" ? "High" : "Medium", codeOnly: false,
      addedBy: by("requirements"), reasoning: `Added by agent ${REVIEW_AGENTS.requirements}: ${a.reasoning}`,
    });
    applied++;
  }
  for (const ed of review.editScenarios ?? []) {
    const r = ctx.stories.find((x) => x.expected.some((e) => e.id === ed.id));
    if (!r) { missing.push(ed.id); continue; }
    const e = r.expected.find((x) => x.id === ed.id);
    for (const f of ["title", "type", "steps", "expected"]) if (ed[f] !== undefined) e[f] = ed[f];
    e.reasoning = appendReason(e.reasoning, "requirements", `edited — ${ed.reasoning}`);
    applied++;
  }
  for (const f of review.flags ?? []) {
    const r = ctx.R(f.key);
    if (!r) { missing.push(f.key); continue; }
    r.flags ??= [];
    if (!r.flags.some((x) => x.issue === f.issue)) r.flags.push({ by: by("requirements"), issue: f.issue });
    applied++;
  }
  finish(ctx, "requirements", applied, missing);
  return applied;
}

/** code-analyst: keep / drop / needs-confirmation per code-derived scenario, suspected bugs. */
export function applyCodeReview(ctx) {
  const review = loadReview(ctx, "code");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  for (const d of review.decisions ?? []) {
    const r = ctx.stories.find((x) => x.expected.some((e) => e.id === d.id));
    if (!r) { missing.push(d.id); continue; }
    const e = r.expected.find((x) => x.id === d.id);
    if (d.decision === "drop") {
      r.expected = r.expected.filter((x) => x.id !== d.id);
      (r.droppedScenarios ??= []).push({ ...e, droppedBy: by("code"), reasoning: appendReason(e.reasoning, "code", `dropped — ${d.reasoning}`) });
    } else {
      e.codeReview = d.decision === "keep" ? "kept by code-analyst" : "needs PO confirmation";
      e.suspectedBug = !!d.suspectedBug;
      e.reasoning = appendReason(e.reasoning, "code", `${d.decision}${d.suspectedBug ? " (suspected bug)" : ""} — ${d.reasoning}`);
    }
    applied++;
  }
  finish(ctx, "code", applied, missing);
  return applied;
}

/** coverage-matcher: verdict overrides after spot-checking existing cases. */
export function applyMatchReview(ctx) {
  const review = loadReview(ctx, "match");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  const autoAccept = ctx.cfg.matching.autoAcceptConfidence ?? ["High"];
  for (const o of review.overrides ?? []) {
    const r = ctx.stories.find((x) => x.matches?.some((m) => m.expectedId === o.expectedId));
    if (!r) { missing.push(o.expectedId); continue; }
    const m = r.matches.find((x) => x.expectedId === o.expectedId);
    if (m.decidedBy === by("match") && m.verdict === o.verdict) continue;
    const before = `pipeline said ${m.verdict}/${m.confidence}`;
    m.verdict = o.verdict;
    if (o.matchedKeys) m.matchedKeys = o.matchedKeys;
    m.confidence = o.confidence ?? "High";
    m.autoAccepted = m.verdict === "Covered" && autoAccept.includes(m.confidence);
    m.decidedBy = by("match");
    m.reasoning = appendReason(m.reasoning, "match", `${o.reasoning} (${before})`);
    applied++;
  }
  finish(ctx, "match", applied, missing);
  return applied;
}

/** test-designer: edits to drafts and decision suggestions. */
export function applyDraftsReview(ctx, folderPathById = new Map()) {
  const review = loadReview(ctx, "drafts");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  for (const ed of review.edits ?? []) {
    const r = ctx.stories.find((x) => x.gaps?.some((g) => g.gapId === ed.gapId));
    if (!r) { missing.push(ed.gapId); continue; }
    const g = r.gaps.find((x) => x.gapId === ed.gapId);
    g.draft ??= { action: "create", steps: [], labels: [] };
    for (const f of ["action", "extendKey", "name", "objective", "precondition", "priority", "labels", "folderId", "steps", "bdd", "suggestedDecision"]) {
      if (ed[f] !== undefined) g.draft[f] = ed[f];
    }
    if (ed.folderId !== undefined) g.draft.folderPath = folderPathById.get(ed.folderId) ?? "(folder id not found in Zephyr — choose one)";
    g.draft.decisionReasoning = appendReason(g.draft.decisionReasoning ?? g.draftError, "drafts", ed.reasoning);
    g.draftEditedBy = by("drafts");
    delete g.draftError;
    applied++;
  }
  finish(ctx, "drafts", applied, missing);
  return applied;
}
