---
description: Run the coverage agent pipeline for the module in config/config.yaml (or a module or feature named in plain words, e.g. /coverage conductor, /coverage grid data export)
argument-hint: [module or feature in plain words] [--keywords "a,b"] [--limit n] [--from <agent>] [--skip <agent>] [--no-rovo] [--rediscover]
allowed-tools: Bash(node scripts/agents.mjs *), Bash(node scripts/modules.mjs *), Bash(node scripts/vocab.mjs *), Read, Write(./runs/*/rovo/*.json), mcp__claude_ai_Atlassian_Rovo__search, AskUserQuestion
---
Run the coverage agent pipeline. Arguments: $ARGUMENTS

The words can name a page module ("import job") or a cross-cutting feature with no folder of its own
("grid data export"). Before the agents run, steps 0–1 decide WHAT is analysed: the module, its keywords
and its Zephyr folder, all checked against the code, the Jira stories and the Zephyr cases.

Profile = `defaultProfile` in config/config.yaml. Module words = the words in the arguments, else `defaultModule`.
Skip steps 0–1 when resuming with `--from`.

0. **Rovo search** (skip with `--no-rovo`). The agents run headless and cannot use the claude.ai Atlassian
   connector, so this step runs here.
   a. Run at most 3 `mcp__claude_ai_Atlassian_Rovo__search` queries, each worded as
      `<projectKey> stories about <module words>` (projectKey from `profiles/<profile>/profile.json` →
      jira.projectKey); if the module is configured in `profiles/<profile>/modules.json`, use one or two of its
      most specific keywords for the other queries. Each call can cost Rovo credits, so don't run more than 3.
   b. Keep the Jira results whose URL ends in `/browse/<projectKey>-<n>` as stories, and the Confluence pages that
      are clearly about the feature as docs. Drop everything else.
   c. Write `runs/<profile>/rovo/<module slug>.json` as
      `{"stories": [{"key": "AVLN-1", "summary": "<title>", "query": "<query>"}], "docs": [{"title": "<title>", "url": "<url>"}]}`.
   d. If the Rovo tool is missing or fails (for example no credits), say so in one line and go on without it.
1. **Keywords and module** (0 tokens). Do this when the module is NOT configured in modules.json, or when the
   arguments contain `--rediscover`. Run
   `node scripts/vocab.mjs --words "<module words>" [--rovo runs/<profile>/rovo/<slug>.json]`.
   It ranks candidate keywords by where they are found (code declaring/mentioning files, Jira stories, Zephyr
   cases), flags generic ones, bridges to the code's own vocabulary (e.g. "export job"), and proposes a
   modules.json entry: path (or `crossCutting` + `codePaths`), keywords and `zephyrFolder`.
   Show the user the ranked table and the proposal, then ask with AskUserQuestion: save as proposed (under
   which module name), save with changes (they give the keywords to add or drop), or don't save and stop.
   Save with `node scripts/vocab.mjs --words "<module words>" [--rovo …] --save "<name>"`, then apply the
   user's changes to the saved entry only if they asked for changes (edit `profiles/<profile>/modules.json`).
   Never save without the user's answer.
2. Run `node scripts/agents.mjs --module "<module name>"` (the saved name, or the module words; leave out
   `--module` only when the arguments named no module), plus `--extra-stories runs/<profile>/rovo/<slug>.json`
   when step 0 found stories, and any `--keywords`, `--limit`, `--from` or `--skip` options from the arguments.
   Use a 60-minute timeout.
   The pipeline (config/config.yaml) is: module-scout → requirements-analyst + code-analyst + ui-explorer +
   zephyr-explorer (in parallel) → context-builder → test-designer → coverage-validator → reporter. Pass `--env` when
   the arguments name an environment. If the run says the UI explorer could not start (no saved login), tell the
   user to run `npm run ui-login` and that the rest of the run went on without the UI.
   It derives expected scenarios from the stories (UC docs, acceptance criteria) and from the frontend and
   backend code, matches them with the existing Zephyr cases (the linked ones, the module's Zephyr folder and
   cases named by its keywords), and drafts the missing test cases.
3. If it stops with `blocked`, show the question and the candidates and ask which one the user means.
4. Otherwise read `runs/<profile>/latest-summary.md` and show the executive summary, the results table, the
   suspected bugs and the "Tokens used" table. Say how many Rovo candidates there were and how many the
   scout kept (from its findings), and list the Rovo Confluence docs (title + link) as further reading.
   Give the workbook path.
5. Do not create anything in Zephyr and do not change Jira. Point the user to the 6_Gaps review and the
   `--create-approved` dry run.
