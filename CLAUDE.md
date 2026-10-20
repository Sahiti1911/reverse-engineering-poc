# Coverage gap analysis — working rules

Tool: Jira stories + source code vs Zephyr Scale → Excel (see README.md). Project facts live only in
`profiles/<name>/`; code under `scripts/` must stay project-agnostic.

## Hard rules
- **Never create, update or link Zephyr cases without explicit confirmation for that batch.** Zephyr Scale
  has no delete endpoint. Creation goes through `create-approved` (dry run first, then `--yes`) or the
  zephyr MCP write tools after showing the payload.
- Never post Jira comments or change Jira issues as part of an analysis.
- `cache/<profile>/repos/` are read-only reference clones. Never edit them.
- Secrets live in `.env` / `zephyr_mcp/.env`. Never print or copy them.

## Agents
- `config/config.yaml` holds the pipeline (phases and their agents), environments, scope filters and agent
  options. `.claude/agents/*.md` define the nine agents. Their tool lists must include `StructuredOutput`.
  Without it, a headless `--json-schema` run returns nothing, and leaving out the tool list loads every tool
  (about 150k tokens per call).
- Agents change state only through `review/<key>.json` (schemas in `schema/review/`), which a later stage
  merges (the four explorers' reviews merge in the context stage). Never let an agent edit `state.json` or the workbook.
- The allowlists live in `allowedTools()` in `scripts/agents.mjs`. Keep them exact: own stage only,
  read-only Zephyr tools, Playwright tools only for `ui-explorer` and only those of its configured mode
  (`uiTools()` in `scripts/lib/pipeline.mjs`).
- The UI explorer never changes data on an environment without `allowWrites: true`; read-only mode blocks the
  page's writes with an init script. Saved logins (`cache/<profile>/ui/`) are secrets: agents may not read them.

## Conventions in this repo
- Report **tokens only**. No cost or USD fields in logs, the workbook or summaries (a test enforces this).
- Deterministic work goes in scripts (0 tokens). Claude calls go through `scripts/lib/llm.mjs` so they are
  cached, budgeted and logged in `token_log.jsonl`.
- Every row that records a decision carries a reasoning string; `buildWorkbook` rejects rows without one.
- A changed prompt (`prompts/*.md`) or schema (`schema/llm/*`, regenerated with
  `node scripts/gen-llm-schemas.mjs`) invalidates the cache for that stage only.
- Add a unit test in `test/core.test.mjs` for any new pure helper. Run `npm test`.
- Calibration story for AVL: `AVLN-2398`. Its UC-01 must match QA-T10855 (main), QA-T10856 (cancel)
  and QA-T10858 (rejected upload).
