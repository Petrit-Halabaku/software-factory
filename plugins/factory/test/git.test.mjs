// Git safety, on scratch repositories that carry staged, unstaged and
// untracked human changes. Never runs against the real checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as wf from '../lib/workflow.mjs';
import { checkExclusions } from '../lib/exclude.mjs';
import { indexFingerprint, pendingOperations } from '../lib/git.mjs';
import { readBoard } from '../lib/board.mjs';
import { g, makeRepo, read, reviewAll, sh, startAndBuild, write } from './helpers.mjs';

const board = (ctx) => readBoard(path.join(ctx.factoryDir, 'board.json'), ctx.config).board;
const throwsCode = (fn, code) => assert.throws(fn, (e) => e.code === code || assert.fail(`expected ${code}, got ${e.code}: ${e.message}`));

test('exclusions: every factory path is ignored, app paths are not, in the checkout and in a linked worktree', (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const links = r.ctx.config.worktree.links;
  const main = checkExclusions(r.repo, { links });
  assert.equal(main.ok, true, main.problems.join('\n'));
  for (const c of main.checks) assert.match(c.match.source, /info\/exclude$/, c.path);
  const { run } = startAndBuild(wf, r.ctx);
  const wt = checkExclusions(run.worktreeAbs, { links });
  assert.equal(wt.ok, true, wt.problems.join('\n'));
  // the dependency symlinks are ignored inside the worktree
  assert.equal(g(run.worktreeAbs, 'status', '--porcelain', '--', 'node_modules', 'worker/node_modules'), '');
});

test('exclusions: a tracked or staged factory file, or a missing pattern, fails the preflight', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  write(path.join(r.repo, 'factory/README.md'), 'x');
  g(r.repo, 'add', '-f', 'factory/README.md');
  let pf = wf.preflight(r.ctx);
  assert.equal(pf.ok, false);
  assert.ok(pf.problems.some((p) => p.includes('staged: factory/README.md')));
  g(r.repo, 'commit', '-q', '-m', 'oops');
  pf = wf.preflight(r.ctx);
  assert.ok(pf.problems.some((p) => p.includes('tracked by Git: factory/README.md')));
  throwsCode(() => wf.startRun(r.ctx, { title: 'x', request: 'y' }), 'EXCLUSION');

  const r2 = makeRepo({ humanChanges: false });
  t.after(r2.cleanup);
  writeFileSync(path.join(r2.repo, '.git/info/exclude'), '/factory/\n');
  pf = wf.preflight(r2.ctx);
  assert.equal(pf.ok, false);
  assert.ok(pf.problems.some((p) => p.includes('missing the pattern /worker/node_modules')));
});

test('init: adds the exclusion block once, keeps what was there, never overwrites factory files', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const excl = path.join(r.repo, '.git/info/exclude');
  writeFileSync(excl, '# mine\n*.log\n');
  rmSync(path.join(r.factoryDir, 'house-rules.md'));
  const template = path.join(r.root, 'template.md');
  writeFileSync(template, '# Rules\n\n<!-- FILL: repository facts -->\n\n<!-- FILL: tests -->\n');

  const first = wf.initRepo(r.ctx, { templateFile: template });
  assert.deepEqual(first.addedPatterns, ['/factory/', '/node_modules', '/worker/node_modules']);
  assert.equal(first.ok, true, first.problems.join('\n'));
  assert.deepEqual(first.fill, ['repository facts', 'tests']);
  assert.ok(first.created.includes(path.join(r.factoryDir, 'house-rules.md')));
  assert.equal(first.created.includes(path.join(r.factoryDir, 'config.json')), false, 'an existing config.json is kept');
  assert.match(read(excl), /^# mine\n\*\.log\n/);

  const second = wf.initRepo(r.ctx, { templateFile: template });
  assert.deepEqual(second.addedPatterns, []);
  assert.deepEqual(second.created, []);
  assert.equal(read(excl).split('\n').filter((l) => l === '/factory/').length, 1);

  let pf = wf.preflight(r.ctx);
  assert.ok(pf.problems.some((p) => p.includes('FILL')));
  writeFileSync(path.join(r.factoryDir, 'house-rules.md'), '# Rules\n\nfilled\n');
  pf = wf.preflight(r.ctx);
  assert.equal(pf.ok, true, pf.problems.join('\n'));
  rmSync(path.join(r.factoryDir, 'house-rules.md'));
  pf = wf.preflight(r.ctx);
  assert.ok(pf.problems.some((p) => p.includes('run /factory init')));
});

