# zephyr-mcp

Stdio MCP server for reading, creating, editing and linking Zephyr Scale test
cases. Project-level tools take an optional `projectKey` (default `ZEPHYR_PROJECT_KEY`, `QA`), so one
server serves any project. The HTTP client (`src/client.mjs`) is shared with the coverage scripts in the
parent folder.

> **Zephyr Scale's API has no delete endpoint.** A created test case can only
> be fixed with `update_test_case` or removed by hand in the Zephyr UI. To
> retire a case, set its status to Deprecated.

## Tools

| Tool | What it does |
|---|---|
| `get_test_case` | `GET /testcases/{key}` |
| `get_test_steps` | `GET /testcases/{key}/teststeps` (all pages) |
| `get_issue_test_cases` | `GET /issuelinks/{issueKey}/testcases`: keys of the cases linked to a Jira issue |
| `search_test_cases` | Cases in the project, optionally by `folderId`; follows pagination up to `limit` (default 100) and reports `truncated` |
| `list_folders` | All test-case folders with `id`, `name`, `parentId` and full `path`; filter with `nameContains` / `pathContains` |
| `create_test_case` | Checks the folder, sends `POST /testcases` (defaults: status Draft, Automation Status Not Automated), then sets steps with OVERWRITE. If the steps call fails, the error includes the new key, so you can retry with `update_test_steps` instead of creating a duplicate case. |
| `update_test_case` | GET, merge patch, collapse `folder`/`priority`/`status`/`project` to `{id}`, drop `testScript`/`links`/`createdOn`, then PUT. `customFields` are merged. |
| `update_test_steps` | `POST /testcases/{key}/teststeps` with `APPEND` or `OVERWRITE` |
| `link_test_case_to_issue` | `POST /testcases/{key}/links/issues` (COVERAGE). Takes a numeric `issueId`, or an `issueKey` resolved through Jira if the `ATLASSIAN_*` variables are set |

## Setup

```sh
npm install
cp .env.example .env   # then fill in ZEPHYR_API_TOKEN etc.
npm test               # unit tests, no network
```

Configuration is read from the process environment first, then `.env.local`,
then `.env` in this directory. See [.env.example](.env.example).

## Registering with Claude Code

In the consuming project's `.mcp.json`:

```json
"zephyr": {
  "type": "stdio",
  "command": "node",
  "args": ["C:/zephyr_mcp/src/server.mjs"],
  "env": {}
}
```

Leave `env` empty to use this repo's `.env`, or pass the variables there, e.g.
`"ZEPHYR_API_TOKEN": "${ZEPHYR_API_TOKEN}"`.

## Project conventions

Naming, label, priority and folder rules are per project and live in the coverage tool's profiles, e.g.
[../profiles/avl/conventions.md](../profiles/avl/conventions.md) for AVL in project `QA`.

Reference ids for `update_test_case` patches in project `QA`: status Draft `569005`; priority Low `569010`,
Medium `569009`, High `569008`, Critical `570142`.
