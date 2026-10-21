// Run lifecycle: every state change the orchestrator makes goes through one
// of these functions (called by factory/bin/fac.mjs). Each takes a context
// { repoDir, factoryDir, config } so tests can drive it against a scratch
// repository.

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { factoryPaths, reviewRoles } from './config.mjs';
import { emptyBoard, logEvent, parseApproval, parseReviewReport, readBoard, setStage, updateBoard } from './board.mjs';
import { expectRunFile, markFailed, registerRound, runFileId, syncRunFiles } from './artifacts.mjs';
import { checkExclusions, ensureExclusions } from './exclude.mjs';
import { nowIso, readJson, writeFileAtomic, writeJsonAtomic } from './fsutil.mjs';
import {
  FactoryError, currentBranch, diffFiles, git, gitOut, hashFiles, headCommit, indexFingerprint,
  isSecretPath, pendingOperations, policyViolations, refExists, secretLines, showBlob, stagedFiles, statusMap,
} from './git.mjs';

const ACTIVE = ['RUNNING', 'WAITING_FOR_HUMAN', 'APPROVED'];

const runDir = (ctx, board) => path.join(factoryPaths(ctx.factoryDir).runs, board.runId);
const worktreeAbs = (ctx, board) => path.resolve(ctx.repoDir, board.worktree);

function requireStatus(board, allowed, what) {
  if (!allowed.includes(board.status)) throw new FactoryError('STATE', `${what} needs status ${allowed.join(' or ')}, the board says ${board.status}`);
}

function sync(ctx, board) {
  if (board.runId) syncRunFiles(board, runDir(ctx, board), ctx.config);
}

export function preflight(ctx, { worktree } = {}) {
  const links = ctx.config.worktree.links;
  const main = checkExclusions(ctx.repoDir, { links });
  const problems = [...main.problems];
  if (worktree && existsSync(worktree)) problems.push(...checkExclusions(worktree, { links }).problems.map((p) => `worktree: ${p}`));
  const rules = factoryPaths(ctx.factoryDir).houseRules;
  if (!existsSync(rules)) problems.push(`${rules} is missing; run /factory init`);
  else if (/<!-- FILL\b/.test(readFileSync(rules, 'utf8'))) problems.push(`${rules} still has FILL sections; finish /factory init`);
  return { ok: problems.length === 0, problems, excludeFile: main.excludeFile, checked: main.checks.length };
}

// Set the factory up in a repository: exclusions first, then the state
// directory, a config.json for overrides and the house-rules template. Never
// overwrites a file that exists.
export function initRepo(ctx, { templateFile }) {
  const paths = factoryPaths(ctx.factoryDir);
  const exclusions = ensureExclusions(ctx.repoDir, { links: ctx.config.worktree.links });
  mkdirSync(paths.factoryDir, { recursive: true });
  const created = [];
  if (!existsSync(paths.config)) {
    writeJsonAtomic(paths.config, { worktree: { links: ctx.config.worktree.links } });
    created.push(paths.config);
  }
  if (!existsSync(paths.houseRules)) {
    writeFileAtomic(paths.houseRules, readFileSync(templateFile, 'utf8'));
    created.push(paths.houseRules);
  }
  const rulesText = readFileSync(paths.houseRules, 'utf8');
  const fill = [...rulesText.matchAll(/<!-- FILL: ([^>]*?) -->/g)].map((m) => m[1].trim());
  const check = checkExclusions(ctx.repoDir, { links: ctx.config.worktree.links });
  return { ok: check.ok, excludeFile: check.excludeFile, addedPatterns: exclusions.added, created, houseRules: paths.houseRules, fill, problems: check.problems };
}

function requirePreflight(ctx, worktree) {
  const pf = preflight(ctx, { worktree });
  if (!pf.ok) throw new FactoryError('EXCLUSION', 'factory exclusion check failed; no Git operation was run', pf.problems);
  return pf;
}

function slug(text, words = 5) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).slice(0, words).join('-') || 'feature';
}

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------------------