test('a full run: rounds committed in the worktree, merge-back unstaged, index and HEAD untouched, human changes kept', (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const headBefore = g(r.repo, 'rev-parse', 'HEAD');
  const indexBefore = indexFingerprint(r.repo);
  const stagedBefore = g(r.repo, 'diff', '--cached', '--name-only');

  const { run, round } = startAndBuild(wf, r.ctx);
  assert.equal(board(r.ctx).status, 'RUNNING');
  assert.equal(round.label, 'Initial build');
  assert.deepEqual(round.files.map((f) => f.path).sort(), ['lib/math.js', 'lib/math.test.js']);
  // factory infra written inside the worktree is never committed
  assert.equal(g(run.worktreeAbs, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n').some((p) => p.startsWith('factory/') || p.includes('node_modules')), false);
  // the human's checkout is untouched by the build
  assert.equal(read(path.join(r.repo, 'lib/math.js')), 'export const add = (a, b) => a + b;\n');
  assert.equal(g(r.repo, 'rev-parse', 'HEAD'), headBefore);
  assert.equal(indexFingerprint(r.repo), indexBefore);

  // pass 1: code asks for changes → revision 1
  const p1 = reviewAll(wf, r.ctx, run.runDir, { code: ['CHANGES', [['blocker', 'sub has no test'], ['should-fix', 'name it subtract']]] });
  assert.equal(p1.outcome.outcome, 'REVISE');
  assert.equal(board(r.ctx).requestedChanges.length, 2);
  wf.revise(r.ctx);
  wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });
  write(path.join(run.worktreeAbs, 'lib/math.test.js'), 'import test from "node:test";\ntest("sub", () => {});\n');
  write(path.join(run.runDir, 'build.md'), `${read(path.join(run.runDir, 'build.md'))}\n## Revision 1\n- added the test\n`);
  wf.agentDone(r.ctx, 'builder');
  const rev1 = wf.commitRound(r.ctx);
  assert.equal(rev1.label, 'Revision 1');
  const b1 = board(r.ctx);
  assert.equal(b1.rounds.length, 2);
  assert.equal(b1.agents.builder.sessions.at(-1).resumed, true);
  // both rounds stay reviewable
  assert.notEqual(b1.rounds[0].commit, b1.rounds[1].commit);
  assert.match(g(r.repo, 'show', `${b1.rounds[0].commit}:lib/math.test.js`), /^import test/);

  const p2 = reviewAll(wf, r.ctx, run.runDir, {});
  assert.equal(p2.outcome.outcome, 'ALL_PASS');
  // pass 1 reports are kept
  assert.ok(existsSync(path.join(run.runDir, 'reviews/pass-1/code.md')));

  wf.agentStart(r.ctx, 'approver', { agentId: 'aappr' });
  write(path.join(run.runDir, 'approval.md'), '# Approval\n\nDecision: APPROVE\n\n## Why\nAll criteria met.\n');
  const ap = wf.agentDone(r.ctx, 'approver');
  assert.equal(ap.decision, 'APPROVE');
  assert.equal(board(r.ctx).status, 'APPROVED');

  const res = wf.mergeBack(r.ctx, { notes: '## Suggested commit message\n```\nAdd sub()\n```\n' });
  assert.equal(res.verified, true);
  assert.equal(res.worktreeRemoved, true);
  assert.equal(g(r.repo, 'rev-parse', 'HEAD'), headBefore, 'HEAD unchanged');
  assert.equal(indexFingerprint(r.repo), indexBefore, 'index unchanged');
  assert.equal(g(r.repo, 'diff', '--cached', '--name-only'), stagedBefore, 'staged set unchanged');
  assert.deepEqual(pendingOperations(r.repo), []);
  // the changes are in the working tree, unstaged
  assert.match(read(path.join(r.repo, 'lib/math.js')), /sub/);
  const status = sh(r.repo, 'git', ['status', '--porcelain']);
  assert.match(status, /^ M lib\/math\.js$/m);
  assert.match(status, /^\?\? lib\/math\.test\.js$/m);
  // unrelated human changes are preserved
  assert.match(read(path.join(r.repo, 'app/page.js')), /human edit/);
  assert.match(status, /^ M app\/page\.js$/m);
  assert.match(status, /^M  worker\/index\.js$/m);
  assert.match(status, /^\?\? scratch-notes\.txt$/m);
  // nothing from the factory is visible to git
  assert.equal(status.split('\n').some((l) => l.includes('factory/')), false);
  // branch kept, worktree gone, final snapshots kept, merge notes written
  assert.ok(g(r.repo, 'branch', '--list', board(r.ctx).factoryBranch));
  assert.equal(existsSync(run.worktreeAbs), false);
  assert.match(read(path.join(run.runDir, 'artifacts/final/lib/math.js')), /sub/);
  assert.match(read(res.mergeFile), /uncommitted and unstaged/);
  assert.equal(board(r.ctx).status, 'MERGED');
});

