// config/config.yaml `output.fields`: extra fields Claude fills in on top of the built-in ones. Each field is added
// to its stage's JSON schema and system prompt (so only that stage's cache is invalidated), kept on the record the
// stage writes, and shown as its own column in the stage's sheet and in coverage.json.

/** LLM stages that take extra fields: the path to the item object in the stage schema, what an item is, and its sheet. */
export const FIELD_STAGES = {
  "extract-ac": { path: ["stories", "scenarios"], item: "scenario", sheet: "expected" },
  "extract-code": { path: ["scenarios"], item: "scenario", sheet: "expected" },
  match: { path: ["matches"], item: "match", sheet: "matching" },
  design: { path: ["cases"], item: "designed case", sheet: "design" },
  draft: { path: ["drafts"], item: "draft", sheet: "gaps" },
};

// Keys the stages set on the records themselves; an extra field may not reuse them.
const RESERVED = new Set([
  "id", "storyKey", "source", "uc", "repo", "codeOnly", "uiOnly", "priorityHint", "autoAccepted", "decidedBy", "gapId", "tcId",
  "check", "folderPath", "scenarioIds", "validation", "reviewDecision", "notes", "createdKey", "addedBy", "droppedBy", "codeReview",
  "suspectedBug", "uiCheck", "evidence", "extra",
]);

const itemSchema = (schema, stage) => FIELD_STAGES[stage].path.reduce((s, p) => s.properties[p].items, schema);

/** Normalised `output.fields` (stages always a list). Throws on a field that cannot work, before any tokens are spent. */
export function outputFields(cfg, schemaFor = null) {
  const fields = cfg?.output?.fields ?? [];
  if (!Array.isArray(fields)) throw new Error("config output.fields must be a list");
  const seen = new Set();
  return fields.map((f, i) => {
    const where = `config output.fields[${i}]${f?.name ? ` (${f.name})` : ""}`;
    if (!/^[a-z][A-Za-z0-9]*$/.test(f?.name ?? "")) throw new Error(`${where}: name must be camelCase letters and digits, e.g. riskLevel`);
    if (RESERVED.has(f.name)) throw new Error(`${where}: "${f.name}" is used by the pipeline itself; choose another name`);
    if (!String(f.description ?? "").trim()) throw new Error(`${where}: description is required (it is what Claude is told to fill in)`);
    const stages = [f.stages ?? f.stage].flat().filter(Boolean);
    if (!stages.length) throw new Error(`${where}: stages is required (${Object.keys(FIELD_STAGES).join(", ")})`);
    for (const s of stages) {
      if (!FIELD_STAGES[s]) throw new Error(`${where}: unknown stage "${s}" (${Object.keys(FIELD_STAGES).join(", ")})`);
      if (seen.has(`${s}:${f.name}`)) throw new Error(`${where}: "${f.name}" is defined twice for stage ${s}`);
      seen.add(`${s}:${f.name}`);
      if (schemaFor && itemSchema(schemaFor(s), s).properties[f.name]) throw new Error(`${where}: stage ${s} already has a field "${f.name}"`);
    }
    if (f.values !== undefined && (!Array.isArray(f.values) || !f.values.length)) throw new Error(`${where}: values must be a non-empty list`);
    return { name: f.name, description: String(f.description).trim(), stages, values: f.values?.map(String) ?? null, list: !!f.list, header: f.header ?? f.name };
  });
}

export const fieldsForStage = (fields, stage) => fields.filter((f) => f.stages.includes(stage));
export const fieldsForSheet = (fields, sheet) => {
  const names = new Set();
  return fields.filter((f) => f.stages.some((s) => FIELD_STAGES[s].sheet === sheet) && !names.has(f.name) && names.add(f.name));
};

/** The stage schema with the extra fields added (required) to its item object. The input is not modified. */
export function withExtraFields(schema, stage, fields) {
  const own = fieldsForStage(fields, stage);
  if (!own.length) return schema;
  const copy = structuredClone(schema);
  const item = itemSchema(copy, stage);
  for (const f of own) {
    const one = f.values ? { enum: f.values } : { type: "string" };
    item.properties[f.name] = f.list ? { type: "array", items: one } : one;
    item.required = [...(item.required ?? []), f.name];
  }
  return copy;
}

/** System-prompt addition telling Claude what to put in the extra fields; "" when the stage has none. */
export function extraFieldsPrompt(fields, stage) {
  const own = fieldsForStage(fields, stage);
  if (!own.length) return "";
  const L = ["## Extra fields (requested in config/config.yaml, output.fields)", `Every ${FIELD_STAGES[stage].item} you return also has these fields. Fill each one for every ${FIELD_STAGES[stage].item}:`];
  for (const f of own) {
    const kind = f.values ? `${f.list ? "list of " : "one of "}${f.values.join(" | ")}` : f.list ? "list of strings" : "string";
    L.push(`- \`${f.name}\` (${kind}): ${f.description}`);
  }
  return L.join("\n");
}

/** The extra fields' values on a record, for coverage.json. Missing ones are null. */
export const pickExtras = (record, fields) => Object.fromEntries(fields.map((f) => [f.name, record?.[f.name] ?? null]));

/** Workbook cells for the extra fields: key `x_<name>`, lists joined. */
export const extraCells = (record, fields) =>
  Object.fromEntries(fields.map((f) => {
    const v = record?.[f.name];
    return [`x_${f.name}`, Array.isArray(v) ? v.join(", ") : v ?? ""];
  }));

export const extraColumns = (fields) => fields.map((f) => ({ header: f.header, key: `x_${f.name}`, width: 30, wrap: true }));
