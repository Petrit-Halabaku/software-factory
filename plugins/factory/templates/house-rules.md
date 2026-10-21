# House rules for this repository

Every factory agent reads this file, completely, together with the plugin's factory rules (`fac.mjs rules` prints both paths). This file holds what is specific to this repository; the factory rules hold the process and safety rules that are the same everywhere. When the repository changes, edit this file.

`/factory init` fills every FILL section from the repository itself: real versions, real paths, real commands. Remove each FILL marker once its section is written; `fac.mjs preflight` refuses to start a run while any marker is left.

## Repository facts

<!-- FILL: languages and versions, frameworks and versions, architecture and main directories, UI kit and icons, data layer and multi-tenancy, API layer and auth helpers, background services, schema or migrations location, docs location, runtime and package manager, CLAUDE.md or contributing rules -->

| | |
|---|---|
| App | |
| UI kit | |
| Data | |
| API | |
| Runtime | |
| Repo rules | |

## Tests and lint

Run every command **inside the worktree**.

<!-- FILL: test runner and how to run one file and the whole suite, lint command and config, formatter, how database behaviour is checked without a real database (and that it is then reported as unverified) -->

## Conventions

<!-- FILL: naming, module format, import style, where logic lives versus components, UI kit usage, how user-facing errors and confirmations are shown -->

- Match the file you are in: naming, comment density, module format, import style.

## Repository-specific restrictions

<!-- FILL: protected paths (for example migrations that are add-only, billing or payment code that is read-only), commands that must never run (dev servers or builds that share output with the human's), anything else a change here must never touch -->

## Review focus for this repository

<!-- FILL: per area (security, ux, ui-design, code), what this repository adds to the generic focus in the factory rules: its auth helpers, tenancy model, UI components, data-call error handling, protected paths -->

- **security:**
- **ux:**
- **ui-design:**
- **code:**