test('a conflict with the human\'s changes fails before anything is modified', (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const { run } = startAndBuild(wf, r.ctx);
  reviewAll(wf, r.ctx, run.runDir, {});
  wf.agentStart(r.ctx, 'approver');
  write(path.join(run.runDir, 'approval.md'), 'Decision: APPROVE\n');
  wf.agentDone(r.ctx, 'approver');
  // the human edits the same line meanwhile
  writeFileSync(path.join(r.repo, 'lib/math.js'), 'export const add = (a, b) => b + a;\n');
  const before = { status: g(r.repo, 'status', '--porcelain'), index: indexFingerprint(r.repo), file: read(path.join(r.repo, 'lib/math.js')) };
  throwsCode(() => wf.mergeBack(r.ctx), 'CONFLICT');
  assert.equal(g(r.repo, 'status', '--porcelain'), before.status);
  assert.equal(indexFingerprint(r.repo), before.index);
  assert.equal(read(path.join(r.repo, 'lib/math.js')), before.file);
  assert.equal(existsSync(path.join(r.repo, 'lib/math.test.js')), false, 'no partial application');
  assert.deepEqual(pendingOperations(r.repo), []);
  assert.equal(board(r.ctx).status, 'APPROVED', 'still approved, waiting for the human to resolve');
});

test('merge-back refuses a moved HEAD, another branch, or a dirty worktree', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const { run } = startAndBuild(wf, r.ctx);
  reviewAll(wf, r.ctx, run.runDir, {});
  wf.agentStart(r.ctx, 'approver');
  write(path.join(run.runDir, 'approval.md'), 'Decision: APPROVE\n');
  wf.agentDone(r.ctx, 'approver');

  write(path.join(run.worktreeAbs, 'lib/stray.js'), 'x\n');
  throwsCode(() => wf.mergeBack(r.ctx), 'WORKTREE_DIRTY');
  g(run.worktreeAbs, 'clean', '-fdq', '--', 'lib');

  g(r.repo, 'checkout', '-q', '-b', 'other');
  throwsCode(() => wf.mergeBack(r.ctx), 'BRANCH');
  g(r.repo, 'checkout', '-q', 'main');

  writeFileSync(path.join(r.repo, 'README.md'), 'moved\n');
  g(r.repo, 'add', 'README.md');
  g(r.repo, 'commit', '-q', '-m', 'human commit');
  throwsCode(() => wf.mergeBack(r.ctx), 'HEAD_MOVED');
});

test('rounds refuse secrets and dependency paths, and the guard spots writes to the main checkout', (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  const { run } = startAndBuild(wf, r.ctx);
  reviewAll(wf, r.ctx, run.runDir, { security: ['CHANGES', [['blocker', 'x']]] });
  wf.revise(r.ctx);
  wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });

  write(path.join(run.worktreeAbs, '.env.local'), 'SERVICE_ROLE_KEY=abc\n');
  throwsCode(() => wf.commitRound(r.ctx), 'POLICY');
  assert.equal(g(run.worktreeAbs, 'diff', '--cached', '--name-only'), '', 'worktree index reset');
  g(run.worktreeAbs, 'clean', '-fq', '--', '.env.local');

  // Assembled at run time so no key-shaped literal sits in the source.
  const fakeKey = ['sk', 'live', '0123456789abcdefghijklmn'].join('_');
  write(path.join(run.worktreeAbs, 'lib/keys.js'), `export const k = "${fakeKey}";\n`);
  throwsCode(() => wf.commitRound(r.ctx), 'POLICY');
  g(run.worktreeAbs, 'clean', '-fq', '--', 'lib/keys.js');

  // the builder (wrongly) also edits the human's checkout
  write(path.join(run.worktreeAbs, 'lib/math.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n');
  writeFileSync(path.join(r.repo, 'lib/math.js'), 'export const add = 0;\n');
  throwsCode(() => wf.commitRound(r.ctx), 'GUARD');
  const b = board(r.ctx);
  assert.equal(b.rounds.length, 2, 'the round itself is recorded');
  assert.ok(b.log.some((l) => l.text.includes('Guard: changed in the main checkout')));
});

