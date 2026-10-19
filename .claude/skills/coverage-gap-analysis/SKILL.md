---
name: coverage-gap-analysis
description: Use when asked to find missing test cases / test coverage gaps for a module, Jira stories, an epic, a sprint or a whole project against Zephyr Scale, to run or explain the coverage agents or workbook, to add a project profile, or to create approved gap test cases in Zephyr.
---

# Coverage gap analysis

## Which entry point
- **A module or feature in plain words** ("import job", "conductor", "grid data export"): use the agent chain.
  `node scripts/agents.mjs --profile avl --module "<words>"`, or the `/coverage <words>` command.
  A feature without a folder of its own works too: the code stage sweeps every code root for the module's
  keywords (preview with `node scripts/code-map.mjs --module "<words>" --keywords "a,b"`, 0 tokens).
  `/coverage` first runs a Rovo search in the interactive session (headless agents can't) and passes the
  candidate stories in with `--extra-stories <file>`. The scout confirms or drops them.
- **A Jira scope** (issue keys, epic, sprint, project, JQL): use the plain pipeline.
  `node scripts/run.mjs --profile avl --scope <scope>`.
- **A project with no profile**: follow `profiles/_template/README.md` first.

## Agent chain
module-scout → requirements-analyst → code-analyst → coverage-matcher → test-designer → reporter.
Each agent runs its own stage, may write `review/<key>.json`, and forwards its findings
(`handoff/NN-<agent>.json`) to the next agent. When the scout stops with `blocked`, show its question and
the candidate modules, then re-run with the exact module the user picks. To resume, use `--from <agent>`.
To save tokens, use `--skip <agent>`.

## Reporting results
Read `runs/<profile>/latest-summary.md`. Report:
- the executive summary
- the results table (coverage, gaps)
- suspected bugs and requirement flags
- the **Tokens used** table

Give the workbook path. Report tokens only, never money.

## Reading the workbook
- `6_Gaps` is the review list.
- `Unverified` means a case probably covers the scenario, but with Low confidence.
- `Code-only` and `needs PO confirmation` scenarios describe current behaviour; confirm the behaviour is
  intended before approving.
- `decidedBy: agent:<name>` and `Agent review` columns show what the agents changed and why.

## Creating cases
Never run `--create-approved ... --yes` unless the user confirmed it for this workbook in this
conversation. Run it without `--yes` first and show the dry-run output. Zephyr has no delete endpoint.