export function startRun(ctx, { title, request, sessionId = null, model = null, now = new Date() }) {
  if (!title || !request) throw new FactoryError('USAGE', 'start needs a title and the request text');
  const paths = factoryPaths(ctx.factoryDir);
  const { board: current } = readBoard(paths.board, ctx.config);
  if (ACTIVE.includes(current.status)) {
    throw new FactoryError('ACTIVE_RUN', `run ${current.runId} is ${current.status}; ask the human whether to abandon it (fac.mjs stop) first`);
  }
  requirePreflight(ctx);
  const branch = currentBranch(ctx.repoDir);
  if (!branch) throw new FactoryError('DETACHED', 'HEAD is detached; ask the human to check out a branch');
  const start = headCommit(ctx.repoDir);

  let runId = `${localStamp(now)}-${slug(title)}`;
  for (let i = 2; existsSync(path.join(paths.runs, runId)) || refExists(ctx.repoDir, `factory/${runId}`); i++) runId = `${localStamp(now)}-${slug(title)}-${i}`;
  const dir = path.join(paths.runs, runId);
  mkdirSync(path.join(dir, 'reviews'), { recursive: true });
  mkdirSync(path.join(dir, 'artifacts'), { recursive: true });

  // Starting state of the human's checkout, for the guard after each round.
  const status = statusMap(ctx.repoDir);
  const dirty = Object.keys(status);
  writeJsonAtomic(path.join(dir, 'artifacts', 'main-status.json'), { branch, start, status, hashes: hashFiles(ctx.repoDir, dirty), index: indexFingerprint(ctx.repoDir) });
  writeFileAtomic(path.join(dir, 'main-status.txt'), dirty.length ? `${dirty.map((p) => `${status[p]} ${p}`).join('\n')}\n` : '(clean)\n');
  writeFileAtomic(path.join(dir, 'request.md'), `# ${title}\n\n${request.trim()}\n`);

  const factoryBranch = `factory/${runId}`;
  const worktree = path.relative(ctx.repoDir, path.join(paths.worktrees, runId)).split(path.sep).join('/');
  git(ctx.repoDir, ['worktree', 'add', '-q', '-b', factoryBranch, worktree, start]);
  const wt = path.resolve(ctx.repoDir, worktree);
  const linked = [];
  for (const d of ctx.config.worktree.links) {
    const src = path.join(ctx.repoDir, d);
    const dst = path.join(wt, d);
    if (existsSync(src) && !existsSync(dst) && existsSync(path.dirname(dst))) {
      symlinkSync(src, dst, 'dir');
      linked.push(d);
    }
  }
  const pf = preflight(ctx, { worktree: wt });

  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    Object.assign(b, emptyBoard(ctx.config));
    const at = nowIso(now);
    Object.assign(b, {
      runId, feature: { title, request }, branch, startCommit: start, factoryBranch, worktree,
      orchestrator: { sessionId, model }, status: 'RUNNING', createdAt: at,
    });
    setStage(b, 'request', 'DONE');
    setStage(b, 'worktree', 'DONE');
    logEvent(b, `Run ${runId} started from ${branch} @ ${start.slice(0, 7)}; worktree ${worktree}${linked.length ? ` (linked ${linked.join(', ')})` : ''}`);
    if (!pf.ok) logEvent(b, `Worktree exclusion warnings: ${pf.problems.join('; ')}`);
    sync(ctx, b);
    return { runId, branch, start, factoryBranch, worktree, worktreeAbs: wt, runDir: dir, linked, dirtyFiles: dirty.length };
  });
}

// An agent was spawned (or resumed). Record its session so its token usage
// can be attributed to this role, stage and round.
export function agentStart(ctx, role, { agentId = null, pass = null, task = null } = {}) {
  const roleCfg = ctx.config.agents[role];
  if (!roleCfg) throw new FactoryError('USAGE', `unknown role ${role}`);
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    requireStatus(b, ['RUNNING'], `starting ${role}`);
    const a = b.agents[role];
    const stage = roleCfg.stage;
    const round = stage === 'build' ? b.rounds.length : Math.max(0, b.rounds.length - 1);
    const resumed = Boolean(agentId && a.sessions.some((s) => s.agentId === agentId));
    a.sessions.push({ agentId, stage, round, pass: stage === 'review' ? (pass ?? b.reviews.at(-1)?.pass ?? null) : null, resumed, startedAt: nowIso(), endedAt: null, result: null });
    a.status = 'RUNNING';
    if (stage !== 'review') setStage(b, stage, 'ACTIVE');
    if (role === 'spec-writer') {
      expectRunFile(b, 'spec.md', ctx.config);
      expectRunFile(b, 'plan.md', ctx.config);
    }
    if (role === 'builder') expectRunFile(b, 'build.md', ctx.config, { round });
    if (role === 'approver') expectRunFile(b, 'approval.md', ctx.config);
    logEvent(b, `${roleCfg.label} ${resumed ? 'resumed' : 'started'}${task ? `: ${task}` : ''}${agentId ? ` (agent ${agentId})` : ''}`);
    sync(ctx, b);
    return { role, round, resumed };
  });
}