test('limits, escalation and human approval', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const { run } = startAndBuild(wf, r.ctx);
  for (let i = 1; i <= 2; i++) {
    const p = reviewAll(wf, r.ctx, run.runDir, { ux: ['CHANGES', [['should-fix', `still off ${i}`]]] });
    assert.equal(p.outcome.outcome, 'REVISE');
    wf.revise(r.ctx);
    wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });
    write(path.join(run.worktreeAbs, 'lib/math.js'), `export const add = (a, b) => a + b; // ${i}\n`);
    wf.agentDone(r.ctx, 'builder');
    wf.commitRound(r.ctx);
  }
  const last = reviewAll(wf, r.ctx, run.runDir, { ux: 'MISSING' });
  assert.equal(last.outcome.outcome, 'EXHAUSTED');
  const b = board(r.ctx);
  assert.equal(b.reviews.at(-1).results.ux.status, 'CHANGES');
  assert.equal(b.reviews.at(-1).results.ux.note, 'report missing or malformed');
  throwsCode(() => wf.revise(r.ctx), 'LIMIT');

  throwsCode(() => wf.humanApprove(r.ctx), 'STATE');
  wf.escalate(r.ctx, { by: 'orchestrator', reason: 'reviews still request changes after 2 revision rounds' });
  assert.equal(board(r.ctx).status, 'WAITING_FOR_HUMAN');
  assert.match(read(path.join(run.runDir, 'escalation.md')), /reviews still request changes/);
  throwsCode(() => wf.startRun(r.ctx, { title: 'another', request: 'x' }), 'ACTIVE_RUN');

  // a human revision does not count against the limit
  wf.revise(r.ctx, { human: true });
  assert.equal(board(r.ctx).revision.round, 2);
  assert.equal(board(r.ctx).revision.human, 1);
  wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });
  write(path.join(run.worktreeAbs, 'lib/math.js'), 'export const add = (a, b) => a + b; // human\n');
  wf.agentDone(r.ctx, 'builder');
  assert.equal(wf.commitRound(r.ctx).label, 'Human revision 1');
  wf.escalate(r.ctx, { by: 'orchestrator', reason: 'human asked to see it again' });
  wf.humanApprove(r.ctx, { note: 'ship it' });
  const after = board(r.ctx);
  assert.equal(after.status, 'APPROVED');
  assert.deepEqual([after.approval.decision, after.approval.by, after.approval.reason], ['APPROVE', 'human', 'ship it']);
});

test('start refuses a detached HEAD and keeps runs apart', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  g(r.repo, 'checkout', '-q', '--detach');
  throwsCode(() => wf.startRun(r.ctx, { title: 'x', request: 'y' }), 'DETACHED');
  g(r.repo, 'checkout', '-q', 'main');
  const a = wf.startRun(r.ctx, { title: 'First feature', request: 'one' });
  wf.stopRun(r.ctx);
  const b = wf.startRun(r.ctx, { title: 'First feature', request: 'two' });
  assert.notEqual(a.runId, b.runId);
  assert.notEqual(a.worktreeAbs, b.worktreeAbs);
  assert.ok(existsSync(path.join(r.factoryDir, 'runs', a.runId, 'run.json')), 'the stopped run stays archived');
});

test('spec writer without plan.md fails the stage; a symlinked node_modules is never committed', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const run = wf.startRun(r.ctx, { title: 'x', request: 'y' });
  assert.equal(readFileSync(path.join(run.worktreeAbs, 'node_modules/dep/index.js'), 'utf8'), '');
  wf.agentStart(r.ctx, 'spec-writer');
  write(path.join(run.runDir, 'spec.md'), '# Spec\n');
  const res = wf.agentDone(r.ctx, 'spec-writer');
  assert.equal(res.ok, false);
  assert.deepEqual(res.missing, ['plan.md']);
  const b = board(r.ctx);
  assert.equal(b.stages.spec, 'BLOCKED');
  assert.equal(b.artifacts.find((a) => a.path === 'plan.md').status, 'FAILED');
  symlinkSync(path.join(r.repo, 'node_modules'), path.join(run.worktreeAbs, 'lib/node_modules'));
  wf.agentStart(r.ctx, 'builder');
  write(path.join(run.worktreeAbs, 'lib/x.js'), 'x\n');
  throwsCode(() => wf.commitRound(r.ctx), 'POLICY');
});
