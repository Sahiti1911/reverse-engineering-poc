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
node scripts/agents.mjs                            # module, profile, environment: config/config.yaml
node scripts/agents.mjs --module "conductor"       # override the configured module for one run
npm run ui-login                                   # once per environment, before the UI explorer can log in
```

In a Claude Code session, `/coverage import job` does the same thing.

### The pipeline is configured in `config/config.yaml`

```yaml
environment: test                       # --env overrides
environments:
  test:
    uiBaseUrl: https://…                # what the UI explorer opens
    login: { method: storage-state, storageState: cache/avl/ui/test.storage.json }
    allowWrites: false                  # full UI mode is refused unless true
scope:
  statusCategories: [Done]              # only Done stories ([] = all; issues:K1,K2 and includeStories always count)
  baseline: none                        # last-run = only stories updated since the previous run of this scope
pipeline:                               # phases in order; agents of one phase run in parallel
  - { phase: scope,    agents: [module-scout] }
  - { phase: explore,  agents: [requirements-analyst, code-analyst, ui-explorer, zephyr-explorer] }
  - { phase: context,  agents: [context-builder] }
  - { phase: design,   agents: [test-designer] }
  - { phase: validate, agents: [coverage-validator] }
  - { phase: report,   agents: [reporter] }
agents:
  ui-explorer: { mode: read-only, maxPages: 8 }   # observe | read-only | full
  coverage-validator: { maxRounds: 1 }            # redesign rounds with the test-designer
