// Rule-based triage and module assignment (0 tokens). Anything the rules cannot decide
// is left as testable: null and goes to the LLM triage stage.

export function detectAcSource(story, acSources = []) {
  if (acSources.includes("uc-doc") && /UC-\d+/.test(story.descriptionText) && /Main success scenario/i.test(story.descriptionText)) return "uc-doc";
  if (acSources.includes("ac-text") && /(^|\n)\s*(AC|Acceptance criteria)\s*[:\n]/i.test(story.descriptionText)) return "ac-text";
  if (acSources.includes("description") && story.descriptionText.length >= 80) return "description";
  return "none";
}

export function triageByRules(story, profile) {
  const nt = profile.jira.nonTestable ?? {};
  const acSource = detectAcSource(story, profile.jira.acSources);
  const rule = (testable, ruleName, reasoning) => ({ testable, decidedBy: "rule", rule: ruleName, acSource, reasoning });

  if (story.epicKey && nt.epics?.includes(story.epicKey)) {
    return rule(false, "nonTestable.epics", `Epic ${story.epicKey} ("${story.epicSummary}") is configured as non-testable in the profile (operational work, not product behaviour).`);
  }
  const label = story.labels.find((l) => nt.labels?.includes(l));
  if (label) return rule(false, "nonTestable.labels", `Label "${label}" is configured as non-testable in the profile.`);
  if (nt.summaryPattern) {
    const m = story.summary.match(new RegExp(nt.summaryPattern, nt.flags ?? "i"));
    if (m) return rule(false, "nonTestable.summaryPattern", `Summary contains "${m[0]}", which the profile marks as non-feature work (upgrades, meetings, installs, spikes).`);
  }
  if (acSource === "uc-doc") return rule(true, "uc-doc", "Description holds a structured QA scenario doc (UC-NN with main/alternative/exception flows), so test scenarios can be derived directly.");
  if (acSource === "ac-text") return rule(true, "ac-text", "Description has an explicit acceptance-criteria section (\"AC:\" / \"Acceptance criteria\").");
  return { testable: null, decidedBy: "pending", rule: null, acSource, reasoning: "No profile rule decides this story; it goes to LLM triage in the requirements stage." };
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Keyword match as whole words, tolerant of spaces/dashes ("import job" also matches "import-job", "importjob"). */
export function keywordRegex(keywords) {
  const parts = keywords.map((k) => k.trim().split(/[\s_-]+/).map(escapeRx).join("[\\s_-]?")).filter(Boolean);
  return parts.length ? new RegExp(`\\b(${parts.join("|")})\\b`, "i") : null;
}

/**
 * module = code feature path from the story text, else the requested module when the story mentions one of
 * its keywords, else a profile module whose summaryPattern matches, else the epic.
 */
export function deriveModule(story, profile, override = null) {
  const pattern = profile.code?.featurePathPattern;
  if (pattern) {
    const m = story.descriptionText.match(new RegExp(pattern, profile.code.featurePathFlags ?? "m"));
    if (m?.[1]) return { module: m[1].replace(/\/+$/, ""), moduleSource: "featurePath", featurePath: m[1].replace(/\/+$/, "") };
  }
  if (override?.module && override.keywords?.length) {
    const rx = keywordRegex(override.keywords);
    const hit = rx && (story.summary.match(rx) ?? story.descriptionText.match(rx));
    if (hit) return { module: override.module, moduleSource: "keywords", featurePath: override.module, keywordHit: hit[0] };
  }
  for (const [name, mod] of Object.entries(profile.modules ?? {})) {
    if (mod.summaryPattern && new RegExp(mod.summaryPattern, "i").test(story.summary)) {
      return { module: name, moduleSource: "profile.modules", featurePath: name };
    }
  }
  if (story.epicKey) return { module: `epic:${story.epicKey} ${story.epicSummary ?? ""}`.trim(), moduleSource: "epic", featurePath: null };
  return { module: "(no epic)", moduleSource: "none", featurePath: null };
}
