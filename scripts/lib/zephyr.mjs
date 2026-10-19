import fs from "node:fs";
import path from "node:path";
import { createZephyrClient } from "../../zephyr_mcp/src/client.mjs";
import { withFolderPaths, indexCasesByIssueId, toStepItems, bddToHtml } from "../../zephyr_mcp/src/lib.mjs";
import { readJson, writeJson, htmlToText, truncate } from "./util.mjs";

export { toStepItems, bddToHtml };

export function zephyrClientFor(profile) {
  return createZephyrClient({ token: process.env.ZEPHYR_API_TOKEN, region: profile.zephyr.region });
}

const isFresh = (file, maxAgeHours) =>
  fs.existsSync(file) && (Date.now() - fs.statSync(file).mtimeMs) / 3_600_000 < maxAgeHours;

function normalizeCase(tc, folderPath, statusName, priorityName) {
  return {
    key: tc.key,
    id: tc.id,
    name: tc.name,
    objective: truncate(htmlToText(tc.objective), 800),
    precondition: truncate(htmlToText(tc.precondition), 500),
    labels: tc.labels ?? [],
    folderId: tc.folder?.id ?? null,
    folderPath: folderPath ?? "",
    status: statusName ?? "",
    priority: priorityName ?? "",
    automation: tc.customFields?.["Automation Status"] ?? "",
    bdd: truncate(htmlToText(tc.customFields?.["BDD Script"]), 600),
    issueIds: (tc.links?.issues ?? []).map((l) => Number(l.issueId)),
    createdOn: tc.createdOn,
  };
}

/**
 * Export every test case of the profile's Zephyr project (0 tokens), with folder paths, and index them by
 * linked Jira issue id. Cached for `maxAgeHours`; `force` refreshes.
 */
export async function exportZephyr({ profile, cacheDir, maxAgeHours = 12, force = false, log = () => {} }) {
  const file = path.join(cacheDir, "zephyr", "export.json");
  let data = !force && isFresh(file, maxAgeHours) ? readJson(file) : null;
  if (!data) {
    const client = zephyrClientFor(profile);
    const projectKey = profile.zephyr.projectKey;
    log(`Zephyr: exporting project ${projectKey} (folders, statuses, priorities, cases)…`);
    const folders = withFolderPaths(
      (await client.getAll("/folders", { projectKey, folderType: "TEST_CASE" }, { pageSize: 200 })).values
    );
    const statuses = (await client.getAll("/statuses", { projectKey, statusType: "TEST_CASE" }, { pageSize: 200 })).values;
    const priorities = (await client.getAll("/priorities", { projectKey }, { pageSize: 200 })).values;
    const folderPath = new Map(folders.map((f) => [f.id, f.path]));
    const statusName = new Map(statuses.map((s) => [s.id, s.name]));
    const priorityName = new Map(priorities.map((p) => [p.id, p.name]));
    const raw = (await client.getAll("/testcases", { projectKey }, { pageSize: 1000 })).values;
    const cases = raw.map((tc) =>
      normalizeCase(tc, folderPath.get(tc.folder?.id), statusName.get(tc.status?.id), priorityName.get(tc.priority?.id))
    );
    data = { exportedAt: new Date().toISOString(), projectKey, folders, cases };
    writeJson(file, data);
    log(`Zephyr: exported ${cases.length} cases and ${folders.length} folders`);
  } else {
    log(`Zephyr: using cached export from ${data.exportedAt} (${data.cases.length} cases)`);
  }
  const root = profile.zephyr.folderRoot.toLowerCase();
  const inScope = (c) => c.folderPath.toLowerCase().startsWith(root);
  const byKey = new Map(data.cases.map((c) => [c.key, c]));
  return {
    ...data,
    byKey,
    inScopeCases: data.cases.filter(inScope),
    inScopeFolders: data.folders.filter((f) => f.path.toLowerCase().startsWith(root)),
    issueIndex: indexCasesByIssueId(data.cases.map((c) => ({ key: c.key, links: { issues: c.issueIds.map((issueId) => ({ issueId })) } }))),
  };
}

/** Steps of one case as plain text, cached per key. */
export async function getSteps({ profile, cacheDir, key, maxAgeHours = 168 }) {
  const file = path.join(cacheDir, "zephyr", "steps", `${key}.json`);
  if (isFresh(file, maxAgeHours)) return readJson(file);
  const client = zephyrClientFor(profile);
  const { values } = await client.getAll(`/testcases/${encodeURIComponent(key)}/teststeps`, {}, { pageSize: 100 });
  const steps = values.map((v) =>
    v.inline
      ? {
          description: htmlToText(v.inline.description),
          testData: htmlToText(v.inline.testData),
          expectedResult: htmlToText(v.inline.expectedResult),
        }
      : { description: `(calls test case ${v.testCase?.testCaseKey ?? "?"})`, testData: "", expectedResult: "" }
  );
  writeJson(file, steps);
  return steps;
}

export function caseUrl(profile, key) {
  return profile.zephyr.caseUrl ? profile.zephyr.caseUrl.replace("{key}", key) : null;
}
