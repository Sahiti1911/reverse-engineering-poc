// Regenerates schema/llm/*.schema.json (structured-output contracts of the LLM stages).
import { writeJson } from "./lib/util.mjs";

const str = { type: "string" };
const strArr = { type: "array", items: str };
const obj = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const arr = (items) => ({ type: "array", items });
const flow = { enum: ["main", "alt", "exception"] };
const type = { enum: ["positive", "negative", "boundary", "permission", "validation", "integration"] };

const schemas = {
  triage: obj({ results: arr(obj({ key: str, testable: { type: "boolean" }, reasoning: str })) }),
  "extract-ac": obj({
    stories: arr(obj({
      key: str,
      noScenarioReason: str,
      scenarios: arr(obj({ title: str, flow, type, steps: strArr, expected: str, evidence: str, reasoning: str })),
    })),
  }),
  "extract-code": obj({
    scenarios: arr(obj({
      title: str,
      source: { enum: ["frontend", "backend"] },
      flow, type, steps: strArr, expected: str,
      evidence: obj({ path: str, symbol: str, detail: str }),
      reasoning: str,
    })),
  }),
  match: obj({
    matches: arr(obj({
      expectedId: str,
      verdict: { enum: ["Covered", "Partial", "Missing"] },
      matchedKeys: strArr,
      confidence: { enum: ["High", "Medium", "Low"] },
      missingAspects: str,
      reasoning: str,
    })),
    orphans: arr(obj({ key: str, reasoning: str })),
  }),
  design: obj({
    cases: arr(obj({
      tcId: str, title: str, storyKey: str,
      basis: strArr, scenarioIds: strArr,
      flow, type, steps: strArr, expected: str,
      whyNeeded: str,
    })),
    notes: str,
  }),
  check: obj({
    results: arr(obj({
      tcId: str,
      verdict: { enum: ["Covered", "Partial", "Missing"] },
      matchedKeys: strArr,
      confidence: { enum: ["High", "Medium", "Low"] },
      missingAspects: str,
      reasoning: str,
    })),
  }),
  draft: obj({
    drafts: arr(obj({
      gapId: str,
      action: { enum: ["create", "extend"] },
      extendKey: str,
      name: str, objective: str, precondition: str,
      priority: { enum: ["Low", "Medium", "High", "Critical"] },
      priorityReasoning: str,
      labels: strArr,
      folderId: { type: "integer" },
      folderReasoning: str,
      steps: arr(obj({ description: str, testData: str, expectedResult: str })),
      bdd: str,
      suggestedDecision: { enum: ["Approve", "Review", "Reject"] },
      decisionReasoning: str,
    })),
  }),
  "gap-review": obj({
    items: arr(obj({
      id: str,
      keep: { type: "boolean" },
      keepReasoning: str,
      gapType: { enum: ["Unclear", "Missing", "Incomplete", "Open question"] },
      title: str, description: str, gapReason: str, suggestedFix: str,
      severity: { enum: [1, 2, 3] },
      severityReasoning: str,
    })),
  }),
};

for (const [stage, schema] of Object.entries(schemas)) writeJson(`schema/llm/${stage}.schema.json`, schema);
console.log("wrote", Object.keys(schemas).join(", "));

// ---------- agent chain: review files (written by agents, merged by the next stage) + handoff ----------
const opt = (properties) => ({ type: "object", properties, additionalProperties: false });
const reviewSchemas = {
  scout: opt({
    notes: str,
    dropStories: arr(obj({ key: str, reasoning: str })),
  }),
  requirements: opt({
    triageOverrides: arr(obj({ key: str, testable: { type: "boolean" }, reasoning: str })),
    dropScenarios: arr(obj({ id: str, reasoning: str })),
    addScenarios: arr(obj({ storyKey: str, title: str, flow, type, steps: strArr, expected: str, evidence: str, reasoning: str })),
    editScenarios: arr({ ...obj({ id: str, reasoning: str }), properties: { id: str, reasoning: str, title: str, type, steps: strArr, expected: str } }),
    flags: arr(obj({ key: str, issue: str })),
  }),
  code: opt({
    decisions: arr({
      ...obj({ id: str, decision: { enum: ["keep", "drop", "needs-confirmation"] }, reasoning: str }),
      properties: { id: str, decision: { enum: ["keep", "drop", "needs-confirmation"] }, reasoning: str, suspectedBug: { type: "boolean" } },
    }),
  }),
  match: opt({
    overrides: arr({
      ...obj({ expectedId: str, verdict: { enum: ["Covered", "Partial", "Missing"] }, reasoning: str }),
      properties: { expectedId: str, verdict: { enum: ["Covered", "Partial", "Missing"] }, matchedKeys: strArr, confidence: { enum: ["High", "Medium", "Low"] }, reasoning: str },
    }),
  }),
  drafts: opt({
    edits: arr({
      ...obj({ gapId: str, reasoning: str }),
      properties: {
        gapId: str, reasoning: str, action: { enum: ["create", "extend"] }, extendKey: str, name: str, objective: str, precondition: str,
        priority: { enum: ["Low", "Medium", "High", "Critical"] }, labels: strArr, folderId: { type: "integer" },
        steps: arr(obj({ description: str, testData: str, expectedResult: str })), bdd: str,
        suggestedDecision: { enum: ["Approve", "Review", "Reject"] },
      },
    }),
  }),
};
for (const [agent, schema] of Object.entries(reviewSchemas)) writeJson(`schema/review/${agent}.schema.json`, schema);

writeJson("schema/handoff.schema.json", {
  ...obj({ status: { enum: ["ok", "blocked", "failed"] }, findings: strArr, forwardNotes: str, outputs: strArr }),
  properties: { status: { enum: ["ok", "blocked", "failed"] }, findings: strArr, forwardNotes: str, outputs: strArr, question: str },
});
console.log("wrote review schemas:", Object.keys(reviewSchemas).join(", "), "+ handoff");