function closeSession(a, result) {
  const s = [...a.sessions].reverse().find((x) => !x.endedAt);
  if (s) {
    s.endedAt = nowIso();
    s.result = result;
  }
  return s;
}

// An agent finished. The decision comes from the files it wrote, never from
// its reply: missing or malformed outputs fail the step.
export function agentDone(ctx, role, { blocked = null } = {}) {
  const roleCfg = ctx.config.agents[role];
  if (!roleCfg) throw new FactoryError('USAGE', `unknown role ${role}`);
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    requireStatus(b, ['RUNNING'], `finishing ${role}`);
    const a = b.agents[role];
    const dir = runDir(ctx, b);
    const has = (rel) => existsSync(path.join(dir, rel)) && readFileSync(path.join(dir, rel), 'utf8').trim().length > 0;

    if (blocked) {
      closeSession(a, 'BLOCKED');
      a.status = 'BLOCKED';
      setStage(b, roleCfg.stage, 'BLOCKED');
      logEvent(b, `${roleCfg.label} is blocked: ${blocked}`);
      sync(ctx, b);
      return { ok: false, blocked };
    }

    let out = { ok: true };
    if (role === 'spec-writer') {
      const missing = ['spec.md', 'plan.md'].filter((f) => !has(f));
      out = { ok: missing.length === 0, missing };
    } else if (role === 'builder') {
      out = { ok: has('build.md'), missing: has('build.md') ? [] : ['build.md'] };
    } else if (role === 'approver') {
      const text = has('approval.md') ? readFileSync(path.join(dir, 'approval.md'), 'utf8') : '';
      const parsed = parseApproval(text);
      out = { ok: parsed.valid, decision: parsed.decision, reason: parsed.reason, missing: parsed.valid ? [] : ['approval.md'] };
    } else if (roleCfg.stage === 'review') {
      const pass = b.reviews.at(-1);
      if (!pass) throw new FactoryError('STATE', 'no review pass is open; run review-start first');
      const rel = `reviews/pass-${pass.pass}/${roleCfg.area}.md`;
      const text = has(rel) ? readFileSync(path.join(dir, rel), 'utf8') : '';
      const parsed = parseReviewReport(text, roleCfg.area);
      pass.results[roleCfg.area] = {
        status: parsed.result,
        artifactId: runFileId(b, rel),
        findings: parsed.valid ? parsed.findings.length : null,
        note: parsed.valid ? null : text ? parsed.reason : 'report missing or malformed',
      };
      out = { ok: true, area: roleCfg.area, result: parsed.result, valid: parsed.valid, findings: parsed.findings?.length ?? 0, report: path.join(dir, rel) };
    }

    const s = closeSession(a, out.decision ?? out.result ?? (out.ok ? 'DONE' : 'FAILED'));
    a.status = out.ok ? 'DONE' : 'FAILED';
    sync(ctx, b);

    if (role === 'spec-writer') {
      for (const f of out.missing) markFailed(b, f);
      setStage(b, 'spec', out.ok ? 'DONE' : 'BLOCKED');
    }
    if (role === 'builder' && !out.ok) markFailed(b, 'build.md');
    if (role === 'approver') {
      if (!out.ok) markFailed(b, 'approval.md');
      b.approval = { decision: out.decision, by: 'approver', reason: out.reason, artifactId: runFileId(b, 'approval.md'), at: nowIso() };
      if (out.decision === 'APPROVE') {
        setStage(b, 'approve', 'DONE');
        b.status = 'APPROVED';
      } else setStage(b, 'approve', 'BLOCKED');
    }
    const label = roleCfg.label;
    logEvent(b, out.result ? `${label} review: ${out.result}${out.valid === false ? ' (report missing or malformed)' : ''}` : out.decision ? `Approver decided ${out.decision}` : `${label} finished${out.ok ? '' : `, missing ${out.missing.join(', ')}`}`);
    return { ...out, session: s?.agentId ?? null };
  });
}

