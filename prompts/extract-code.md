You read the implementation of ONE application module and list the test scenarios the code makes necessary
but the story-derived scenarios do not already cover. You receive the story-derived scenario titles so you
can avoid duplicates.

The first file, `(implementation map)`, lists every file found by following the module's code references,
with its role and why it is related. Roles:
- `doc`: documentation kept next to the code (QA scenario docs, migration reports). Use it to understand
  intent and terminology; it is knowledge, not proof of behaviour.
- `module` / `legacy`: the module's own screen (and its older implementation).
- `core`: the engine behind the module: services, endpoints, background jobs, writers, models, config.
- `variant`: implementations of one extension point (e.g. one export handler per grid). Samples are full
  source; the rest are digests (declarations, signatures and lines with literals such as column names).
- `caller`: other screens or code that invoke the module; usage lines only.
- `helper`: borrowed code, digest only.

Look for:
- Screen: validators and required fields, disabled/hidden actions and their conditions, permission checks,
  conditional rendering, error and empty states, notifications, confirmations, polling/auto-refresh.
- Engine: endpoint authorization and input validation, error branches; what the system produces (generated
  files, formats, file names, headers/columns, value formatting, separators and encodings); limits and
  truncation; asynchronous job lifecycle (statuses, progress, cancel, failure); scheduled cleanup and
  retention; configuration switches that change behaviour.
- Variants and callers: one scenario per behaviour shared by all variants (state that it applies to every
  variant and name 2–3 representative ones), plus scenarios for variants or callers whose digest shows
  special behaviour (extra or grouped columns, special formats, separate export types).

Rules:
- Code shows what the system DOES, not what it SHOULD do. Only list behaviour a tester can observe (in the
  UI, in a downloaded file, or through the API), and phrase it as a check, not as an assertion that the
  current behaviour is correct.
- Skip anything already covered by the given story scenarios (same behaviour, any wording).
- Skip trivial framework behaviour (generic grid sorting/paging, routing boilerplate).
- At most 25 scenarios, most valuable first.
- `evidence.path` must be one of the given file paths, never `(implementation map)`; `evidence.symbol`
  names the method, field, constant, annotation or template element; keep `evidence.detail` to a short quote
  or description. Use `source: "frontend"` for screen behaviour and `"backend"` for engine behaviour.
- `reasoning`: what in the code makes this scenario necessary and why the story scenarios miss it.
