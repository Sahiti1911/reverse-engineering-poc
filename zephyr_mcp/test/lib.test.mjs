import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toPutPayload,
  bddToHtml,
  toStepItems,
  withFolderPaths,
  filterFolders,
  indexCasesByIssueId,
} from "../src/lib.mjs";
import { zephyrBaseUrl } from "../src/client.mjs";

const getResponse = {
  id: 1001,
  key: "QA-T1",
  name: "AVL - Admin - Import - happy path",
  project: { id: 10, self: "https://x/projects/10" },
  folder: { id: 20, self: "https://x/folders/20" },
  priority: { id: 569008, self: "https://x/priorities/569008" },
  status: { id: 569005, self: "https://x/statuses/569005" },
  createdOn: "2026-01-01T00:00:00Z",
  objective: "old",
  labels: ["AVL_Admin"],
  testScript: { self: "https://x/testcases/QA-T1/testscript" },
  links: { self: "https://x/links", issues: [] },
  customFields: { "BDD Script": "Feature: x", "Automation Status": "Not Automated" },
};

test("toPutPayload collapses reference fields and strips read-only ones", () => {
  const body = toPutPayload(getResponse, { objective: "new" });
  assert.equal(body.objective, "new");
  assert.deepEqual(body.project, { id: 10 });
  assert.deepEqual(body.folder, { id: 20 });
  assert.deepEqual(body.priority, { id: 569008 });
  assert.deepEqual(body.status, { id: 569005 });
  assert.equal(body.testScript, undefined);
  assert.equal(body.links, undefined);
  assert.equal(body.createdOn, undefined);
  assert.equal(body.id, 1001);
  assert.equal(body.key, "QA-T1");
  assert.equal(body.name, getResponse.name);
});

test("toPutPayload merges customFields and protects id/key", () => {
  const body = toPutPayload(getResponse, {
    customFields: { "Automation Status": "Automated" },
    id: 999,
    key: "QA-T999",
    priority: { id: 569009 },
  });
  assert.deepEqual(body.customFields, { "BDD Script": "Feature: x", "Automation Status": "Automated" });
  assert.equal(body.id, 1001);
  assert.equal(body.key, "QA-T1");
  assert.deepEqual(body.priority, { id: 569009 });
});

test("toPutPayload keeps a null folder as null", () => {
  assert.equal(toPutPayload({ ...getResponse, folder: null }).folder, null);
});

test("bddToHtml joins Gherkin lines with <br />", () => {
  assert.equal(bddToHtml("Feature: a\r\n  Scenario: b\n    Given c"), "Feature: a<br />  Scenario: b<br />    Given c");
  assert.equal(bddToHtml(undefined), "");
});

test("toStepItems fills optional fields with empty strings", () => {
  assert.deepEqual(toStepItems([{ description: "Click" }]), [
    { inline: { description: "Click", testData: "", expectedResult: "" } },
  ]);
});

test("withFolderPaths builds full paths regardless of order", () => {
  const folders = withFolderPaths([
    { id: 3, parentId: 2, name: "Admin" },
    { id: 1, parentId: null, name: "Ridango" },
    { id: 2, parentId: 1, name: "AVL" },
  ]);
  assert.equal(folders.find((f) => f.id === 3).path, "Ridango > AVL > Admin");
  assert.deepEqual(filterFolders(folders, { nameContains: "adm" }).map((f) => f.id), [3]);
  assert.deepEqual(filterFolders(folders, { pathContains: "ridango > avl" }).map((f) => f.id).sort(), [2, 3]);
});

test("withFolderPaths survives a parent cycle", () => {
  const folders = withFolderPaths([
    { id: 1, parentId: 2, name: "A" },
    { id: 2, parentId: 1, name: "B" },
  ]);
  assert.equal(folders.length, 2);
});

test("indexCasesByIssueId maps issue ids to case keys without duplicates", () => {
  const index = indexCasesByIssueId([
    { key: "QA-T1", links: { issues: [{ issueId: 514329 }, { issueId: "7" }] } },
    { key: "QA-T2", links: { issues: [{ issueId: 514329 }, { issueId: 514329 }] } },
    { key: "QA-T3", links: { issues: [] } },
    { key: "QA-T4" },
  ]);
  assert.deepEqual(index.get(514329), ["QA-T1", "QA-T2"]);
  assert.deepEqual(index.get(7), ["QA-T1"]);
  assert.equal(index.size, 2);
});

test("zephyrBaseUrl picks the EU host for eu/true", () => {
  assert.match(zephyrBaseUrl("eu"), /^https:\/\/eu\./);
  assert.match(zephyrBaseUrl("true"), /^https:\/\/eu\./);
  assert.doesNotMatch(zephyrBaseUrl("us"), /eu\./);
});