// Commit what the builder wrote in the worktree as one reviewable round.
export function commitRound(ctx, { allowEmpty = false } = {}) {
  const { board } = readBoard(factoryPaths(ctx.factoryDir).board, ctx.config);
  requireStatus(board, ['RUNNING'], 'committing a round');
  const wt = worktreeAbs(ctx, board);
  if (!existsSync(wt)) throw new FactoryError('WORKTREE', `worktree ${board.worktree} does not exist`);
  requirePreflight(ctx, wt);
  if (currentBranch(wt) !== board.factoryBranch) throw new FactoryError('WORKTREE', `worktree is not on ${board.factoryBranch}`);

  const n = board.rounds.length;
  const human = board.revision.pending === 'human';
  const label = n === 0 ? 'Initial build' : human ? `Human revision ${board.revision.human}` : `Revision ${board.revision.round}`;
  const message = `factory ${board.runId}: ${label.toLowerCase()}`;

  // info/exclude keeps factory paths and the dependency symlinks out; the
  // policy check below refuses anything that slips through anyway.
  git(wt, ['add', '-A']);
  const files = stagedFiles(wt);
  const bad = policyViolations(files);
  const diff = git(wt, ['diff', '--cached', '-U0', '--no-color', 'HEAD']).stdout;
  for (const p of secretLines(diff)) bad.push({ path: p, why: 'added lines look like a credential' });
  if (bad.length) {
    git(wt, ['reset', '-q']);
    throw new FactoryError('POLICY', 'the round contains files the factory must not commit; nothing was committed', bad);
  }
  if (!files.length && !allowEmpty) throw new FactoryError('NO_CHANGES', 'the builder left no changes in the worktree');
  git(wt, ['commit', '-q', ...(files.length ? [] : ['--allow-empty']), '-m', message]);
  const commit = headCommit(wt);

  // Guard: the builder must not have written into the human's checkout.
  const baseline = readJson(path.join(runDir(ctx, board), 'artifacts', 'main-status.json'), { status: {}, hashes: {} });
  const nowStatus = statusMap(ctx.repoDir);
  const touched = files.flatMap((f) => [f.path, f.oldPath]).filter(Boolean);
  const hashesNow = hashFiles(ctx.repoDir, touched.filter((p) => baseline.status[p]));
  const violations = touched.filter((p) => (baseline.status[p] ? hashesNow[p] !== baseline.hashes[p] : Boolean(nowStatus[p])));

  const prev = n === 0 ? board.startCommit : board.rounds[n - 1].commit;
  const patch = git(ctx.repoDir, ['diff', '--binary', '--find-renames', prev, commit]).stdout;
  writeFileAtomic(path.join(runDir(ctx, board), 'artifacts', `round-${n}.patch`), patch);

  const result = updateBoard(ctx.factoryDir, ctx.config, (b) => {
    const round = { round: n, label, human, commit, committedAt: nowIso(), files };
    b.rounds.push(round);
    b.revision.pending = null;
    registerRound(b, round);
    setStage(b, 'build', 'DONE');
    logEvent(b, `${label} committed as ${commit.slice(0, 7)} (${files.length} file${files.length === 1 ? '' : 's'})`);
    if (violations.length) logEvent(b, `Guard: changed in the main checkout during the build: ${violations.join(', ')}`);
    sync(ctx, b);
    return { round: n, label, commit, files };
  });
  // The round stays recorded (it is committed in the worktree); the
  // orchestrator must ask the human before going on.
  if (violations.length) throw new FactoryError('GUARD', 'files from this round also changed in the main checkout; ask the human', violations);
  return result;
}

