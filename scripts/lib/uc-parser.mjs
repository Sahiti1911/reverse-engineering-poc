// Deterministic parser for structured "QA Test Scenarios" docs (UC-NN sections with
// Main success scenario / Alternative flows / Exception flows). 0 tokens.
import { parse } from "node-html-parser";

const UC_HEADING = /^UC-(\d+)\s*[—–-]\s*(.+)$/;
const SECTION_LABELS = {
  "actor": "actor",
  "preconditions": "preconditions",
  "trigger": "trigger",
  "main success scenario": "main",
  "alternative flows": "alternatives",
  "exception flows": "exceptions",
  "postconditions": "postconditions",
  "notes": "notes",
};

const clean = (s) => s.replace(/\s+/g, " ").trim();

function listItems(el) {
  return el.querySelectorAll(":scope > li").map((li) => clean(li.textContent));
}

/** "3a — Cancel: user closes the dialog …" → { id: "3a", label: "Cancel", text: "user closes …" } */
function parseFlowItem(text) {
  const m = text.match(/^(\d+[a-z]?)\s*[—–-]\s*([^:]+):\s*(.*)$/i);
  return m ? { id: m[1], label: clean(m[2]), text: clean(m[3]) } : { id: "", label: "", text };
}

export function parseUcDoc(html) {
  if (!html || !/UC-\d+/.test(html)) return null;
  const root = parse(html);
  const nodes = root.childNodes.filter((n) => n.nodeType === 1);
  const useCases = [];
  let uc = null;
  let section = null;

  for (const el of nodes) {
    const tag = el.tagName;
    const text = clean(el.textContent);
    if (tag === "H1" || tag === "H2" || tag === "H3") {
      const m = tag === "H3" && text.match(UC_HEADING);
      if (m) {
        uc = {
          id: `UC-${m[1].padStart(2, "0")}`,
          title: clean(m[2].replace(/\((mandatory|consolidated|migrated)[^)]*\)/gi, "")),
          tags: [...m[2].matchAll(/\b(mandatory|consolidated|migrated)\b/gi)].map((t) => t[1].toLowerCase()),
          actor: "", preconditions: [], trigger: "", main: [], alternatives: [], exceptions: [], postconditions: [], notes: "",
        };
        useCases.push(uc);
      } else {
        uc = null;
      }
      section = null;
      continue;
    }
    if (!uc) continue;
    if (tag === "HR") { uc = null; section = null; continue; }
    if (tag === "P") {
      const m = text.match(/^([A-Za-z ]+?):\s*(.*)$/);
      const key = m && SECTION_LABELS[m[1].toLowerCase()];
      if (key) {
        section = key;
        if (m[2]) {
          if (key === "actor" || key === "trigger" || key === "notes") uc[key] = m[2];
          else if (Array.isArray(uc[key])) uc[key].push(m[2]);
        }
      } else if (section === "notes") {
        uc.notes = clean(`${uc.notes} ${text}`);
      }
      continue;
    }
    if ((tag === "OL" || tag === "UL") && section) {
      const items = listItems(el);
      if (section === "alternatives" || section === "exceptions") uc[section].push(...items.map(parseFlowItem));
      else if (Array.isArray(uc[section])) uc[section].push(...items);
    }
  }

  const header = clean(root.textContent).match(/generated (\S+) from (\S+)/);
  return { generatedOn: header?.[1] ?? null, sourcePath: header?.[2] ?? null, useCases };
}

// Only the flow label and title decide the type; step text mentions things like "ERROR rows" or
// "hidden fields" that say nothing about the scenario's own nature.
function classify(label, flow) {
  const t = label.toLowerCase();
  if (/permission|denied|unauthori[sz]ed|forbidden|access|role/.test(t)) return "permission";
  if (flow === "main") return "positive";
  if (/empty|invalid|required|malformed|too (long|large)|limit|exceed|duplicate|format/.test(t)) return "validation";
  if (flow === "exception" || /error|reject|fail/.test(t)) return "negative";
  return "positive";
}

/**
 * Turn a parsed UC doc into expected scenarios. Rules (skip / consolidate patterns) come from the profile,
 * so other projects with the same doc style can opt out or change them.
 */
export function ucDocToScenarios(doc, { storyKey, skipTitlePattern, consolidateTitlePattern } = {}) {
  const scenarios = [];
  const skipped = [];
  const skipRx = skipTitlePattern ? new RegExp(skipTitlePattern, "i") : null;
  const consRx = consolidateTitlePattern ? new RegExp(consolidateTitlePattern, "i") : null;

  for (const uc of doc?.useCases ?? []) {
    const ref = `${uc.id} "${uc.title}"`;
    if (skipRx?.test(uc.title)) {
      skipped.push({
        storyKey, uc: uc.id, title: uc.title,
        reasoning: `${ref} matches the profile's skip rule (/${skipTitlePattern}/): it is kept as a manual audit, not an atomic test case.`,
      });
      continue;
    }
    const base = {
      storyKey,
      uc: uc.id,
      ucTitle: uc.title,
      source: "story",
      actor: uc.actor,
      preconditions: uc.preconditions,
      codeOnly: false,
    };
    if (consRx?.test(uc.title)) {
      scenarios.push({
        ...base,
        id: `${storyKey}:${uc.id}:main`,
        flow: "main",
        title: uc.title,
        type: "permission",
        steps: uc.main,
        expected: uc.postconditions.join(" "),
        priorityHint: "Medium",
        evidence: `${uc.id} main success scenario (${uc.main.length} checks)`,
        reasoning: `${ref} matches the profile's consolidate rule (/${consolidateTitlePattern}/): its ${uc.main.length} bullets become ONE scenario with one step each. Parsed deterministically from the UC doc.`,
      });
      continue;
    }
    scenarios.push({
      ...base,
      id: `${storyKey}:${uc.id}:main`,
      flow: "main",
      title: uc.title,
      type: classify(uc.title, "main"),
      steps: uc.main,
      expected: uc.postconditions.join(" ") || uc.main.at(-1) || "",
      priorityHint: "High",
      evidence: `${uc.id} main success scenario`,
      reasoning: `Main success scenario of ${ref} (${uc.main.length} steps), parsed deterministically from the structured UC doc. Main flows are High priority by convention.`,
    });
    for (const [flow, list, label] of [["alt", uc.alternatives, "alternative flow"], ["exception", uc.exceptions, "exception flow"]]) {
      for (const item of list) {
        const fid = item.id || String(list.indexOf(item) + 1);
        scenarios.push({
          ...base,
          id: `${storyKey}:${uc.id}:${flow}-${fid}`,
          flow,
          title: `${uc.title} — ${item.label || item.text.slice(0, 60)}`,
          type: classify(item.label || item.text, flow),
          steps: [item.text],
          expected: item.text.includes("→") ? item.text.split("→").slice(1).join("→").trim() : item.text,
          priorityHint: "Medium",
          evidence: `${uc.id} ${label} ${fid}`,
          reasoning: `${label[0].toUpperCase() + label.slice(1)} ${fid} "${item.label}" of ${ref}, parsed deterministically from the UC doc. Every alternative/exception flow is its own atomic scenario.`,
        });
      }
    }
  }
  return { scenarios, skipped };
}
