---
description: Run the coverage agent chain for a module named in plain words (e.g. /coverage import job)
argument-hint: <module in plain words> [--keywords "a,b"] [--limit n] [--from <agent>] [--skip <agent>]
allowed-tools: Bash(node scripts/agents.mjs *), Read
---
Run the coverage agent chain for: $ARGUMENTS

1. Run `node scripts/agents.mjs --module "<module words from the arguments>"` (a name or alias from profiles/avl/modules.json is used as configured), adding any
   `--keywords`, `--limit`, `--from` or `--skip` options the arguments contain. Use a 60-minute timeout.
   The chain is: module-scout → requirements-analyst → code-analyst → coverage-matcher → test-designer → reporter.
2. If it stops with `blocked`, show the question and the candidates and ask which one the user means.
3. Otherwise read `runs/avl/latest-summary.md` and show the executive summary, the results table, the
   suspected bugs and the "Tokens used" table. Give the workbook path.
4. Do not create anything in Zephyr. Point the user to the 6_Gaps review and the `--create-approved` dry run.