export function reviewStart(ctx) {
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    requireStatus(b, ['RUNNING'], 'starting reviews');
    const last = b.rounds.at(-1);
    if (!last) throw new FactoryError('STATE', 'no committed round to review');
    if (b.reviews.at(-1)?.commit === last.commit) throw new FactoryError('STATE', `round ${last.round} is already under review (pass ${b.reviews.at(-1).pass})`);
    const pass = b.reviews.length + 1;
    mkdirSync(path.join(runDir(ctx, b), 'reviews', `pass-${pass}`), { recursive: true });
    const results = {};
    for (const r of reviewRoles(ctx.config)) {
      const rel = `reviews/pass-${pass}/${r.area}.md`;
      results[r.area] = { status: 'RUNNING', artifactId: expectRunFile(b, rel, ctx.config, { round: last.round }), findings: null, note: null };
    }
    b.reviews.push({ pass, round: last.round, commit: last.commit, startedAt: nowIso(), results });
    setStage(b, 'review', 'ACTIVE');
    logEvent(b, `Review pass ${pass} started on ${last.label.toLowerCase()} (${last.commit.slice(0, 7)})`);
    return {
      pass, round: last.round, commit: last.commit,
      reports: Object.fromEntries(reviewRoles(ctx.config).map((r) => [r.role, path.join(runDir(ctx, b), 'reviews', `pass-${pass}`, `${r.area}.md`)])),
    };
  });
}

// After all four reviewers: ALL_PASS, REVISE (another automatic round is
// allowed) or EXHAUSTED (escalate).
export function reviewOutcome(ctx) {
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    requireStatus(b, ['RUNNING'], 'aggregating reviews');
    const p = b.reviews.at(-1);
    if (!p) throw new FactoryError('STATE', 'no review pass');
    const running = Object.entries(p.results).filter(([, r]) => r.status === 'RUNNING' || r.status === 'PENDING').map(([k]) => k);
    if (running.length) throw new FactoryError('WAITING', `still waiting for: ${running.join(', ')}`);
    const changes = Object.entries(p.results).filter(([, r]) => r.status === 'CHANGES');
    if (!changes.length) {
      setStage(b, 'review', 'DONE');
      logEvent(b, `Review pass ${p.pass}: all four PASS`);
      return { outcome: 'ALL_PASS', pass: p.pass };
    }
    const dir = runDir(ctx, b);
    const reports = [];
    b.requestedChanges = b.requestedChanges.filter((c) => c.pass !== p.pass);
    for (const [area, r] of changes) {
      const rel = `reviews/pass-${p.pass}/${area}.md`;
      reports.push(path.join(dir, rel));
      const text = existsSync(path.join(dir, rel)) ? readFileSync(path.join(dir, rel), 'utf8') : '';
      const parsed = parseReviewReport(text, area);
      const findings = parsed.valid ? parsed.findings : [];
      if (!findings.length) b.requestedChanges.push({ pass: p.pass, area, severity: 'blocker', summary: r.note ?? 'CHANGES with no parsable numbered findings; read the report', artifactId: r.artifactId });
      for (const f of findings) b.requestedChanges.push({ pass: p.pass, area, severity: f.severity, summary: f.summary, artifactId: r.artifactId });
    }
    if (b.revision.round < b.revision.max) {
      setStage(b, 'review', 'CHANGES');
      logEvent(b, `Review pass ${p.pass}: CHANGES from ${changes.map(([a]) => a).join(', ')}`);
      return { outcome: 'REVISE', pass: p.pass, nextRevision: b.revision.round + 1, reports };
    }
    setStage(b, 'review', 'BLOCKED');
    logEvent(b, `Review pass ${p.pass}: CHANGES after ${b.revision.max} revision rounds`);
    return { outcome: 'EXHAUSTED', pass: p.pass, reports };
  });
}

