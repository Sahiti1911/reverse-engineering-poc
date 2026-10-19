// Pure helpers with no I/O, kept separate so they can be unit tested.

// Fields whose GET shape is { id, self } but which PUT expects as { id }.
const COLLAPSE_TO_ID = ["folder", "priority", "status", "project"];
// Fields returned by GET that PUT rejects.
const STRIP_ON_PUT = ["testScript", "links", "createdOn"];

/**
 * Turn a GET /testcases/{key} response plus a patch into a body PUT accepts.
 * Sending the raw GET response back returns 400, so reference fields are
 * collapsed to { id } and read-only fields are removed. customFields is merged
 * rather than replaced, so a patch that sets one custom field keeps the others.
 */
export function toPutPayload(current, patch = {}) {
  const merged = { ...current, ...patch };
  if (patch.customFields && current.customFields) {
    merged.customFields = { ...current.customFields, ...patch.customFields };
  }
  for (const field of COLLAPSE_TO_ID) {
    const value = merged[field];
    if (value && typeof value === "object" && value.id !== undefined) {
      merged[field] = { id: value.id };
    }
  }
  for (const field of STRIP_ON_PUT) delete merged[field];
  // id, key and name must survive whatever the patch contains.
  merged.id = current.id;
  merged.key = current.key;
  if (merged.name === undefined || merged.name === "") merged.name = current.name;
  return merged;
}

/** Zephyr renders BDD Script as HTML, so Gherkin lines are joined with <br />. */
export function bddToHtml(script) {
  if (!script) return "";
  return script.replace(/\r?\n/g, "<br />");
}

export function toStepItems(steps) {
  return steps.map((s) => ({
    inline: {
      description: s.description,
      testData: s.testData ?? "",
      expectedResult: s.expectedResult ?? "",
    },
  }));
}

/** Add a ` > `-joined path from the root to each folder. */
export function withFolderPaths(folders) {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const cache = new Map();
  const pathOf = (folder, seen = new Set()) => {
    if (cache.has(folder.id)) return cache.get(folder.id);
    const parent = folder.parentId != null ? byId.get(folder.parentId) : undefined;
    // seen guards against a malformed parent cycle.
    const path =
      parent && !seen.has(parent.id)
        ? `${pathOf(parent, seen.add(folder.id))} > ${folder.name}`
        : folder.name;
    cache.set(folder.id, path);
    return path;
  };
  return folders.map((f) => ({
    id: f.id,
    name: f.name,
    parentId: f.parentId ?? null,
    path: pathOf(f),
  }));
}

/** Map each Jira issue id to the keys of the test cases that link to it (from list/GET `links.issues`). */
export function indexCasesByIssueId(cases) {
  const index = new Map();
  for (const tc of cases) {
    for (const link of tc.links?.issues ?? []) {
      const id = Number(link.issueId);
      if (!index.has(id)) index.set(id, []);
      if (!index.get(id).includes(tc.key)) index.get(id).push(tc.key);
    }
  }
  return index;
}

export function filterFolders(folders, { nameContains, pathContains } = {}) {
  const name = nameContains?.toLowerCase();
  const path = pathContains?.toLowerCase();
  return folders.filter(
    (f) =>
      (!name || f.name.toLowerCase().includes(name)) &&
      (!path || f.path.toLowerCase().includes(path))
  );
}