```

Remove an agent to switch that part off: without `ui-explorer` nothing opens a browser, without `code-analyst`
the code is not read. `module-scout`, `requirements-analyst` and `context-builder` are required. The same file holds
the stage tuning that used to be in `config/run.json` (models, batches, limits, token budget).

### The nine agents

| Phase | Agent | Job | Writes |
|---|---|---|---|
| scope | `module-scout` | Plain words → code module, keywords, story set (Done only when configured). Stops and asks when the name is ambiguous. | `scout.json` |
| explore | `requirements-analyst` | What *should* be tested: fixes triage, adds missed AC scenarios, flags vague AC | `requirements.json` |
| explore | `code-analyst` | Code-derived edge cases: keep / drop / needs PO confirmation, **suspected bugs** | `code.json` |
| explore | `ui-explorer` | Opens the module's screens with Playwright MCP: what a tester sees, whether expected scenarios show up | `ui.json` |
| explore | `zephyr-explorer` | The right existing cases to compare with: finds never-linked cases, removes other features' cases | `zephyr.json` |
| context | `context-builder` | Joins the four, verifies doubtful Covered / Partial / Missing verdicts by reading Zephyr steps | `context.json` |
| design | `test-designer` | Drafts for Partial / Missing items only, following the conventions | `drafts.json` |
| validate | `coverage-validator` | No draft duplicates an existing case, no gap left without a usable draft; sends drafts back | `validation.json` |
| report | `reporter` | Executive summary at the top of `summary.md` | — |

The orchestrator first runs each phase's script stages (0 agent tokens), then starts the phase's agents. Agents
never write to Zephyr or Jira. Each runs headless (`claude -p --agent <name>`) with an exact tool allowlist: its own
review file, the `inspect.mjs` viewer, read-only Zephyr tools where it needs them, and for the UI explorer only the
Playwright tools of its mode. A failing optional explorer (code, UI, Zephyr) is reported and the run goes on
(`agents.continueWhenExplorerFails`). Agent definitions are in [.claude/agents/](.claude/agents/).

**UI safety.** The browser can only reach the environment's origin (`--allowed-origins`), runs in an in-memory
profile, and in `read-only` mode an init script blocks every POST/PUT/PATCH/DELETE the page sends (fetch, XHR,
form posts, beacons); `allowedWriteUrls` lets through searches sent as POST. `observe` mode has no click or type
tools at all. `full` is refused unless the environment sets `allowWrites: true`. The saved login lives in
`cache/<profile>/ui/` (git-ignored) and agents may not read it.

The output lands in `runs/<profile>/<date>_agents-<module>/`:
- `summary.md`, also copied to `runs/<profile>/latest-summary.md`
- the workbook and `coverage.json` (the same results as JSON)
- `handoff/NN-<agent>.json`: what each agent found and forwarded
- `review/<agent>.json`: the changes each agent made, merged by a later stage and labelled `agent:<name>`
- `ui/`: screenshots and the read-only init script; `mcp.json`: the MCP servers of this run

| Option | Effect |
|---|---|
| `--env <name>` | Environment the UI explorer opens (default `environment` in config.yaml) |
| `--keywords "a,b"` | Suggest related words to the scout |
| `--extra-stories <file|K1,K2>` | Candidate stories found elsewhere (Rovo), JSON `[{key, summary, query}]`. Fetched only if they are stories of the project, marked `rovo`, confirmed or dropped by the scout |
| `--limit n` | First n stories (trial) |
| `--from <agent>` | Resume the latest run of this module from that agent's phase (earlier handoffs are reused) |
| `--until <agent>` | Stop after that agent's phase |
| `--skip <agent,…>` | Run that stage without its agent review, which saves the agent's tokens (not `module-scout`) |
| `--run-dir <dir>` | Use a specific run folder |

To find module names: `node scripts/modules.mjs --find "<words>"`.

### Finding the right keywords: `scripts/vocab.mjs` (0 tokens)

`node scripts/vocab.mjs --words "grid data export" [--rovo runs/avl/rovo/<slug>.json] [--save "<name>"]`
turns what you mean into the words each source actually uses, and proposes a modules.json entry.
1. **Candidate phrases** come from Jira story summaries, Zephyr case and folder names, Rovo titles and code
   type names. Texts that name all your distinctive words anchor the list; phrases never span a separator.
2. **Each candidate is counted** in code (declaring / mentioning files), Jira (stories) and Zephyr (cases).
   Phrases found in all three rank first. A phrase that floods any source (e.g. "export") is flagged generic.
3. **Bridge to the code.** Testers say "grid export", the code says `ExportJobService`. Code phrases are
   added when enough of the stories found by the chosen keywords mention them (≥ 2 and ≥ 20 %).
4. **Proposal.** The module path comes from where the users' words are declared in the frontend; if no
   folder dominates, the feature is `crossCutting` with `codePaths`. The `zephyrFolder` is the folder
   holding most matching cases. `--save` writes it, merging with an existing entry.

Check: for "import job" it reproduces the hand-written entry (admin/import-job, "import job" + "bundle
import", folder "Bundle Import"). For "grid data export" it finds "data export", "grid export",
"export xlsx", bridges to "export job", marks it cross-cutting, and picks "Data Export (grid Export)"
(88 of 97 matching cases). `/coverage` runs Rovo, then this step, asks you to confirm, then the agents.

In module scope the matcher also compares stories with the cases in the module's `zephyrFolder` and the cases
whose names contain a keyword (`limits.moduleCandidates`), so existing tests that were never linked are found.

### Features that are not one folder, and the Rovo check

The words don't have to name a folder. A cross-cutting feature such as "grid data export" works the same way:
- **Code: keyword sweep.** The code stage searches every code root, frontend and backend, for the module's
  keywords. A file whose name or declared type contains a keyword in order (`GridExportService`,
  `CsvExportImportHelper` for "csv export") seeds the reference-following discovery. A file that only names
  a keyword (an identifier, comment or string) goes in as those lines (role `mention`). A phrase that
  declares in more than `keywordSweep.maxSeedsPerPhrase` files is reported as too generic and only listed.
  The TS `export` keyword never counts. Preview at 0 tokens:
  `node scripts/code-map.mjs --module "grid export" --keywords "export job"`.
- **Stories: Rovo.** JQL finds stories that contain a keyword. Rovo (Atlassian semantic search) also finds
  stories worded differently. Headless agents can't use claude.ai connectors, so `/coverage` runs up to 3 Rovo
  searches in your session first, writes `runs/<profile>/rovo/<module>.json` and passes it as
  `--extra-stories`. Those stories show module source `rovo` in `1_Story_Triage` and the run log, and the
  scout keeps only the ones really about the feature. Add `--no-rovo` to `/coverage` to skip it.
- **Cross-cutting features: `"crossCutting": true`** in modules.json. Pages have their own QA docs, and a
  page's doc may contain one export use case among ten others. With this flag, a story whose QA doc belongs to
  another page stays in scope when it mentions a keyword, and from any keyword- or Rovo-found UC doc only the
  use cases that mention a keyword become scenarios. The rest are listed as skipped, with the reason. Stories in
  `includeStories` keep their whole doc.

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
      "crossCutting": false,                              // true for a feature used on many pages (grid export)
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
`config/config.yaml` → `defaultProfile` makes `--profile` optional everywhere; `defaultModule` (a name or alias
from `modules.json`) makes `--module` optional for `agents.mjs`, `code-map.mjs` and `/coverage`.

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

The stages are `scope → requirements → code → zephyr → context → draft → validate → report`. Each one can also run on its own:
`node scripts/run.mjs --stage <stage> --run-dir <dir>`. That is how the agents drive the pipeline, and it lets
you re-run a single step.

The code stage reads a module's whole implementation, not only its screen. Starting from the module folder
(plus the legacy folder of the same name and any `.md` docs kept there), it follows code references: the types
the module uses, the classes named after the module that use those types, subclasses of the module's
extension points (for example one export handler per grid) and the screens that call the module. Widely
used helpers are skipped. Everything is packed into `limits.codeBytesPerModule`: the engine as full source,
variants and helpers as digests, callers as usage lines, with an implementation map listing every file and
why it was included. Tuning lives in `code.discovery` in `config/config.yaml` (`keywordSweep` for the sweep above); `searchRoots` in the profile
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
| 6_Gaps | Drafts, validation result, suggested and review decision — **where you review** |
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

Most agent tokens are cache reads of the agent's own context. The levers are all in `config/config.yaml`:
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
| [config/config.yaml](config/config.yaml) | Pipeline, environments, scope filters, agent options, stage tuning |
| [scripts/agents.mjs](scripts/agents.mjs), [scripts/lib/pipeline.mjs](scripts/lib/pipeline.mjs) | Agent pipeline orchestrator; agent registry, pipeline validation, UI safety |
| [scripts/ui-login.mjs](scripts/ui-login.mjs) | Saves a logged-in browser session for the UI explorer |
| [scripts/run.mjs](scripts/run.mjs) | Pipeline (all stages or one) and `--create-approved` |
| [scripts/lib/stages.mjs](scripts/lib/stages.mjs) | The eight stages |
| [scripts/lib/reviews.mjs](scripts/lib/reviews.mjs) | Merging agent review files |
| [scripts/inspect.mjs](scripts/inspect.mjs), [scripts/modules.mjs](scripts/modules.mjs) | Compact state viewer, module finder |
| [prompts/](prompts/), [schema/](schema/) | Stage prompts, output / review / handoff schemas (`node scripts/gen-llm-schemas.mjs`) |
| [zephyr_mcp/](zephyr_mcp/) | Local Zephyr MCP server (registered in `.mcp.json`) |