// Open the next build round: an automatic revision (counts against the
// limit) or a human-directed one after an escalation (does not).
export function revise(ctx, { human = false } = {}) {
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    if (human) {
      requireStatus(b, ['WAITING_FOR_HUMAN', 'RUNNING'], 'a human revision');
      b.revision.human += 1;
      b.revision.pending = 'human';
      b.status = 'RUNNING';
      b.approval = { decision: null, by: null, reason: null, artifactId: null, at: null };
      for (const s of ['review', 'approve']) b.stages[s] = 'PENDING';
    } else {
      requireStatus(b, ['RUNNING'], 'a revision');
      if (b.revision.round >= b.revision.max) throw new FactoryError('LIMIT', `already used ${b.revision.max} automatic revision rounds`);
      b.revision.round += 1;
      b.revision.pending = 'auto';
    }
    setStage(b, 'build', 'ACTIVE');
    const label = human ? `Human revision ${b.revision.human}` : `Revision ${b.revision.round}`;
    logEvent(b, `${label} started`);
    return { label, round: b.rounds.length };
  });
}

export function escalate(ctx, { by = 'orchestrator', reason }) {
  if (!reason) throw new FactoryError('USAGE', 'escalate needs --reason');
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    if (!b.runId) throw new FactoryError('STATE', 'no run to escalate');
    const dir = runDir(ctx, b);
    const open = b.requestedChanges.filter((c) => c.pass === b.reviews.at(-1)?.pass);
    const files = [...new Set(b.rounds.flatMap((r) => r.files.map((f) => f.path)))];
    const art = (id) => b.artifacts.find((a) => a.id === id)?.path;
    const lines = [
      `# Escalation — ${b.feature?.title ?? b.runId}`,
      '',
      `**Reason:** ${reason}`,
      `**Escalated by:** ${by}`,
      `**Run:** \`${b.runId}\` · started from \`${b.branch}\` @ \`${b.startCommit?.slice(0, 7)}\``,
      '',
      '## Unresolved findings',
      ...(open.length ? open.map((c, i) => `${i + 1}. [${c.severity}] ${c.area}: ${c.summary} (\`${art(c.artifactId) ?? 'report'}\`)`) : ['None from the last review pass.']),
      ...(existsSync(path.join(dir, 'approval.md')) ? ['', 'The approver\'s findings and required manual actions are in `approval.md`.'] : []),
      '',
      '## Relevant files',
      ...(files.length ? files.map((f) => `- \`${f}\``) : ['- No application files were committed.']),
      '',
      '## Inspect the work',
      '```sh',
      `cd ${b.worktree}`,
      `git log --oneline ${b.startCommit?.slice(0, 7)}..`,
      `git diff ${b.startCommit?.slice(0, 7)}..`,
      '```',
      '',
      '## Next actions',
      '- `/factory approve [note]` approves this work and applies it to your branch as unstaged changes (after the Git safety checks).',
      '- Or tell the orchestrator what to change; that becomes a human revision, which does not count against the 2 automatic rounds.',
      `- Or abandon the run: \`git worktree remove --force ${b.worktree}\` and \`git branch -D ${b.factoryBranch}\`.`,
      '',
      '## What approval requires',
      '- The run has a committed build.',
      `- You are on \`${b.branch}\` and HEAD is still \`${b.startCommit?.slice(0, 7)}\`.`,
      '- The worktree is clean, the factory exclusions pass, and the patch applies cleanly (`git apply --check`).',
      '',
    ];
    writeFileAtomic(path.join(dir, 'escalation.md'), lines.join('\n'));
    const active = Object.entries(b.stages).find(([, s]) => s === 'ACTIVE')?.[0] ?? b.stage ?? 'approve';
    setStage(b, active, 'BLOCKED');
    b.status = 'WAITING_FOR_HUMAN';
    for (const a of Object.values(b.agents)) if (a.status === 'RUNNING') a.status = 'IDLE';
    sync(ctx, b);
    b.approval = { decision: 'ESCALATE', by, reason, artifactId: runFileId(b, by === 'approver' ? 'approval.md' : 'escalation.md'), at: nowIso() };
    logEvent(b, `Escalated by ${by}: ${reason}`);
    return { file: path.join(dir, 'escalation.md') };
  });
}

