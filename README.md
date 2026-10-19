# Coverage gap analysis

Finds the test cases that **should** exist but are missing from Zephyr Scale. It derives expected scenarios
from Jira stories (acceptance criteria and QA use-case docs) and from the source code, matches them by
meaning against the existing Zephyr cases, and writes an Excel workbook plus a short `summary.md`. Every
decision carries its reasoning, and every Claude call and agent session records the **tokens used**.
Gaps come with draft test cases, which are created only after you approve them.

It works for any Jira + Zephyr Scale + git project: a project is one `profiles/<name>/` folder.

## Quick start: name a module, let the agents do the rest

```sh
npm install
node scripts/agents.mjs --module "import job"      # profile: config/run.json defaultProfile (avl)
```

In a Claude Code session, `/coverage import job` does the same thing.

Six agents run in sequence. Each has one job, and each receives the findings of the agents before it.

| # | Agent | Job | What it forwards |
|---|---|---|---|
| 1 | `module-scout` | Plain words → code module, keywords, story set. Drops unrelated stories (e.g. "Conductor" the customer vs the Conductor page). Stops and asks when the name is ambiguous. | module, keywords, kept/dropped stories, linked tests |
| 2 | `requirements-analyst` | Checks what *should* be tested: fixes triage, adds missed AC scenarios, drops duplicates, flags vague AC | scenario counts, weak AC, what to check in code |
| 3 | `code-analyst` | Judges code-derived edge cases: keep / drop / needs PO confirmation, **suspected bugs** | kept scenarios, suspected bugs |
| 4 | `coverage-matcher` | Verifies doubtful Covered/Partial/Missing verdicts by reading the Zephyr steps (read-only) | gaps, overrides, cases to extend or link |
| 5 | `test-designer` | Brings the drafts in line with the conventions: folder, priority, create vs extend, suggested decision | ready vs needs-review drafts |
| 6 | `reporter` | Executive summary at the top of `summary.md` | — |

Agents never write to Zephyr or Jira. Each runs headless (`claude -p --agent <name>`) with an exact tool
allowlist: its own stage command, the `inspect.mjs` viewer, its own review file, and read-only Zephyr tools.
Agent definitions are in [.claude/agents/](.claude/agents/).

The output lands in `runs/<profile>/<date>_agents-<module>/`:
- `summary.md`, also copied to `runs/<profile>/latest-summary.md`
- the workbook
- `handoff/NN-<agent>.json`: what each agent found and forwarded
- `review/<agent>.json`: the changes each agent made, merged by the next stage and labelled
  `agent:<name>` in the workbook

| Option | Effect |
|---|---|
| `--keywords "a,b"` | Suggest related words to the scout |
| `--limit n` | First n stories (trial) |
| `--from <agent>` | Resume the latest run of this module from that agent (earlier handoffs are reused) |
| `--until <agent>` | Stop after that agent |
| `--skip <agent,…>` | Run that stage without its agent review, which saves the agent's tokens (not `module-scout`) |
| `--run-dir <dir>` | Use a specific run folder |

To find module names: `node scripts/modules.mjs --find "<words>"`.

## Module catalogue: `profiles/<profile>/modules.json`

Write down how you name each module once. After that, `--module "import job"` (or `/coverage import job`)
uses your settings instead of guessing. That is faster, gives the same result every time, and costs fewer
tokens.

```json
{
  "modules": {
    "import job": {
      "path": "admin/import-job",                        // code folder (node scripts/modules.mjs lists them)
      "aliases": ["bundle import", "data bundle"],        // other names that pick this module
      "keywords": ["import job", "tms.admin.importjob"],  // words Jira stories about it contain
      "zephyrFolder": "Bundle Import",                    // where new cases go
      "includeStories": ["AVLN-2398"],                    // always analysed
      "excludeStories": [],                               // never analysed (noise)
      "notes": "anything the agents should know"
    }
  }
}
```

The `//` comments above are only explanation: the real file is plain JSON (see [profiles/avl/modules.json](profiles/avl/modules.json)).
Only `path` is required, and the file is checked against `schema/modules.schema.json`. When you pass extra
`--keywords`, they are added to the configured ones. `--remember` on a module run saves the keywords it used
into this file. Modules that are not listed still work: the scout works them out.
`config/run.json` → `defaultProfile` makes `--profile` optional everywhere.

## Plain pipeline (no agents)

```sh
node scripts/run.mjs --profile avl --scope issues:AVLN-2398
node scripts/run.mjs --profile avl --scope module:admin/import-job --keywords "import job,bundle import" [--remember]
node scripts/run.mjs --profile avl --scope epic:AVLN-2574
node scripts/run.mjs --profile avl --scope project --since last-run
```

The scopes are `project`, `epic:KEY`, `sprint:active`, `sprint:<name>`, `module:<path>`,
`issues:K1,K2` and `jql:<query>`. Other options: `--dry-run` (no Claude calls), `--limit`, `--no-code`,
`--concurrency`, `--force`, `--refresh-zephyr` and `--out`. `--remember` saves module keywords into the
profile.

