# Factory rules

Every factory agent reads two files before it does anything, completely: this one, which is the same in every repository, and `factory/house-rules.md`, which describes the repository it works in (facts, test and lint commands, conventions, restrictions, review focus). Together they are **the house rules**. Where the two disagree, the repository's file wins for anything about the repository; this file wins for anything about the factory's process and safety.

## Where the work happens (worktree boundaries)

Every run builds in its own Git worktree, `factory/worktrees/<run-id>/`, on a local branch `factory/<run-id>` that starts at the human's current commit. The orchestrator gives every agent the run directory, the worktree's absolute path, the start commit and the paths of both rule files.

- Read, edit and run everything **inside the worktree**; start every shell command with `cd <worktree> &&`. Never edit the main checkout (the repository root outside `factory/worktrees/`). It holds the human's uncommitted work, which the worktree does not contain.
- Dependency directories listed in `factory/config.json` → `worktree.links` (default `node_modules`) are symlinks to the main checkout's. Never install packages.
- `git diff <start>..HEAD` shows the whole build, `git diff HEAD~1..HEAD` the latest round. Read new files whole.
- Factory documents go in the run directory, `factory/runs/<run-id>/`, never in the worktree.

## Agent responsibilities

| Role | Agent | Model | Writes |
|---|---|---|---|
| Orchestrator | the session running `/factory` | its own | `factory/board.json` (through `fac.mjs` only), `escalation.md`, `merge.md`, patches |
| Spec writer | `factory:spec-writer` | Opus | `spec.md`, `plan.md` |
| Builder | `factory:builder` | Opus | application code in the worktree, `build.md` |
| Security | `factory:security` | Opus | `reviews/pass-<N>/security.md` |
| UX | `factory:ux` | Sonnet | `reviews/pass-<N>/ux.md` |
| UI design | `factory:ui-design` | Sonnet | `reviews/pass-<N>/ui-design.md` |
| Code | `factory:code` | Sonnet | `reviews/pass-<N>/code.md` |
| Approver | `factory:approver` | Opus | `approval.md` |

Each agent writes only its own files. A deliverable exists only as a file at its path: the orchestrator decides from files, never from replies.

## Skills and helper agents

Each agent file preloads its skills (`skills:` in the frontmatter): their full text is in the agent's context from the start.

| Role | Preloaded skills | Helper agents it may spawn |
|---|---|---|
| Orchestrator | loads `superpowers:dispatching-parallel-agents`, `superpowers:requesting-code-review` before the first review pass, and `superpowers:diagnosing-superpowers` when the human asks why a run went wrong | the seven factory agents |
| Spec writer | `superpowers:brainstorming`, `superpowers:writing-plans`, `andrej-karpathy-skills:karpathy-guidelines`, `understand-anything:understand-explain` | `feature-dev:code-explorer`, `feature-dev:code-architect` |
| Builder | `superpowers:executing-plans`, `superpowers:test-driven-development`, `superpowers:systematic-debugging`, `superpowers:verification-before-completion`, `superpowers:receiving-code-review`, `andrej-karpathy-skills:karpathy-guidelines`, `frontend-design:frontend-design`, `simplify` | none |
| Security | `superpowers:verification-before-completion` (its review method is written into the agent) | none |
| UX | none | none |
| UI design | `frontend-design:frontend-design` | none |
| Code | `code-review`, `superpowers:verification-before-completion`, `andrej-karpathy-skills:karpathy-guidelines`, `understand-anything:understand-diff` | `feature-dev:code-reviewer` |
| Approver | `superpowers:verification-before-completion`, `understand-anything:understand-diff` | none |

Rules for every skill:

- **Precedence.** The house rules, then the agent file, then the orchestrator's prompt, then the skill. A skill is method, never permission. Where a skill says to ask or wait for the human, offer them a choice, commit, push, create a branch or worktree, start a server, write under `docs/`, or report with a tool you do not have: don't. Decide, record the decision in your own file, and carry on.
- **The change is the worktree diff.** What you build or review is `git diff <start>..HEAD` (the builder: the uncommitted changes) inside the worktree. A skill that runs `git diff` or `git status` in the current directory, or embeds such output in its text, is looking at the human's checkout: ignore that output.
- **Helper agents** (`feature-dev:*`) are read-only and have no shell. Give them absolute paths inside the worktree or the run directory. Their replies are input to check, never findings to copy. They spawn nothing and write nothing.
- **Knowledge graph.** The `understand-anything` skills read `<repo root>/.understand-anything/knowledge-graph.json`, where the repo root is the worktree path without `factory/worktrees/<run-id>`. The human builds it with `/understand`; it describes the commit it was built from. If it is missing, skip those skills without comment. Never run `/understand` and never write the graph.
- **Not loaded, on purpose.** `superpowers:subagent-driven-development` (the factory loop is that pattern), `superpowers:using-git-worktrees` (`fac.mjs start` makes the worktree), `superpowers:finishing-a-development-branch` (`fac.mjs merge-back`; the human commits), `superpowers:writing-skills` (not feature work), `superpowers:using-superpowers` (preloading replaces it), `security-review` (it runs `git diff origin/HEAD...` as it loads, which reviews the human's branch and fails without that remote; the security agent carries its own method) and `claude-code-setup` (installed for the human, no stage in a run).
- **Required plugins.** The plugin's `config.json` → `plugins.required` lists every plugin above. `fac.mjs plugins` checks them, and every skill the agents name, at the start of each run; Claude Code silently skips a preloaded skill it cannot find.

## Prohibited Git operations

**Agents run no Git write command at all**, in the worktree or anywhere else: no `commit`, `add`, `rm`, `mv`, `restore`, `reset`, `stash`, `checkout`, `switch`, `branch`, `tag`, `merge`, `rebase`, `cherry-pick`, `apply`, `worktree` or `push`. Move or delete files with plain `mv` / `rm`. Read-only Git (`diff`, `log`, `show`, `status`, `ls-files`, `blame`) is fine.

Only the orchestrator writes to Git, through `fac.mjs`: it creates the worktree and branch, commits each round on the factory branch, and applies the approved diff to the human's branch as unstaged changes. Nothing is ever pushed, and nothing is ever committed on the human's branch. The orchestrator never uses `git apply --index`, `--cached` or `--3way`, or `git merge --squash`.

## Restrictions in every repository

- **No servers, builds or containers** unless `factory/house-rules.md` names one as safe: a second dev server or build can break the human's.
- **No dependencies.** Never install a package or change a lock file.
- **Never write** `factory/board.json`, `factory/usage.json`, `.gitignore` or `.git/`.
- **Shell.** If the Bash tool runs zsh: quote globs (`--include='*.js'`), write `${var}:path` not `$var:path`, quote strings like `"===="`, and run loops over lists inside `bash -c '…'`.

## Document locations and artifact naming

All in `factory/runs/<run-id>/`:

| File | By | Notes |
|---|---|---|
| `request.md` | orchestrator | the request, verbatim |
| `spec.md`, `plan.md` | spec writer | |
| `build.md` | builder | one file; revisions append `## Revision <N>` |
| `reviews/pass-<N>/<area>.md` | reviewers | area = `security`, `ux`, `ui-design`, `code`; one directory per pass, never overwritten |
| `approval.md` | approver | |
| `escalation.md` | orchestrator | only when escalated |
| `merge.md`, `changes.patch` | orchestrator | only after merge-back |
| `artifacts/round-<n>.patch` | orchestrator | the diff of each committed round |
| `artifacts/final/<path>` | orchestrator | final versions of changed files, kept at merge-back |
| `run.json` | orchestrator | archived copy of the board |

Round 0 is the initial build, rounds 1 and 2 the automatic revisions, later rounds human revisions. Pass N reviews the round committed just before it.

## Review report format

Line 1 and line 2 are fixed; the orchestrator reads the result from line 2:

```markdown
Review: <security | ux | ui-design | code>
Result: PASS | CHANGES

## Findings
1. **[blocker]** `path/to/file.js:42` — what is wrong. **Fix:** what to do.
2. **[should-fix]** `path/to/other.js:7` — explanation. **Fix:** suggestion.

## Optional
- Minor suggestions. These never cause CHANGES.

## Checked
- What you read and ran, with results, so a PASS means something.
```

- `Result: CHANGES` only when there is at least one `blocker` or `should-fix` finding. Number every finding; give its severity, file and line, the explanation and the suggested fix.
- A review with nothing applicable is `PASS` and says under Checked what was checked.
- A missing or malformed report counts as `CHANGES`.

### Review focus by area (every repository)

`factory/house-rules.md` adds what is specific to the repository.

- **security:** routes or handlers that skip the repository's auth helpers or trust a client-sent user or tenant id; data access not scoped to the caller; privileged paths open to others; access policies missing or too broad; secrets or tokens in code, logs or client bundles; PII in logs; unvalidated input reaching SQL, filters, URLs, the shell or raw HTML; SSRF; unchecked webhook signatures; missing rate or size limits.
- **ux:** the feature can be reached and finished; no dead ends; loading, empty, error and success states; messages that say what happened and what to do; labels on inputs and icon buttons; keyboard reach and focus order; focus in dialogs; colour not the only signal; live regions for updating content; double submits; destructive actions without confirmation; input lost on error.
- **ui-design:** the repository's UI kit and icons used instead of copies; spacing, type scale, colours and radii match nearby screens; alignment and hierarchy; long text and lists; truncation that hides content; phone width with no horizontal scroll; hover, focus, disabled and loading states; contrast.
- **code:** requirements and acceptance criteria actually met; edge cases, error paths, async races; ignored errors from data calls; a test per criterion that would fail without the change; re-run results match `build.md`; conventions and reuse of existing helpers; edits to protected paths and Git writes are blockers; dead code, N+1 queries, unbounded loops, subscriptions or intervals never cleaned up.

## Model assignments

Opus: spec writer, builder, security, approver. Sonnet: UX, UI design, code. The model is set in each agent file's frontmatter (`model: opus` / `model: sonnet`) and checked by the plugin's tests against its `config.json`. The dashboard shows the configured model next to the model actually observed in the session records; it never assumes one from the other. An environment default such as `CLAUDE_CODE_SUBAGENT_MODEL` may differ; the token monitor shows what was actually used.

## Token attribution

The token monitor (`lib/usage.mjs`) reads Claude Code's local session records for this repository, read-only, from every profile that has them (`~/.claude/projects/<repo path as a slug>/`, and `~/.claude-<name>/…` for other profiles), unless `factory/config.json` → `usage.sources` lists them explicitly:

- `<session>.jsonl`: the main thread, i.e. the orchestrator.
- `<session>/subagents/agent-<agentId>.jsonl`: one file per subagent.

A subagent's usage belongs to the role whose recorded session has that `agentId` (`fac.mjs agent-start <role> --agent-id <id>`). Helper agents spawned by the spec writer or the code reviewer have ids the board never records, so their usage is listed as unattributed. A resumed agent keeps its id; its messages go to the session (and round) that was current when they were sent. A restarted agent gets a new id and a new session under the same role. Main-thread messages of the orchestrator's session between the run's start and end are the orchestrator's, except while the run waits for the human (from an escalation until work resumes), when that session may be doing other things. Everything else is listed separately as unattributed. Each API message counts once (deduplicated by message id and request id, largest snapshot kept). Only ids, model, timestamps and the four token counters are stored; never prompt or message text. A local 5-hour window is not the plan's quota; no quota is shown because no supported source reports it.

## Security restrictions

- Never put a secret, token, key, password or connection string in a report, a log line or a commit. Name the file and line instead.
- Never read `.env*` files' values into a report. Never access undocumented authentication endpoints or credentials.
- Never execute generated content, and never fetch from the network to complete a review.
- The dashboard is local, read-only and development-only: it binds to 127.0.0.1, serves registered artifacts by id only, and refuses traversal, symlinks, secret files and oversized files.

## Approval workflow

1. All four reviews of a pass PASS → the approver runs.
2. Any CHANGES → the builder is resumed with the reports (at most **2 automatic revision rounds**); all four reviewers run again on the new round.
3. Still CHANGES after revision 2 → escalation to the human.
4. The approver writes `Decision: APPROVE` (→ merge-back) or `Decision: ESCALATE` (→ the board shows WAITING_FOR_HUMAN; the human runs `/factory approve [note]` or asks for changes, which become human revisions that do not count against the limit).

## Merge-back rules

Before anything is applied, `fac.mjs merge-back` checks: the human is on the starting branch; HEAD has not moved; the worktree is clean; the factory exclusions pass; the patch has no factory, dependency or secret-bearing paths and no credential-looking lines; no merge, rebase or cherry-pick is in progress; and `git apply --check` passes against the human's working tree. Then it runs `git apply` (working tree only), confirms the index and HEAD are unchanged, keeps final snapshots of the changed files, removes the worktree, keeps the branch, and writes `merge.md`. Any failed check stops it before anything changes.