// `/factory approve [note]`: the human approves escalated work.
export function humanApprove(ctx, { note = null } = {}) {
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    if (b.status !== 'WAITING_FOR_HUMAN') throw new FactoryError('STATE', `nothing is waiting for approval (status ${b.status})`);
    if (!b.rounds.length || b.stages.build === 'ACTIVE') throw new FactoryError('NO_BUILD', 'there is no committed build to approve');
    b.approval = { decision: 'APPROVE', by: 'human', reason: note || 'approved by a human', artifactId: runFileId(b, 'escalation.md'), at: nowIso() };
    setStage(b, 'approve', 'DONE');
    b.status = 'APPROVED';
    logEvent(b, `Approved by the human${note ? `: ${note}` : ''}`);
    return { runId: b.runId };
  });
}

// Apply the approved branch to the human's checkout as unstaged changes.
// Every check runs before anything is modified; any failure leaves the
// checkout exactly as it was.
export function mergeBack(ctx, { notes = '', allowMovedHead = false } = {}) {
  const paths = factoryPaths(ctx.factoryDir);
  const { board } = readBoard(paths.board, ctx.config);
  requireStatus(board, ['APPROVED'], 'merge-back');
  const repo = ctx.repoDir;
  const wt = worktreeAbs(ctx, board);
  const dir = runDir(ctx, board);
  const fail = (code, message, details) => {
    throw new FactoryError(code, `${message}; nothing was changed in your checkout`, details);
  };

  const branch = currentBranch(repo);
  if (branch !== board.branch) fail('BRANCH', `you are on ${branch ?? 'a detached HEAD'}, the run started from ${board.branch}`);
  const head = headCommit(repo);
  if (head !== board.startCommit && !allowMovedHead) fail('HEAD_MOVED', `HEAD moved from ${board.startCommit.slice(0, 7)} to ${head.slice(0, 7)}`);
  if (existsSync(wt)) {
    const dirty = git(wt, ['status', '--porcelain', '--', '.', ...ctx.config.worktree.links.map((l) => `:(exclude)${l}`)]).stdout.trim();
    if (dirty) fail('WORKTREE_DIRTY', 'the worktree has uncommitted changes', dirty.split('\n'));
  }
  requirePreflight(ctx, existsSync(wt) ? wt : undefined);
  const ops = pendingOperations(repo);
  if (ops.length) fail('GIT_STATE', `the repository has an operation in progress (${ops.join(', ')})`);
  if (!refExists(repo, board.factoryBranch)) fail('NO_BRANCH', `branch ${board.factoryBranch} is gone`);
  const tip = gitOut(repo, ['rev-parse', `refs/heads/${board.factoryBranch}`]);
  if (board.rounds.at(-1)?.commit !== tip) fail('TIP', `the factory branch tip ${tip.slice(0, 7)} is not the last reviewed round`);

  const files = diffFiles(repo, board.startCommit, tip);
  const bad = policyViolations(files);
  const patch = git(repo, ['diff', '--binary', '--find-renames', board.startCommit, tip]).stdout;
  for (const p of secretLines(patch)) bad.push({ path: p, why: 'added lines look like a credential' });
  if (bad.length) fail('POLICY', 'the patch contains files the factory must not apply', bad);
  if (!files.length) fail('EMPTY', 'the factory branch has no changes');

  const patchFile = path.join(dir, 'changes.patch');
  writeFileAtomic(patchFile, patch);
  const indexBefore = indexFingerprint(repo);
  const check = git(repo, ['apply', '--check', patchFile], { allowFail: true });
  if (check.code !== 0) fail('CONFLICT', 'the patch does not apply cleanly to your working tree', check.stderr.trim().split('\n'));

  // The only write to the human's checkout: working tree, never the index.
  const applied = git(repo, ['apply', patchFile], { allowFail: true });
  if (applied.code !== 0) throw new FactoryError('APPLY', 'git apply failed after a clean --check; inspect `git status`', applied.stderr.trim().split('\n'));
  const after = { index: indexFingerprint(repo), head: headCommit(repo), ops: pendingOperations(repo) };
  const verified = after.index === indexBefore && after.head === head && after.ops.length === 0;

  // Keep the final version of every changed file, so the artifact viewer
  // still works after the branch is deleted.
  const snapshots = [];
  for (const f of files) {
    if (f.change === 'D' || isSecretPath(f.path)) continue;
    const blob = showBlob(repo, tip, f.path);
    if (!blob || blob.length > ctx.config.files.maxBytes) continue;
    const rel = `artifacts/final/${f.path}`;
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileAtomic(path.join(dir, rel), blob);
    snapshots.push({ path: f.path, snapshot: rel });
  }

  let worktreeRemoved = false;
  let worktreeNote = null;
  if (existsSync(wt)) {
    for (const d of ctx.config.worktree.links) {
      const p = path.join(wt, d);
      try {
        if (lstatSync(p).isSymbolicLink()) unlinkSync(p);
      } catch {}
    }
    const rm = git(repo, ['worktree', 'remove', wt], { allowFail: true });
    worktreeRemoved = rm.code === 0;
    if (!worktreeRemoved) worktreeNote = rm.stderr.trim();
  }

  const stat = git(repo, ['diff', '--stat', board.startCommit, tip]).stdout.trimEnd();
  const appr = board.approval;
  const md = [
    `# Merge back — ${board.feature?.title ?? board.runId}`,
    '',
    `**Start point:** \`${board.branch}\` @ \`${board.startCommit}\``,
    `**Applied from:** \`${board.factoryBranch}\` @ \`${tip.slice(0, 7)}\` (${board.rounds.length} round${board.rounds.length === 1 ? '' : 's'}: ${board.rounds.map((r) => r.label.toLowerCase()).join(', ')})`,
    `**Approval:** ${appr.decision} by ${appr.by}${appr.reason ? ` — ${appr.reason}` : ''}`,
    '',
    '## Diff statistics',
    '```',
    stat,
    '```',
    '',
    '## How it landed',
    `- Applied with \`git apply\` to \`${board.branch}\`: the changes are **uncommitted and unstaged**. Nothing was committed and nothing was pushed.`,
    verified ? '- Your index is unchanged (checked before and after), HEAD is unchanged, and no merge state is left behind.' : `- **Check needed:** index unchanged: ${after.index === indexBefore}, HEAD unchanged: ${after.head === head}, pending operations: ${after.ops.join(', ') || 'none'}.`,
    worktreeRemoved ? '- The worktree was removed. The branch is kept for inspection.' : `- The worktree was not removed${worktreeNote ? ` (${worktreeNote})` : ''}.`,
    '',
    notes.trim(),
    '',
    '## Cleanup',
    'Once your work is committed, the factory branch can be deleted:',
    '```sh',
    `git branch -D ${board.factoryBranch}`,
    '```',
    '',
  ];
  writeFileAtomic(path.join(dir, 'merge.md'), md.join('\n'));

  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    for (const s of snapshots) {
      const a = b.artifacts.find((x) => x.kind === 'git-file' && x.path === s.path);
      if (a) a.snapshot = s.snapshot;
    }
    setStage(b, 'merge', 'DONE');
    b.status = 'MERGED';
    b.endedAt = nowIso();
    for (const a of Object.values(b.agents)) if (a.status === 'RUNNING') a.status = 'IDLE';
    logEvent(b, `Merged back into ${b.branch} as unstaged changes (${files.length} files)${verified ? '' : ' — post-apply check needs attention'}`);
    sync(ctx, b);
    return { files: files.length, verified, worktreeRemoved, mergeFile: path.join(dir, 'merge.md'), patch: patchFile };
  });
}

export function stopRun(ctx, { reason = 'abandoned by the human' } = {}) {
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    if (!b.runId || ['IDLE', 'MERGED', 'STOPPED'].includes(b.status)) throw new FactoryError('STATE', `no active run (status ${b.status})`);
    b.status = 'STOPPED';
    b.endedAt = nowIso();
    for (const a of Object.values(b.agents)) if (a.status === 'RUNNING') a.status = 'IDLE';
    logEvent(b, `Run stopped: ${reason}`);
    return { runId: b.runId, cleanup: [`git worktree remove --force ${b.worktree}`, `git branch -D ${b.factoryBranch}`] };
  });
}

export function addLog(ctx, text) {
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    logEvent(b, text);
    sync(ctx, b);
    return { ok: true };
  });
}

export function syncArtifacts(ctx) {
  return updateBoard(ctx.factoryDir, ctx.config, (b) => {
    sync(ctx, b);
    return { artifacts: b.artifacts.length };
  });
}