The stages are `scope → requirements → code → match → draft → report`. Each one can also run on its own:
`node scripts/run.mjs --stage <stage> --run-dir <dir>`. That is how the agents drive the pipeline, and it lets
you re-run a single step.

The code stage reads a module's whole implementation, not only its screen. Starting from the module folder
(plus the legacy folder of the same name and any `.md` docs kept there), it follows code references: the types
the module uses, the classes named after the module that use those types, subclasses of the module's
extension points (for example one export handler per grid) and the screens that call the module. Widely
used helpers are skipped. Everything is packed into `limits.codeBytesPerModule`: the engine as full source,
variants and helpers as digests, callers as usage lines, with an implementation map listing every file and
why it was included. Tuning lives in `code.discovery` in `config/run.json`; `searchRoots` in the profile
adds code the discovery may follow into (shared services, other backend modules). Preview what would be
sent, at 0 tokens:

```sh
node scripts/code-map.mjs --module export-job [--show core]
```

Re-runs are cheap. Claude results are cached by a fingerprint of the exact input, prompt and model, so
unchanged work uses 0 tokens. Review decisions already in the workbook are kept.

## Review and create

1. In the workbook's `6_Gaps` sheet, set **Review decision** (`Approve` / `Reject` / `Review`). It is
   pre-filled with the suggestion. You can edit the draft in place; steps use `n. action [data: x] => expected`,
   one per line.
2. `node scripts/run.mjs --create-approved <workbook.xlsx>` is a dry run. It warns about approvals nobody
   has touched.
3. Add `--yes` to create the cases. They are created as Draft, get their steps and are linked to the story;
   `extend` rows append steps instead. The created keys are written back to the workbook.
   **Zephyr has no delete endpoint.**

## Workbook

| Sheet | Content |
|---|---|
| Summary | Agent-chain findings, coverage per module, **tokens by stage and by agent** (pipeline vs agents), tokens per story / scenario / gap, cache hit ratio |
| 1_Story_Triage | Testable or not (rule / LLM / agent), module source, agent AC flags, reasoning |
| 2_Link_Check | Zephyr cases already linked to each story or a related story |
| 3_Expected_Scenarios | What should be tested (story / code), evidence, agent review (kept / dropped / needs confirmation / suspected bug) |
| 4_Zephyr_Cases | Existing cases compared, and why |
| 5_Matching | Covered / Partial / Missing with confidence; `decidedBy` shows agent overrides |
| 6_Gaps | Drafts, suggested and review decision — **where you review** |
| 7_Orphan_Zephyr | Linked cases that match no requirement |
| 8_Run_Log | Every step, review merge, skip and error |
| 9_Token_Usage | One row per Claude call and agent session: input, output, cache-read, cache-write and total tokens |

## Tokens

Only token counts are reported, never money. Measured on AVL (2026-10-17):

| Run | Pipeline | Agents |
|---|---|---|
| AVLN-2398 alone (17 UC + 15 code scenarios) | ~63k | — |
| 12 mixed stories, plain pipeline | ~290k (~36k per testable story) | — |
| Module `admin/conductor` (15 stories found, 2 relevant) | ~76k | ~483k (scout 81k, requirements 90k, code 119k, matcher 59k, designer 99k, reporter 35k) |

Most agent tokens are cache reads of the agent's own context. The levers are all in `config/run.json`:
the model per stage, the model per agent (`agents.model`), batch sizes, byte caps, and the run budget
`claude.maxTokensPerRun`. When the budget is reached, Claude calls stop and the workbook is still written.
Use `--skip <agent>` to trade agent review for tokens.

## Add a project

Follow [profiles/_template/README.md](profiles/_template/README.md): copy the folder, then fill in Jira, repo and
Zephyr details plus `conventions.md`, and validate with `--dry-run`. No code changes are needed.

## Setup

- Node 20+, `npm install`.
- `.env` (or `zephyr_mcp/.env`): `ZEPHYR_API_TOKEN`, `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`,
  `ATLASSIAN_API_TOKEN`. See [.env.example](.env.example).
- git HTTPS access to the profile's repos (your normal credentials; a sparse, blobless checkout under `cache/`).
- The Claude Code CLI, found on PATH, from the VS Code extension, or via `CLAUDE_BIN`.
- `npm test` runs the unit tests for this tool and for `zephyr_mcp`.

| Path | What |
|---|---|
| [scripts/agents.mjs](scripts/agents.mjs) | Agent chain orchestrator |
| [scripts/run.mjs](scripts/run.mjs) | Pipeline (all stages or one) and `--create-approved` |
| [scripts/lib/stages.mjs](scripts/lib/stages.mjs) | The six stages |
| [scripts/lib/reviews.mjs](scripts/lib/reviews.mjs) | Merging agent review files |
| [scripts/inspect.mjs](scripts/inspect.mjs), [scripts/modules.mjs](scripts/modules.mjs) | Compact state viewer, module finder |
| [prompts/](prompts/), [schema/](schema/) | Stage prompts, output / review / handoff schemas (`node scripts/gen-llm-schemas.mjs`) |
| [zephyr_mcp/](zephyr_mcp/) | Local Zephyr MCP server (registered in `.mcp.json`) |
