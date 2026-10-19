// Rule checks of the validate stage (0 tokens, pure). The coverage-validator agent then confirms or
// overrides them by reading the suspected duplicates' steps in Zephyr.
import { tokens, overlap } from "./util.mjs";

/**
 * One gap → { verdict, duplicateOf, by, reasoning }.
 *  undrafted:          no draft (the draft stage failed or returned nothing)
 *  possible-duplicate: the draft's name shares ≥ minOverlap of its words with an existing case
 *                      (an "extend" draft is compared with every case except the one it extends)
 *  ok:                 neither
 */
export function validateGap(gap, cases, { minOverlap = 0.8 } = {}) {
  const d = gap.draft;
  if (!d || !d.name) {
    return { verdict: "undrafted", duplicateOf: [], by: "rule", reasoning: `No draft for this gap${gap.draftError ? `: ${gap.draftError}` : ""}. It stays a gap until someone writes the case.` };
  }
  const own = tokens(d.name);
  if (!own.size) return { verdict: "ok", duplicateOf: [], by: "rule", reasoning: "Draft name has no distinctive words to compare." };
  const hits = cases
    .filter((c) => c.key !== d.extendKey)
    .map((c) => ({ key: c.key, name: c.name, share: overlap(own, tokens(c.name)) / own.size }))
    .filter((h) => h.share >= minOverlap)
    .sort((a, b) => b.share - a.share)
    .slice(0, 3);
  if (!hits.length) return { verdict: "ok", duplicateOf: [], by: "rule", reasoning: `No existing case shares ${Math.round(minOverlap * 100)}% of the draft name's words.` };
  return {
    verdict: "possible-duplicate", duplicateOf: hits.map((h) => h.key), by: "rule",
    reasoning: `Draft name "${d.name}" shares ${Math.round(hits[0].share * 100)}% of its words with ${hits.map((h) => `${h.key} "${h.name}"`).join(", ")}; check the steps before creating it.`,
  };
}
