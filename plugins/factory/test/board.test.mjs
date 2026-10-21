import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { agentFile, loadConfig } from '../lib/config.mjs';
import { emptyBoard, normalizeBoard, parseApproval, parseFindings, parseReviewReport, readBoard, RUN_STATUSES, stageAt } from '../lib/board.mjs';
import * as wf from '../lib/workflow.mjs';
import { REAL_FACTORY, makeRepo, reviewAll, startAndBuild, tmpRoot, write } from './helpers.mjs';

const config = loadConfig(REAL_FACTORY);

test('the idle board', () => {
  const b = emptyBoard(config);
  assert.equal(b.status, 'IDLE');
  assert.equal(b.runId, null);
  assert.deepEqual(Object.values(b.stages), Array(7).fill('PENDING'));
  assert.deepEqual(Object.keys(b.agents), ['spec-writer', 'builder', 'security', 'ux', 'ui-design', 'code', 'approver']);
  assert.deepEqual(b.revision, { round: 0, max: 2, human: 0, pending: null });
  assert.deepEqual(RUN_STATUSES, ['IDLE', 'RUNNING', 'WAITING_FOR_HUMAN', 'APPROVED', 'MERGED', 'STOPPED']);
});

test('agent names and models: config, agent definitions and the board agree', () => {
  const expected = { 'spec-writer': 'opus', builder: 'opus', security: 'opus', ux: 'sonnet', 'ui-design': 'sonnet', code: 'sonnet', approver: 'opus' };
  for (const [role, model] of Object.entries(expected)) {
    const cfg = config.agents[role];
    assert.equal(cfg?.model, model, `config model for ${role}`);
    assert.equal(cfg.agent, `factory:${role}`, `config agent name for ${role}`);
    const file = agentFile(cfg.agent, REAL_FACTORY);
    assert.ok(existsSync(file), `${file} exists`);
    const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(file, 'utf8'))?.[1] ?? '';
    const field = (k) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm)?.[1].trim();
    assert.equal(field('name'), role, `${file}: name`);
    assert.equal(field('model'), model, `${file}: model`);
    assert.equal(emptyBoard(config).agents[role].model, model, `board model for ${role}`);
  }
  assert.equal(Object.keys(config.agents).length, 7);
  const skill = readFileSync(path.join(REAL_FACTORY, 'skills/factory/SKILL.md'), 'utf8');
  assert.match(skill, /^disable-model-invocation:\s*true$/m);
  const manifest = JSON.parse(readFileSync(path.join(REAL_FACTORY, '.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'factory', 'agents are addressed as factory:<name>');
});

test('invalid JSON, a non-object and missing fields', () => {
  const dir = tmpRoot();
  const file = path.join(dir, 'board.json');
  writeFileSync(file, '{ not json');
  let r = readBoard(file, config);
  assert.equal(r.ok, false);
  assert.equal(r.board.status, 'IDLE');
  assert.match(r.errors[0], /not valid JSON/);
  writeFileSync(file, '[]');
  assert.match(readBoard(file, config).errors[0], /not a JSON object/);
  r = normalizeBoard({ version: 2, status: 'RUNNING', runId: '20261021-1200-x' }, config);
  assert.equal(r.board.status, 'RUNNING');
  assert.equal(r.board.stages.spec, 'PENDING');
  assert.deepEqual(r.board.artifacts, []);
  assert.equal(r.board.agents.builder.status, 'IDLE');
  assert.equal(readBoard(path.join(dir, 'missing.json'), config).missing, true);
});

test('unknown values are reported, not trusted', () => {
  const { board, errors } = normalizeBoard({
    version: 2,
    status: 'DONE',
    stages: { spec: 'FINISHED' },
    agents: { builder: { status: 'RUNNING', model: 'haiku' }, intern: {} },
    revision: { round: 5 },
  }, config);
  assert.equal(board.status, 'IDLE');
  assert.equal(board.stages.spec, 'PENDING');
  assert.equal(board.agents.builder.model, 'opus', 'the configured model wins');
  assert.ok(errors.some((e) => e.includes('unknown status "DONE"')));
  assert.ok(errors.some((e) => e.includes('board says model haiku, config says opus')));
  assert.ok(errors.some((e) => e.includes('unknown agent role "intern"')));
  assert.ok(errors.some((e) => e.includes('exceeds the maximum')));
});

test('review reports: line 1 Review, line 2 Result, numbered findings', () => {
  const ok = parseReviewReport('Review: security\nResult: CHANGES\n\n1. **[blocker]** `lib/a.js:3` — tenant check missing\n2. [should-fix] log leaks the email\n3. Optional: rename x\n', 'security');
  assert.equal(ok.valid, true);
  assert.equal(ok.result, 'CHANGES');
  assert.deepEqual(ok.findings.map((f) => f.severity), ['blocker', 'should-fix']);
  assert.match(ok.findings[0].summary, /tenant check missing/);
  assert.equal(parseReviewReport('Result: PASS\nReview: ux\n', 'ux').valid, false, 'order matters');
  assert.equal(parseReviewReport('Review: ux\n\nResult: PASS\n', 'ux').valid, false, 'result must be line 2');
  assert.equal(parseReviewReport('Review: ux\nResult: MAYBE\n', 'ux').result, 'CHANGES');
  assert.equal(parseReviewReport('Review: code\nResult: PASS\n', 'ux').valid, false, 'wrong area');
  assert.equal(parseReviewReport('', 'ux').result, 'CHANGES');
  assert.deepEqual(parseFindings('1. nothing severe here'), []);
});

test('approval decision', () => {
  assert.deepEqual(parseApproval('# Approval\n\nDecision: APPROVE\n\n## Why\nAll good.\n'), { valid: true, decision: 'APPROVE', reason: 'All good.' });
  assert.equal(parseApproval('Decision: ESCALATE').decision, 'ESCALATE');
  const bad = parseApproval('Decision: yes');
  assert.equal(bad.valid, false);
  assert.equal(bad.decision, 'ESCALATE', 'unparsable means escalate');
});

test('stage transitions, review statuses and revision counting through a run', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const bpath = path.join(r.factoryDir, 'board.json');
  const { run } = startAndBuild(wf, r.ctx);
  let b = readBoard(bpath, r.ctx.config).board;
  assert.equal(b.status, 'RUNNING');
  assert.deepEqual([b.stages.request, b.stages.worktree, b.stages.spec, b.stages.build], ['DONE', 'DONE', 'DONE', 'DONE']);
  assert.equal(b.agents['spec-writer'].status, 'DONE');

  const start = wf.reviewStart(r.ctx);
  b = readBoard(bpath, r.ctx.config).board;
  assert.equal(b.stages.review, 'ACTIVE');
  assert.deepEqual(Object.values(b.reviews[0].results).map((x) => x.status), ['RUNNING', 'RUNNING', 'RUNNING', 'RUNNING']);
  wf.agentStart(r.ctx, 'ux', { agentId: 'aux1', pass: start.pass });
  write(path.join(run.runDir, 'reviews/pass-1/ux.md'), 'Review: ux\nResult: PASS\n');
  wf.agentDone(r.ctx, 'ux');
  b = readBoard(bpath, r.ctx.config).board;
  assert.equal(b.reviews[0].results.ux.status, 'PASS');
  assert.equal(b.artifacts.find((a) => a.path === 'reviews/pass-1/ux.md').status, 'READY', 'readable while the others still run');
  assert.equal(b.artifacts.find((a) => a.path === 'reviews/pass-1/code.md').status, 'PENDING');
  assert.throws(() => wf.reviewOutcome(r.ctx), /still waiting for: security, ui-design, code/);
  const tl = { timeline: [{ at: '2026-10-21T10:00:00Z', stage: 'spec', status: 'ACTIVE' }, { at: '2026-10-21T10:05:00Z', stage: 'spec', status: 'DONE' }, { at: '2026-10-21T10:06:00Z', stage: 'build', status: 'ACTIVE' }] };
  assert.deepEqual(['2026-10-21T09:59:00Z', '2026-10-21T10:03:00Z', '2026-10-21T10:05:30Z', '2026-10-21T11:00:00Z'].map((at) => stageAt(tl, at)), ['request', 'spec', 'spec', 'build']);

  // finish pass 1 with changes, then count revisions
  for (const role of ['security', 'ui-design', 'code']) {
    wf.agentStart(r.ctx, role, { pass: 1 });
    write(path.join(run.runDir, `reviews/pass-1/${role}.md`), `Review: ${role}\nResult: ${role === 'code' ? 'CHANGES' : 'PASS'}\n\n1. [blocker] x\n`);
    wf.agentDone(r.ctx, role);
  }
  assert.equal(wf.reviewOutcome(r.ctx).outcome, 'REVISE');
  wf.revise(r.ctx);
  b = readBoard(bpath, r.ctx.config).board;
  assert.equal(b.revision.round, 1);
  assert.equal(b.stages.build, 'ACTIVE');
  assert.equal(b.stages.review, 'CHANGES');
  assert.equal(b.requestedChanges.length, 1);
  wf.agentStart(r.ctx, 'builder', { agentId: 'abuild' });
  write(path.join(run.worktreeAbs, 'lib/math.js'), 'export const add = (a, b) => a + b; // r1\n');
  wf.agentDone(r.ctx, 'builder');
  wf.commitRound(r.ctx);
  const p2 = reviewAll(wf, r.ctx, run.runDir, {});
  assert.equal(p2.outcome.outcome, 'ALL_PASS');
  b = readBoard(bpath, r.ctx.config).board;
  assert.equal(b.reviews.length, 2);
  assert.equal(b.reviews[1].round, 1);
  assert.equal(b.stages.review, 'DONE');

  // a malformed approval escalates
  wf.agentStart(r.ctx, 'approver');
  write(path.join(run.runDir, 'approval.md'), 'looks fine to me');
  const ap = wf.agentDone(r.ctx, 'approver');
  assert.equal(ap.decision, 'ESCALATE');
  b = readBoard(bpath, r.ctx.config).board;
  assert.equal(b.stages.approve, 'BLOCKED');
  assert.equal(b.status, 'RUNNING');
  wf.escalate(r.ctx, { by: 'approver', reason: 'approval.md has no decision line' });
  b = readBoard(bpath, r.ctx.config).board;
  assert.equal(b.status, 'WAITING_FOR_HUMAN');
  assert.equal(b.approval.decision, 'ESCALATE');
  // board.json and run.json stay identical
  assert.deepEqual(JSON.parse(readFileSync(path.join(run.runDir, 'run.json'), 'utf8')), JSON.parse(readFileSync(bpath, 'utf8')));
});

test('a corrupt board is never overwritten', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  writeFileSync(path.join(r.factoryDir, 'board.json'), '{ broken');
  assert.throws(() => wf.addLog(r.ctx, 'x'), /refusing to overwrite a corrupt board/);
  assert.equal(readFileSync(path.join(r.factoryDir, 'board.json'), 'utf8'), '{ broken');
});
