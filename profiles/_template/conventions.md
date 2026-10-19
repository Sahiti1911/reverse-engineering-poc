# <Project> test case conventions

Replace every section below with your project rules.


## Folder
- AVL cases live under `Ridango > AVL`. Use **Structure 1** (feature-based tree: `Schedule & Masterdata > …`,
  `Masterdata Import & Export > …`, `Trip Operations & Dispatch > …`). Do **not** use Structure 2 (page-based).
- Keep all cases of one feature in the same folder as the feature's existing cases.

## Name
`AVL - <Area> - <Feature> - <plain scenario description>` — e.g. `AVL - Admin - Import Job - Cancel the upload dialog`.
No "main success scenario" suffix; just describe the scenario.

## Labels
Area label (`AVL_Admin`) + one feature label (`AVL_ImportJob`, `AVL_User`, …). Permission cases add `AVL_Permissions`.

## Priority
High for the main success scenario of a use case; Medium for alternative, exception and validation cases.

## Status / custom fields
Status Draft. Automation Status "Not Automated". BDD Script: short Gherkin summary
(`Feature / Scenario / Given / When / Then`), not a transcript of every step.

## Steps
2–6 concrete, click-by-click UI actions, each with a specific, checkable expected result. Fold the use case's
postcondition into the final step's expected result. When the source does not give an exact string (toast text,
label), say so ("an error toast is shown — exact wording not specified") instead of inventing one.

## What not to create
- "Functional parity with legacy" and "WCAG 2.1 AA compliance" UCs stay manual audits — no atomic cases.
- A "Permission denial" UC that walks through one functionality ID per bullet is ONE case with one step per ID.
