#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createZephyrClient } from "./client.mjs";
import {
  toPutPayload,
  bddToHtml,
  toStepItems,
  withFolderPaths,
  filterFolders,
} from "./lib.mjs";

// Env set by the caller (e.g. the .mcp.json "env" block) wins over these files.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: [path.join(ROOT, ".env.local"), path.join(ROOT, ".env")], quiet: true });

const TOKEN = process.env.ZEPHYR_API_TOKEN;
const DEFAULT_PROJECT_KEY = process.env.ZEPHYR_PROJECT_KEY || "QA";
const JIRA_BASE_URL = process.env.ATLASSIAN_BASE_URL?.replace(/\/+$/, "");
const JIRA_EMAIL = process.env.ATLASSIAN_EMAIL;
const JIRA_TOKEN = process.env.ATLASSIAN_API_TOKEN;

if (!TOKEN) {
  console.error("Missing ZEPHYR_API_TOKEN (set it in .env, .env.local or the .mcp.json env block)");
  process.exit(1);
}

const { request: zephyr, getAll: zephyrGetAll } = createZephyrClient({
  token: TOKEN,
  region: process.env.ZEPHYR_EU_REGION === "true" ? "eu" : "us",
});

const NO_DELETE_WARNING =
  "Zephyr Scale's API has NO delete endpoint: a created test case cannot be deleted through the API, " +
  "only fixed with update_test_case or removed by hand in the Zephyr UI. " +
  "Show the user the full payload and get their confirmation before calling this tool.";

