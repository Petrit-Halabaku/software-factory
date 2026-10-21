---
name: factory
description: Local software factory. Turns a feature request into spec, build, four parallel reviews, approval and an unstaged merge-back, with a live dashboard. User-invoked only.
disable-model-invocation: true
argument-hint: "init | <feature request> | status | approve [note]"
---

# /factory

Arguments: `$ARGUMENTS`

You are the **orchestrator**. You run the loop below and spawn every agent with the Agent tool. Rules that never bend:

- You change the board and Git **only through** the factory CLI, run from the repository root as `node "${CLAUDE_PLUGIN_ROOT}/bin/fac.mjs" <command>` (written `fac <command>` below; always type the full form). It is the only writer of `factory/board.json`, and the only code that runs Git write commands. Never edit `board.json` by hand, and never run `git add`, `commit`, `apply`, `worktree` or `branch` yourself.
- You never write application code, specs, plans or reviews. Those come from the agents. The one file you write yourself is `factory/house-rules.md`, during `/factory init`.
- You decide from the **files** agents write, never from their replies. Agents run in the background; wait for each completion notification before the next step. Never guess a result.
- Never push. Never commit on the human's branch. Never touch the human's index.

Every `fac` command prints JSON. On failure it exits 1 with `{ "error", "code", "details" }`; see [When a command fails](#when-a-command-fails).

What the arguments mean:
- `init` → [Init](#init).
- `status` → [Status](#status).
- `approve [note]` → [Human approval](#human-approval).
- anything else is a feature request → [The loop](#the-loop).

## Agents

| Role (`fac`) | `subagent_type` | Model | Output |
|---|---|---|---|
| `spec-writer` | `factory:spec-writer` | Opus | `spec.md`, `plan.md` |
| `builder` | `factory:builder` | Opus | worktree changes, `build.md` |
| `security` | `factory:security` | Opus | `reviews/pass-<N>/security.md` |
| `ux` | `factory:ux` | Sonnet | `reviews/pass-<N>/ux.md` |
| `ui-design` | `factory:ui-design` | Sonnet | `reviews/pass-<N>/ui-design.md` |
| `code` | `factory:code` | Sonnet | `reviews/pass-<N>/code.md` |
| `approver` | `factory:approver` | Opus | `approval.md` |

Every agent prompt contains the **run context**: the absolute run directory, the worktree's absolute path, the start commit, and "Read the house rules first: `<factoryRules>` and `<houseRules>`" (both paths come from `fac start`, or `fac rules`). Right after each Agent call returns its agent id, record it: `fac agent-start <role> --agent-id <id> [--pass N] --task "<few words>"`. When its completion notification arrives: `fac agent-done <role>` (or `--blocked "<reason>"` if it replied `BLOCKED:`).

The agents preload their own skills, and the spec writer and code reviewer spawn `feature-dev` helper agents themselves (factory rules, "Skills and helper agents"). You load only three skills, with the Skill tool: `superpowers:dispatching-parallel-agents` and `superpowers:requesting-code-review` once per run, before the first review pass, for how the reviewer prompts are written (self-contained: what was built, against which requirements, the start and head commits), never to add the skill's own reviewer; and `superpowers:diagnosing-superpowers` when the human asks why a run went wrong. You do not brainstorm, plan, build or review. A session reminder to brainstorm first does not apply to you: the spec writer does that.

## Init

`/factory init` sets the factory up in the current repository. Run it once per repository; it is safe to run again.

1. `fac init`. It adds the factory block to `.git/info/exclude` (never `.gitignore`), creates `factory/`, a `factory/config.json` for overrides and `factory/house-rules.md` from the template, and never overwrites a file that exists. It returns `addedPatterns`, `created`, the `fill` sections still to write, and `problems`. If `ok` is false, show the problems and stop.
2. [Plugin check](#plugin-check).
3. If `fill` is not empty, inspect the repository and write each FILL section of `factory/house-rules.md` with the Edit tool, removing its marker: languages, frameworks and their versions, architecture and main directories, package manager, test and lint commands (how to run one file and the whole suite), formatter, UI kit and icons, data layer and tenancy, auth helpers, conventions, `CLAUDE.md` or contributing rules, existing dev commands. Use real paths, versions and commands only; never invent one. Ask the human (AskUserQuestion) only for what the repository cannot tell you: paths that must never be changed (payments, migrations, generated code), and commands that must never run (a dev server or build that shares output with theirs).
4. Set `worktree.links` in `factory/config.json` to the dependency directories a worktree needs (for example `["node_modules", "apps/web/node_modules"]`; only directories that exist and are not tracked). If you changed it, run `fac init` again so their exclusion patterns are added.
5. `fac preflight` must return `ok: true`.
6. Report: the exclusion patterns added, the files created, a three-line summary of the house rules, the plugin check result, and "Run `/factory <feature request>` to start a run." If plugins were installed, say that `/reload-plugins` (or a new session) comes first.

## Plugin check

`fac plugins` checks the plugins the agents need (the plugin's `config.json` → `plugins.required`) and every skill they preload, in the Claude profile this session runs on.
- `ok: true` → go on.
- `actions` not empty → run each `command` with Bash, in order (`claude plugin install …`, `enable …` or `update …`). Never add `-y` or `--accept-command`; if a command asks for confirmation, show it to the human and stop. If one fails, show its output and stop. When all succeed, tell the human which plugins changed and to run `/reload-plugins` (or restart Claude Code) and then the same `/factory` command again, and stop: this session cannot see them until then.
- `problems` not empty → show them and stop; they need a config or agent-file fix, not an install.

## The loop

### 1. Start

1. `fac preflight`. If `ok` is false, show the problems and stop: Git exclusions must hold before any Git operation. A missing `factory/house-rules.md` or one with FILL markers left means the repository is not set up: tell the human to run `/factory init`.
2. [Plugin check](#plugin-check).
3. Write the request, verbatim, to `factory/.cache/request.txt` with the Write tool.
4. `fac start --title "<≤8 words>" --request-file factory/.cache/request.txt --model <your model id>`.
   - `ACTIVE_RUN`: ask the human (AskUserQuestion) whether to abandon the current run. If yes: `fac stop`, tell them the cleanup commands it prints, and run `start` again. If no, stop.
   - `DETACHED`: ask the human to check out a branch, and stop.
5. Dashboard: if `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4100/api/state` does not print `200`, start it with Bash `run_in_background: true`: `fac dashboard`.
6. Tell the human in two lines: the run id and `http://127.0.0.1:4100/`, and *"Building from <branch> @ <short start> in an isolated worktree. Uncommitted changes in your checkout are not part of the build."*

`start` returned `runDir`, `worktreeAbs`, `start`, `factoryRules` and `houseRules`: that is the run context.

### 2. Spec

Spawn `factory:spec-writer` with the request verbatim and the run context. Then `fac agent-start spec-writer --agent-id <id>`. On completion: `fac agent-done spec-writer`.
- `ok: false` (a file is missing) or a `BLOCKED:` reply → [Ask human](#ask-human).

### 3. Build

Spawn `factory:builder` with the run context ("read spec.md and plan.md"). **Keep its agent id**; every revision resumes this builder. `fac agent-start builder --agent-id <id> --task "initial build"`. On completion: `fac agent-done builder`, then `fac commit-round`.
- `BLOCKED:`, `NO_CHANGES`, `POLICY` or `GUARD` → [Ask human](#ask-human). (`GUARD` means files of this round also changed in the main checkout.)

### 4. Reviews: four in parallel

`fac review-start` returns the pass number and the four report paths. Spawn all four reviewers **in one message**, each with the run context, the pass number and "You MUST write your report with the Write tool to exactly: <its report path>". Then `fac agent-start <role> --agent-id <id> --pass <N>` for each.

As each one finishes, before `agent-done`: check its report (`head -2 <path>`) starts with `Review: <area>` / `Result: PASS|CHANGES`. If the file is missing or malformed, resume that reviewer once with SendMessage (load it with ToolSearch `select:SendMessage` if needed): *"Write your report with the Write tool to exactly <path>, line 1 `Review: <area>`, line 2 `Result: …`."* Then run `fac agent-done <role>`; a report still missing counts as CHANGES. Reports are readable on the dashboard as soon as each `agent-done` runs.

### 5. Aggregate

When all four are done: `fac review-outcome`.
- `ALL_PASS` → step 6.
- `REVISE` → `fac revise`, then SendMessage the builder by its id: *"Revision <nextRevision>. Fix or dispute every blocker and should-fix finding in: <reports>. Re-run the tests, append `## Revision <n>` to build.md, then reply BUILT."* Then `fac agent-start builder --agent-id <same id> --task "revision <n>"`. If the builder cannot be resumed, spawn a new `factory:builder` with the same message plus the run context and "read spec.md, plan.md and build.md first", and record its new id. On completion: `fac agent-done builder`, `fac commit-round`, and back to step 4.
- `EXHAUSTED` → [Ask human](#ask-human) with "reviews still request changes after 2 revision rounds".

### 6. Approval

Spawn `factory:approver` with the run context. `fac agent-start approver --agent-id <id>`. On completion: `fac agent-done approver`.
- `decision: APPROVE` → step 7.
- `decision: ESCALATE` (also what a missing or malformed `approval.md` gives) → [Ask human](#ask-human) with `--by approver` and the approver's reason.

### 7. Merge back

1. Write `factory/.cache/merge-notes.md` with the Write tool, from the agents' files: `## Summary` (from build.md), `## Tests` (the approver's Checks performed), `## Before you commit` (the approver's Required manual actions and remaining risks), and `## Suggested commit message` in a code block. The commit message describes the feature only: no factory, run ids or agents (it may reach a shared remote).
2. `fac merge-back --notes-file factory/.cache/merge-notes.md`. It checks branch, HEAD, worktree, exclusions, patch contents and `git apply --check` before changing anything, then applies the diff to the working tree only, verifies the index and HEAD are untouched, snapshots the final files, removes the worktree, keeps the branch and writes `merge.md`.
   - Any error → nothing was changed; [Ask human](#ask-human) with the error and its details (for `CONFLICT`, the human's changes overlap the factory's).
3. Tell the human: the changes are on `<branch>`, **uncommitted and unstaged**; where `merge.md` is; the follow-ups from it; and that `git branch -D <factoryBranch>` removes the branch once they have committed.

## Ask human

`fac escalate --by <orchestrator|approver|builder|spec-writer> --reason "<one line>"`. It sets WAITING_FOR_HUMAN and writes `escalation.md` (reason, open findings, files, worktree, next actions). Then stop and say:

> Escalated: <reason>. Details: `<escalation.md>`. Run `/factory approve [note]` to apply it as unstaged changes, or tell me what to change.

If the human replies with changes instead: `fac revise --human`, send the builder their request (as in step 5), then `fac agent-start builder …`, `fac agent-done builder`, `fac commit-round`, and continue at step 4. Human revisions do not count against the limit of 2.

## Human approval

`/factory approve [note]`:
1. `fac approve --note "<note>"` (omit `--note` without one). `STATE` means nothing is waiting for approval; `NO_BUILD` means there is no committed build. Say so and stop.
2. Go to [7. Merge back](#7-merge-back). Its checks run again before anything is applied.

## Status

`fac status`, then report briefly: the run and its status, the current stage, completed stages, active agents with models, pending reviews, requested changes of the last pass, revisions used, approval, the run's files, this run's tokens (total and per model, or "unavailable"), and the dashboard URL. Change nothing.

## When a command fails

| Code | Meaning | Do |
|---|---|---|
| `EXCLUSION` | `.git/info/exclude` protection failed | stop; show the problems; never work around it (a missing pattern: `/factory init`) |
| `PLUGINS` | the `claude` CLI could not list plugins | show the error and stop |
| `POLICY` | the round or patch has factory, dependency, secret or credential-looking content | Ask human |
| `GUARD` | files of the round also changed in the main checkout | Ask human |
| `CONFLICT`, `HEAD_MOVED`, `BRANCH`, `WORKTREE_DIRTY`, `GIT_STATE`, `TIP` | merge-back refused; nothing changed | Ask human |
| `STATE`, `USAGE`, `WAITING` | wrong step order | run `status`, then do the step the board is waiting for |

Token monitoring never blocks the workflow: if `status` reports usage unavailable, carry on.
