// Every agent's result in one place: handoff (status, findings, forwarded notes, tokens), its review file and
// what a later stage applied from it, plus the UI explorer's evidence (inventory, screenshots, blocked requests).
// Written to agents.json / coverage.json (see run-outputs.mjs) and to the 5_UI_Exploration, 11_Agents and
// 12_Agent_Reviews sheets.
import fs from "node:fs";
import path from "node:path";
import { readJson } from "./util.mjs";

/** "[  4894ms] [WARNING] [read-only] blocked POST ./rest/x @ …" lines → unique "POST ./rest/x" with counts. */
export function parseBlockedRequests(consoleText) {
  const counts = new Map();
  for (const m of String(consoleText ?? "").matchAll(/\[read-only\] blocked (\S+) (\S+)/g)) {
    const k = `${m[1].toUpperCase()} ${m[2]}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([request, count]) => ({ request, count }));
}

/** Console errors the app logged (not our own read-only warnings), unique, with counts. */
export function parseConsoleErrors(consoleText) {
  const counts = new Map();
  for (const line of String(consoleText ?? "").split(/\r?\n/)) {
    const m = line.match(/\[ERROR\]\s*(.*?)(?:\s+@\s+\S+)?$/);
    if (!m) continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  return [...counts].map(([message, count]) => ({ message, count }));
}

/**
 * Playwright resolves a relative screenshot filename against the working directory, not --output-dir. Moves the
 * images saved in `fromDir` since `since` (ms) into the run's ui/ folder; returns the moved file names.
 */
export function collectScreenshots({ fromDir, toDir, since }) {
  const moved = [];
  for (const f of fs.readdirSync(fromDir)) {
    if (!/\.(png|jpe?g)$/i.test(f)) continue;
    const p = path.join(fromDir, f);
    const st = fs.statSync(p);
    if (!st.isFile() || st.mtimeMs < since) continue;
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(p, path.join(toDir, f));
    moved.push(f);
  }
  return moved;
}

/** Forwarded notes as plain lines: agents sometimes send a list, or a list serialised as a JSON string. */
export function notesText(notes) {
  let v = notes ?? "";
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try { v = JSON.parse(v); } catch { /* plain text that starts with [ */ }
  }
  return (Array.isArray(v) ? v.map((x) => `• ${x}`) : [String(v)]).filter((x) => x && x !== "• ").join("\n");
}

/** Rows of a review file: one per element of each top-level array, with an id, a short title and the reasoning. */
export function flattenReview(review) {
  const rows = [];
  for (const [section, value] of Object.entries(review ?? {})) {
    const list = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [{ value }];
    for (const item of list) {
      const o = item && typeof item === "object" ? item : { value: item };
      rows.push({
        section,
        id: o.id ?? o.gapId ?? o.expectedId ?? o.key ?? o.storyKey ?? "",
        title: o.title ?? o.name ?? o.functionality ?? o.issue ?? o.status ?? o.verdict ?? o.decision ?? (o.value !== undefined ? String(o.value) : ""),
        reasoning: o.reasoning ?? "",
        detail: JSON.stringify(o),
      });
    }
  }
  return rows;
}

/**
 * Collects the agent results of a run directory. `agents` is the configured pipeline order
 * ([{ name, phase, review }]), `runLog` the state's run log (apply-review steps say what was applied).
 */
export function collectAgentResults({ runDir, agents, handoffs, runLog = [] }) {
  const byName = new Map(handoffs.map((h) => [h.agent, h]));
  const out = agents.map((a) => {
    const h = byName.get(a.name) ?? null;
    const reviewFile = a.review ? path.join(runDir, "review", `${a.review}.json`) : null;
    const review = reviewFile && fs.existsSync(reviewFile) ? readJson(reviewFile, null) : null;
    const applied = runLog.filter((s) => s.step === "apply-review" && s.batch === a.name).map((s) => [s.notes, s.skipped].filter(Boolean).join(" "));
    return {
      agent: a.name, phase: a.phase, status: h?.status ?? "not run", model: h?.model ?? "", tokens: h?.tokens ?? 0, durationMs: h?.durationMs ?? 0,
      reusedFrom: h?.reusedFrom ?? null, findings: h?.findings ?? [], forwardNotes: notesText(h?.forwardNotes ?? h?.question),
      reviewFile: a.review ? `review/${a.review}.json` : null, review, applied: applied.at(-1) ?? "",
    };
  });
  const uiDir = path.join(runDir, "ui");
  const files = fs.existsSync(uiDir) ? fs.readdirSync(uiDir).sort() : [];
  const consoleText = files.filter((f) => f.startsWith("console-")).map((f) => fs.readFileSync(path.join(uiDir, f), "utf8")).join("\n");
  const uiReview = out.find((x) => x.agent === "ui-explorer")?.review ?? null;
  const ui = files.length || uiReview ? {
    screenshots: files.filter((f) => /\.(png|jpe?g)$/i.test(f)).map((f) => `ui/${f}`),
    inventory: uiReview?.inventory ?? [],
    observations: uiReview?.observations ?? [],
    scenarios: uiReview?.scenarios ?? [],
    blockedRequests: parseBlockedRequests(consoleText),
    consoleErrors: parseConsoleErrors(consoleText),
  } : null;
  return { agents: out, ui };
}
