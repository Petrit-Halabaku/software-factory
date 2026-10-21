// The artifact registry and the read-only file API.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as wf from '../lib/workflow.mjs';
import { readBoard } from '../lib/board.mjs';
import { artifactId } from '../lib/artifacts.mjs';
import { FileError, downloadArtifact, patchSection, readArtifact, safeRelative } from '../lib/files.mjs';
import { g, makeRepo, reviewAll, startAndBuild, write } from './helpers.mjs';

const board = (ctx) => readBoard(path.join(ctx.factoryDir, 'board.json'), ctx.config).board;
const byPath = (b, p, kind = 'run-file') => b.artifacts.find((a) => a.path === p && a.kind === kind);
const rejects = (fn, status) => assert.throws(fn, (e) => e instanceof FileError && e.status === status);

test('documents register as they are written and open while later agents run', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const run = wf.startRun(r.ctx, { title: 'Docs', request: 'Make docs.' });
  wf.agentStart(r.ctx, 'spec-writer', { agentId: 'aspec' });
  let b = board(r.ctx);
  assert.equal(byPath(b, 'spec.md').status, 'PENDING');
  assert.equal(byPath(b, 'request.md').status, 'READY');
  write(path.join(run.runDir, 'spec.md'), '# Spec\n\n- [ ] AC1\n');
  wf.addLog(r.ctx, 'sync while the spec writer still runs');
  b = board(r.ctx);
  assert.equal(byPath(b, 'spec.md').status, 'WRITING', 'not openable until the agent is done');
  assert.equal(readArtifact(r.ctx, b, byPath(b, 'spec.md').id).kind, 'unavailable');
  write(path.join(run.runDir, 'plan.md'), '# Plan\n');
  wf.agentDone(r.ctx, 'spec-writer');
  wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });
  b = board(r.ctx);
  const spec = byPath(b, 'spec.md');
  assert.equal(spec.status, 'READY');
  assert.equal(b.agents.builder.status, 'RUNNING');
  const res = readArtifact(r.ctx, b, spec.id);
  assert.equal(res.kind, 'markdown');
  assert.match(res.text, /AC1/);
  assert.deepEqual([spec.agent, spec.stage, spec.category], ['spec-writer', 'spec', 'specification']);
  // an update after READY is flagged
  write(path.join(run.runDir, 'spec.md'), '# Spec v2\n');
  wf.syncArtifacts(r.ctx);
  assert.equal(byPath(board(r.ctx), 'spec.md').status, 'UPDATED');
});

test('changed files, versions per round, diffs and history', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const { run } = startAndBuild(wf, r.ctx);
  reviewAll(wf, r.ctx, run.runDir, { code: ['CHANGES', [['blocker', 'x']]] });
  wf.revise(r.ctx);
  wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });
  write(path.join(run.worktreeAbs, 'lib/math.js'), 'export const add = (a, b) => a + b;\nexport const subtract = (a, b) => a - b;\n');
  g(run.worktreeAbs, 'mv', 'lib/notes.md', 'lib/NOTES.md');
  wf.agentDone(r.ctx, 'builder');
  wf.commitRound(r.ctx);
  const b = board(r.ctx);
  const math = byPath(b, 'lib/math.js', 'git-file');
  assert.deepEqual(math.versions.map((v) => v.round), [0, 1]);
  assert.equal(math.change, 'modified');
  assert.equal(math.status, 'UPDATED');
  const test = byPath(b, 'lib/math.test.js', 'git-file');
  assert.equal(test.group, 'tests');
  assert.equal(test.change, 'added');
  const renamed = byPath(b, 'lib/NOTES.md', 'git-file');
  assert.equal(renamed.change, 'renamed');
  assert.equal(renamed.versions[0].oldPath, 'lib/notes.md');

  assert.match(readArtifact(r.ctx, b, math.id, { version: 0 }).text, /export const sub =/);
  const latest = readArtifact(r.ctx, b, math.id);
  assert.equal(latest.kind, 'code');
  assert.equal(latest.language, 'javascript');
  assert.match(latest.text, /subtract/);
  const dStart = readArtifact(r.ctx, b, math.id, { view: 'diff' });
  assert.equal(dStart.from, 'start');
  assert.match(dStart.text, /^\+export const subtract/m);
  const dPrev = readArtifact(r.ctx, b, math.id, { view: 'diff', against: 'prev' });
  assert.equal(dPrev.from, 'Initial build');
  assert.match(dPrev.text, /^-export const sub =/m);
  assert.match(readArtifact(r.ctx, b, renamed.id, { view: 'diff' }).text, /rename from lib\/notes\.md/);
  const hist = readArtifact(r.ctx, b, math.id, { view: 'history' });
  assert.deepEqual(hist.versions.map((v) => [v.round, v.available]), [[0, true], [1, true]]);
  rejects(() => readArtifact(r.ctx, b, math.id, { version: 7 }), 404);
  rejects(() => readArtifact(r.ctx, b, byPath(b, 'spec.md').id, { view: 'diff' }), 400);
  // round patches are registered too
  assert.equal(byPath(b, 'artifacts/round-1.patch').fileType, 'diff');
});

