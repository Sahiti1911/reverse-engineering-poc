# New profile

1. Copy this folder to `profiles/<name>/` (lowercase, dashes).
2. Fill `profile.json` — field meanings are in `schema/profile.schema.json`. Key decisions:
   - `jira.acSources`: add `uc-doc` only if stories carry structured `UC-NN` QA scenario docs.
   - `jira.nonTestable`: summary regex / epics / labels that are never feature work (saves LLM triage tokens).
   - `code.featurePathPattern`: regex over story text whose group 1 is the module folder under `frontendRoot`.
     Leave empty if stories never name their code path; modules then fall back to `modules.*.summaryPattern`, then epic.
   - `code.provider: "none"` skips code analysis entirely.
   - `zephyr.folderRoot`: only cases under this folder path are compared.
3. Write `conventions.md`: naming, labels, priority, folder and step rules for new test cases. It is given verbatim
   to the draft stage, so keep it short and concrete.
4. Check: `node scripts/run.mjs --profile <name> --scope issues:<KEY> --dry-run` validates the profile and prints
   the resolved scope without calling Claude.
5. Optional but recommended: `modules.json` — the names you use for modules, their code path, Jira keywords,
   Zephyr folder and stories to always include/exclude (schema: `schema/modules.schema.json`). Then
   `node scripts/agents.mjs --profile <name> --module "<your name>"` uses it instead of guessing.
6. To make the profile the default (no `--profile` needed), set `defaultProfile` in `config/run.json`.