async function resolveJiraIssueId(issueKey) {
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_TOKEN) {
    throw new Error(
      "Resolving a Jira issue key needs ATLASSIAN_BASE_URL, ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN. " +
        "Set them, or pass the numeric issueId instead."
    );
  }
  const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64")}`,
      Accept: "application/json",
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Jira API ${res.status} for ${issueKey}: ${JSON.stringify(data)}`);
  return { id: Number(data.id), key: data.key, summary: data.fields?.summary };
}

// ---------- tool helpers ----------

const json = (data) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const fail = (message, data) => ({
  isError: true,
  content: [{ type: "text", text: data ? `${message}\n${JSON.stringify(data, null, 2)}` : message }],
});
const enc = encodeURIComponent;

const keySchema = z.string().describe("Test case key, e.g. QA-T10257");
const projectKeySchema = z.string().optional()
  .describe(`Zephyr project key (default ${DEFAULT_PROJECT_KEY}, from ZEPHYR_PROJECT_KEY)`);
const stepSchema = z.object({
  description: z.string().describe("The UI action to perform"),
  testData: z.string().optional().describe("Optional test data for the step"),
  expectedResult: z.string().describe("Specific, checkable expected result"),
});

const server = new McpServer({ name: "zephyr-scale", version: "2.1.0" });

// ---------- read tools ----------

server.registerTool(
  "get_test_case",
  {
    description: "Fetch a Zephyr Scale test case by key (e.g. QA-T10257)",
    inputSchema: { key: keySchema },
    annotations: { readOnlyHint: true },
  },
  async ({ key }) => json(await zephyr("GET", `/testcases/${enc(key)}`))
);

server.registerTool(
  "get_test_steps",
  {
    description: "Fetch the step-by-step test script of a Zephyr Scale test case by key",
    inputSchema: { key: keySchema },
    annotations: { readOnlyHint: true },
  },
  async ({ key }) => json(await zephyrGetAll(`/testcases/${enc(key)}/teststeps`, {}))
);

server.registerTool(
  "get_issue_test_cases",
  {
    description:
      "List the Zephyr Scale test cases linked to a Jira issue (GET /issuelinks/{issueKey}/testcases). " +
      "Fast way to check whether a story has any test coverage at all.",
    inputSchema: { issueKey: z.string().describe("Jira issue key, e.g. AVLN-2398") },
    annotations: { readOnlyHint: true },
  },
  async ({ issueKey }) => {
    const links = await zephyr("GET", `/issuelinks/${enc(issueKey)}/testcases`);
    return json({ issueKey, count: links.length, testCases: links.map((l) => l.key) });
  }
);

server.registerTool(
  "search_test_cases",
  {
    description:
      "List Zephyr Scale test cases in a project, optionally filtered by folder id. " +
      "Follows pagination until `limit` cases are collected; `truncated: true` means more exist. " +
      "Note: a folder filter matches only cases directly in that folder, not in its subfolders.",
    inputSchema: {
      projectKey: projectKeySchema,
      folderId: z.number().int().optional().describe("Folder id to filter by (see list_folders)"),
      limit: z.number().int().min(1).max(5000).optional()
        .describe("Max number of cases to return across all pages (default 100)"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ projectKey, folderId, limit }) =>
    json(await zephyrGetAll(
      "/testcases",
      { projectKey: projectKey ?? DEFAULT_PROJECT_KEY, folderId },
      { limit: limit ?? 100 }
    ))
);

server.registerTool(
  "list_folders",
  {
    description:
      "List test case folders in a project with id, name, parentId and full path " +
      "(e.g. 'Ridango > AVL > Masterdata Import & Export > Bundle Import'). Fetches all pages, then filters. " +
      "Which subtree new cases belong in is a per-project convention (see the project's profile conventions).",
    inputSchema: {
      projectKey: projectKeySchema,
      nameContains: z.string().optional().describe("Case-insensitive substring of the folder's own name"),
      pathContains: z.string().optional().describe("Case-insensitive substring of the full path"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ projectKey, nameContains, pathContains }) => {
    const { values } = await zephyrGetAll(
      "/folders",
      { projectKey: projectKey ?? DEFAULT_PROJECT_KEY, folderType: "TEST_CASE" },
      { pageSize: 200 }
    );
    const folders = filterFolders(withFolderPaths(values), { nameContains, pathContains });
    folders.sort((a, b) => a.path.localeCompare(b.path));
    return json({ count: folders.length, folders });
  }
);

// ---------- write tools ----------

server.registerTool(
  "create_test_case",
  {
    description:
      "Create a test case (POST /testcases), then set its steps if given. " +
      NO_DELETE_WARNING +
      " Follow the target project's naming, label, priority and folder conventions. " +
      "If the case is created but setting steps fails, the error contains the new key: retry with " +
      "update_test_steps on that key, do NOT call create_test_case again.",
    inputSchema: {
      projectKey: projectKeySchema,
      name: z.string().min(1),
      folderId: z.number().int().describe("Target folder id (find it with list_folders)"),
      objective: z.string().optional(),
      precondition: z.string().optional(),
      priority: z.enum(["Low", "Medium", "High", "Critical"]),
      labels: z.array(z.string()).describe("e.g. [\"AVL_Admin\", \"AVL_ImportJob\"]"),
      bddScript: z.string().optional()
        .describe("Gherkin text; newlines are converted to <br /> for the BDD Script custom field"),
      steps: z.array(stepSchema).optional().describe("Steps in order; set with OVERWRITE after creation"),
      status: z.string().optional().describe("Status name (default Draft)"),
      automationStatus: z.string().optional().describe("Automation Status custom field (default Not Automated)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  },
  async (input) => {
    // Check the folder first: a case created in the wrong place can't be deleted.
    const folder = await zephyr("GET", `/folders/${input.folderId}`);
    if (folder.folderType && folder.folderType !== "TEST_CASE") {
      return fail(`Folder ${input.folderId} ('${folder.name}') is a ${folder.folderType} folder, not TEST_CASE. Nothing was created.`);
    }

    const payload = {
      projectKey: input.projectKey ?? DEFAULT_PROJECT_KEY,
      name: input.name,
      objective: input.objective,
      precondition: input.precondition,
      folderId: input.folderId,
      statusName: input.status ?? "Draft",
      priorityName: input.priority,
      labels: input.labels,
      customFields: {
        "Test Data BDD": "",
        "BDD Script": bddToHtml(input.bddScript),
        "Automation Status": input.automationStatus ?? "Not Automated",
      },
    };
    const created = await zephyr("POST", "/testcases", { body: payload });

    let stepsSet = 0;
    if (input.steps?.length) {
      try {
        await zephyr("POST", `/testcases/${enc(created.key)}/teststeps`, {
          body: { mode: "OVERWRITE", items: toStepItems(input.steps) },
        });
        stepsSet = input.steps.length;
      } catch (err) {
        return fail(
          `Test case ${created.key} WAS CREATED, but setting its steps failed. ` +
            `Do not create it again: retry with update_test_steps (key ${created.key}, mode OVERWRITE).\n${err.message}`,
          { created }
        );
      }
    }
    return json({ ...created, folder: folder.name, stepsSet });
  }
);

server.registerTool(
  "update_test_case",
  {
    description:
      "Update fields on a Zephyr Scale test case (e.g. objective, precondition, name, labels, customFields). " +
      "Fetches the case, merges the patch, collapses folder/priority/status/project to { id }, drops " +
      "testScript/links/createdOn and PUTs the result. customFields are merged, so you can send only the ones you change. " +
      "Steps are not part of this object: use update_test_steps. " +
      "There is no delete endpoint; to retire a case set its status to Deprecated.",
    inputSchema: {
      key: keySchema,
      patch: z.record(z.string(), z.any()).describe(
        "Fields to change, e.g. { \"objective\": \"...\" } or { \"priority\": { \"id\": 569009 } }. " +
          "Reference fields (status, priority, folder) take { \"id\": n }; ids are project-specific."
      ),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  async ({ key, patch }) => {
    const current = await zephyr("GET", `/testcases/${enc(key)}`);
    const body = toPutPayload(current, patch);
    await zephyr("PUT", `/testcases/${enc(key)}`, { body });
    return json(await zephyr("GET", `/testcases/${enc(key)}`));
  }
);

server.registerTool(
  "update_test_steps",
  {
    description:
      "Replace or append steps on a Zephyr Scale test case (POST /testcases/{key}/teststeps). " +
      "mode APPEND adds `steps` after the existing ones; OVERWRITE replaces all steps with `steps`. " +
      "Fetch current steps first (get_test_steps) if you need to keep or reorder existing ones under OVERWRITE.",
    inputSchema: {
      key: keySchema,
      mode: z.enum(["APPEND", "OVERWRITE"]),
      steps: z.array(stepSchema.extend({ expectedResult: z.string().optional() })).min(1),
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  async ({ key, mode, steps }) =>
    json(await zephyr("POST", `/testcases/${enc(key)}/teststeps`, { body: { mode, items: toStepItems(steps) } }))
);

server.registerTool(
  "link_test_case_to_issue",
  {
    description:
      "Link a test case to a Jira issue as COVERAGE (POST /testcases/{key}/links/issues), so it shows in the " +
      "issue's Tests panel. Pass the numeric issueId, or an issueKey (e.g. AVLN-2398) to resolve through the " +
      "Jira API. Links cannot be removed through this server; confirm the case and issue with the user first.",
    inputSchema: {
      key: keySchema,
      issueId: z.number().int().optional().describe("Numeric Jira issue id, e.g. 514329"),
      issueKey: z.string().optional().describe("Jira issue key, e.g. AVLN-2398 (needs ATLASSIAN_* env vars)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ key, issueId, issueKey }) => {
    if ((issueId === undefined) === (issueKey === undefined)) {
      return fail("Pass exactly one of issueId or issueKey.");
    }
    let issue = { id: issueId };
    if (issueKey) issue = await resolveJiraIssueId(issueKey);
    const result = await zephyr("POST", `/testcases/${enc(key)}/links/issues`, { body: { issueId: issue.id } });
    return json({ linked: true, testCase: key, issue, result });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
