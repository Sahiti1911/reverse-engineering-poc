// Agent review files → state. Each agent writes runs/<run>/review/<key>.json (schema/review/<key>.schema.json);
// a later stage merges it here (the explorers' reviews all merge in the context stage). Every change records which agent made it and why, and re-applying the same
// review is harmless (stages can be re-run).
import fs from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import { ROOT } from "./config.mjs";
import { readJson } from "./util.mjs";

export const REVIEW_AGENTS = {
  scout: "module-scout",
  map: "feature-mapper",
  requirements: "requirements-analyst",
  code: "code-analyst",
  ui: "ui-explorer",
  zephyr: "zephyr-explorer",
  context: "context-builder",
  drafts: "test-designer",
  validation: "coverage-validator",
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

/** feature-mapper: correct the feature map (labels, aliases, case and story assignment, added or dropped surfaces, shared behaviour). */
export function applyMapReview(ctx) {
  const review = loadReview(ctx, "map");
  const map = ctx.state.featureMap;
  if (!review || !map) return 0;
  let applied = 0;
  const missing = [];
  const find = (name) => map.surfaces.find((s) => s.name === name);
  const unassign = (key) => {
    map.shared.cases = map.shared.cases.filter((k) => k !== key);
    for (const s of map.surfaces) s.cases = s.cases.filter((k) => k !== key);
  };
  const dropSurface = (name, reasoning) => {
    const s = find(name);
    if (!s) return false;
    map.surfaces = map.surfaces.filter((x) => x !== s);
    map.shared.cases.push(...s.cases.filter((k) => !map.shared.cases.includes(k)));
    if (!map.notThis.surfaces.some((x) => x.name === name)) map.notThis.surfaces.push({ name, by: by("map"), reasoning });
    return true;
  };
  for (const ch of review.surfaces ?? []) {
    if (ch.drop) { if (dropSurface(ch.name, ch.reasoning)) applied++; else missing.push(ch.name); continue; }
    const s = find(ch.name);
    if (!s) { missing.push(ch.name); continue; }
    if (ch.label) s.label = ch.label;
    s.aliases = [...new Set([...(s.aliases ?? []), ...(ch.aliases ?? [])])];
    for (const k of ch.removeCases ?? []) { s.cases = s.cases.filter((x) => x !== k); if (!map.shared.cases.includes(k)) map.shared.cases.push(k); }
    for (const k of ch.addCases ?? []) { unassign(k); s.cases.push(k); }
    s.stories = [...new Set([...s.stories, ...(ch.addStories ?? [])])];
    if (ch.note) s.note = ch.note;
    s.reviewedBy = by("map");
    s.reasoning = appendReason(s.reasoning, "map", ch.reasoning);
    applied++;
  }
  for (const a of review.addSurfaces ?? []) {
    if (!find(a.name)) {
      map.surfaces.push({
        name: a.name, id: null, label: a.label, code: { backend: [], legacy: [], frontend: [] }, ui: [], confluence: [], stories: [], cases: [],
        evidence: a.evidence, addedBy: by("map"), reasoning: `Added by agent ${REVIEW_AGENTS.map}: ${a.reasoning} Evidence: ${a.evidence.join(", ")}.`,
      });
    }
    applied++;
  }
  for (const n of review.notThis ?? []) {
    if (n.kind === "surface") { if (dropSurface(n.id, n.reasoning)) applied++; else missing.push(n.id); continue; }
    const bucket = n.kind === "case" ? "cases" : "confluence";
    const key = n.kind === "case" ? "key" : "id";
    for (const s of map.surfaces) s[bucket] = s[bucket].filter((x) => x !== n.id);
    map.shared[bucket] = map.shared[bucket].filter((x) => x !== n.id);
    if (!map.notThis[bucket].some((x) => x[key] === n.id)) map.notThis[bucket].push({ [key]: n.id, by: by("map"), reasoning: n.reasoning });
    applied++;
  }
  if (review.sharedBehaviours) {
    map.sharedBehaviours = review.sharedBehaviours.map((b, i) => ({ id: `SB-${String(i + 1).padStart(2, "0")}`, ...b, by: by("map") }));
    applied += review.sharedBehaviours.length;
  }
  for (const s of map.surfaces) {
    s.missing = [...(s.missing ?? []).filter((m) => m !== "zephyr"), ...(!s.cases.length ? ["zephyr"] : [])];
    s.status = s.addedBy ? "added by agent" : s.missing.length ? `missing: ${s.missing.join(", ")}` : "complete";
  }
  finish(ctx, "map", applied, missing);
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

/** context-builder: the module context (what test design works from) and verdict overrides after spot-checking cases. */
export function applyContextReview(ctx) {
  const review = loadReview(ctx, "context");
  if (!review) return 0;
  let applied = 0;
  if (review.moduleContext) {
    ctx.state.moduleContext = { ...review.moduleContext, by: REVIEW_AGENTS.context };
    applied++;
  }
  const missing = [];
  const autoAccept = ctx.cfg.matching.autoAcceptConfidence ?? ["High"];
  for (const o of review.overrides ?? []) {
    const r = ctx.stories.find((x) => x.matches?.some((m) => m.expectedId === o.expectedId));
    if (!r) { missing.push(o.expectedId); continue; }
    const m = r.matches.find((x) => x.expectedId === o.expectedId);
    if (m.decidedBy === by("context") && m.verdict === o.verdict) continue;
    const before = `pipeline said ${m.verdict}/${m.confidence}`;
    m.verdict = o.verdict;
    if (o.matchedKeys) m.matchedKeys = o.matchedKeys;
    m.confidence = o.confidence ?? "High";
    m.autoAccepted = m.verdict === "Covered" && autoAccept.includes(m.confidence);
    m.decidedBy = by("context");
    m.reasoning = appendReason(m.reasoning, "context", `${o.reasoning} (${before})`);
    applied++;
  }
  finish(ctx, "context", applied, missing);
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

/** The story a module-level scenario (code or UI) is attached to: the one owning the module's QA doc, else the newest. */
export function primaryStory(rows) {
  return [...rows].sort((a, b) => (b.triage.acSource === "uc-doc") - (a.triage.acSource === "uc-doc") || String(b.story.updated).localeCompare(String(a.story.updated)))[0] ?? null;
}

/** ui-explorer: scenarios seen in the running app, and whether existing scenarios show up there. */
export function applyUiReview(ctx) {
  const review = loadReview(ctx, "ui");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  const primary = primaryStory(ctx.testable());
  for (const a of review.scenarios ?? []) {
    const r = a.storyKey ? ctx.R(a.storyKey) : primary;
    if (!r) { missing.push(a.storyKey ?? "(no testable story)"); continue; }
    if (r.expected.some((e) => e.title.toLowerCase() === a.title.toLowerCase())) continue;
    const key = r.story.key;
    const n = r.expected.filter((e) => e.id.startsWith(`${key}:UI-`)).length + 1;
    const ev = a.evidence;
    r.expected.push({
      id: `${key}:UI-${String(n).padStart(2, "0")}`, storyKey: key, source: "ui", uc: "", flow: a.flow, title: a.title, type: a.type,
      steps: a.steps, expected: a.expected, evidence: `UI ${ev.url}${ev.element ? ` — ${ev.element}` : ""}${ev.screenshot ? ` (screenshot ${ev.screenshot})` : ""}`,
      priorityHint: "Medium", codeOnly: false, uiOnly: true, addedBy: by("ui"),
      reasoning: `Seen in the running app by agent ${REVIEW_AGENTS.ui}: ${a.reasoning} (UI shows what the system does; confirm it is intended.)`,
    });
    applied++;
  }
  for (const o of review.observations ?? []) {
    const r = ctx.stories.find((x) => x.expected.some((e) => e.id === o.id));
    if (!r) { missing.push(o.id); continue; }
    const e = r.expected.find((x) => x.id === o.id);
    e.uiCheck = `${o.status}: ${o.reasoning}`;
    e.reasoning = appendReason(e.reasoning, "ui", `${o.status} in the UI — ${o.reasoning}`);
    applied++;
  }
  finish(ctx, "ui", applied, missing);
  return applied;
}

/** zephyr-explorer: candidate cases to add (found by search, never linked) or remove (clearly another feature). */
export function applyZephyrReview(ctx, zephyr) {
  const review = loadReview(ctx, "zephyr");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  for (const c of review.candidates ?? []) {
    const r = ctx.R(c.storyKey);
    if (!r) { missing.push(c.storyKey); continue; }
    r.candidates ??= [];
    for (const key of c.add ?? []) {
      if (!zephyr.byKey.has(key)) { missing.push(key); continue; }
      if (r.candidates.some((x) => x.key === key)) continue;
      r.candidates.push({ key, why: `added by agent ${REVIEW_AGENTS.zephyr}: ${c.reasoning}`, linked: false });
      applied++;
    }
    for (const key of c.remove ?? []) {
      const x = r.candidates.find((y) => y.key === key);
      // Linked cases stay: removing them would hide orphans and real coverage.
      if (!x || x.linked) { missing.push(key); continue; }
      r.candidates = r.candidates.filter((y) => y.key !== key);
      applied++;
    }
  }
  finish(ctx, "zephyr", applied, missing);
  return applied;
}

/** coverage-validator: confirmed duplicates are suggested for rejection, drafts needing work for review. */
export function applyValidationReview(ctx) {
  const review = loadReview(ctx, "validation");
  if (!review) return 0;
  let applied = 0;
  const missing = [];
  for (const v of review.results ?? []) {
    const r = ctx.stories.find((x) => x.gaps?.some((g) => g.gapId === v.gapId));
    if (!r) { missing.push(v.gapId); continue; }
    const g = r.gaps.find((x) => x.gapId === v.gapId);
    g.validation = { verdict: v.verdict, duplicateOf: v.duplicateOf ?? [], by: by("validation"), reasoning: v.reasoning };
    if (g.draft && v.verdict !== "ok") {
      g.draft.suggestedDecision = v.verdict === "duplicate" ? "Reject" : "Review";
      g.draft.decisionReasoning = appendReason(g.draft.decisionReasoning, "validation", `${v.verdict}${v.duplicateOf?.length ? ` of ${v.duplicateOf.join(", ")}` : ""} — ${v.reasoning}`);
    }
    applied++;
  }
  finish(ctx, "validation", applied, missing);
  return applied;
}