test('after cleanup: the worktree is gone, then the branch is gone', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const { run } = startAndBuild(wf, r.ctx);
  reviewAll(wf, r.ctx, run.runDir, { ux: ['CHANGES', [['should-fix', 'x']]] });
  wf.revise(r.ctx);
  wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });
  write(path.join(run.worktreeAbs, 'lib/math.js'), 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b; // final\n');
  wf.agentDone(r.ctx, 'builder');
  wf.commitRound(r.ctx);
  reviewAll(wf, r.ctx, run.runDir, {});
  wf.agentStart(r.ctx, 'approver');
  write(path.join(run.runDir, 'approval.md'), 'Decision: APPROVE\n');
  wf.agentDone(r.ctx, 'approver');
  wf.mergeBack(r.ctx);

  let b = board(r.ctx);
  const math = byPath(b, 'lib/math.js', 'git-file');
  // worktree removed, branch kept: every version still readable from git
  assert.match(readArtifact(r.ctx, b, math.id, { version: 0 }).text, /a - b;\n$/);
  assert.equal(readArtifact(r.ctx, b, byPath(b, 'reviews/pass-1/ux.md').id).kind, 'markdown', 'earlier review still opens');
  assert.equal(readArtifact(r.ctx, b, byPath(b, 'merge.md').id).kind, 'markdown');

  // the human deletes the branch; commits become unreachable
  g(r.repo, 'branch', '-D', b.factoryBranch);
  g(r.repo, 'reflog', 'expire', '--expire=now', '--all');
  g(r.repo, 'gc', '-q', '--prune=now');
  b = board(r.ctx);
  const final = readArtifact(r.ctx, b, math.id);
  assert.equal(final.source, 'snapshot');
  assert.match(final.text, /final/);
  const early = readArtifact(r.ctx, b, math.id, { version: 0 });
  assert.equal(early.kind, 'unavailable', 'never shows the final file for an earlier version');
  const diff = readArtifact(r.ctx, b, math.id, { view: 'diff' });
  assert.equal(diff.source, 'changes.patch');
  assert.match(diff.text, /final/);
  const prev = readArtifact(r.ctx, b, math.id, { view: 'diff', version: 1, against: 'prev' });
  assert.equal(prev.source, 'artifacts/round-1.patch');
  const hist = readArtifact(r.ctx, b, math.id, { view: 'history' });
  assert.deepEqual(hist.versions.map((v) => v.available), [false, true]);
});

test('file API security: ids only, no traversal, no symlinks, no secrets, size limits', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const run = wf.startRun(r.ctx, { title: 'Sec', request: 'x' });
  const outside = path.join(r.root, 'outside.md');
  writeFileSync(outside, 'secret outside the run');
  symlinkSync(outside, path.join(run.runDir, 'link.md'));
  mkdirSync(path.join(run.runDir, 'notes'));
  writeFileSync(path.join(run.runDir, 'notes/.env'), 'KEY=1');
  writeFileSync(path.join(run.runDir, 'big.txt'), 'x'.repeat(r.ctx.config.files.maxBytes + 1));
  writeFileSync(path.join(run.runDir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  wf.syncArtifacts(r.ctx);
  let b = board(r.ctx);
  assert.equal(byPath(b, 'link.md'), undefined, 'symlinks are not even listed');
  assert.equal(byPath(b, 'notes/.env'), undefined, 'dotfiles are not listed');
  assert.equal(readArtifact(r.ctx, b, byPath(b, 'big.txt').id).kind, 'too-large');
  assert.equal(readArtifact(r.ctx, b, byPath(b, 'blob.bin').id).kind, 'binary');
  assert.equal(downloadArtifact(r.ctx, b, byPath(b, 'blob.bin').id).buf.length, 6);

  rejects(() => readArtifact(r.ctx, b, '../../etc/passwd'), 400);
  rejects(() => readArtifact(r.ctx, b, 'a0000000000000000'), 404);
  // a forged registry entry still cannot leave the run directory
  const forge = (p, extra = {}) => {
    const id = artifactId(b.runId, 'run', p);
    b.artifacts.push({ id, runId: b.runId, kind: 'run-file', path: p, fileType: 'markdown', status: 'READY', ...extra });
    return id;
  };
  rejects(() => readArtifact(r.ctx, b, forge('../../outside.md')), 400);
  rejects(() => readArtifact(r.ctx, b, forge('/etc/passwd')), 400);
  rejects(() => readArtifact(r.ctx, b, forge('link.md')), 403);
  rejects(() => readArtifact(r.ctx, b, forge('notes/.env')), 403);
  rejects(() => readArtifact(r.ctx, b, forge('x.md', { runId: 'someone-else' })), 403);
  assert.equal(readArtifact(r.ctx, b, forge('gone.md')).kind, 'unavailable', 'missing file');
  assert.equal(safeRelative('a/../b'), null);
  assert.equal(safeRelative('a//b'), null);
  assert.equal(safeRelative('a/b.md'), 'a/b.md');

  // git files are read from commits only, never the working tree
  b = board(r.ctx);
  const id = artifactId(b.runId, 'git', 'lib/math.js');
  b.artifacts.push({ id, runId: b.runId, kind: 'git-file', path: 'lib/math.js', fileType: 'javascript', status: 'READY', versions: [{ round: 0, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', change: 'M' }] });
  assert.equal(readArtifact(r.ctx, b, id).kind, 'unavailable');
});

test('patch sections are extracted per file', () => {
  const patch = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/c.js b/d.js\nsimilarity index 90%\nrename from c.js\nrename to d.js\n';
  assert.match(patchSection(patch, 'a.js'), /^\+b$/m);
  assert.match(patchSection(patch, 'd.js', 'c.js'), /rename to d\.js/);
  assert.equal(patchSection(patch, 'zzz.js'), null);
});
