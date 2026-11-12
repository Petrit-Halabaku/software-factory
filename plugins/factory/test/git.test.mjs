// Git safety, on scratch repositories that carry staged, unstaged and
// untracked human changes. Never runs against the real checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as wf from '../lib/workflow.mjs';
import { checkExclusions } from '../lib/exclude.mjs';
import { indexFingerprint, isSecretPath, pendingOperations, secretLines } from '../lib/git.mjs';
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

test('init: a new config links only dependency directories that exist and are untracked; preflight warns, never blocks', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  rmSync(path.join(r.factoryDir, 'config.json'));
  write(path.join(r.repo, 'vendor/lib.js'), 'x');
  g(r.repo, 'add', 'vendor/lib.js');
  g(r.repo, 'commit', '-q', '-m', 'vendor');
  const ctx = { ...r.ctx, config: { ...r.ctx.config, worktree: { links: ['node_modules', 'missing_modules', 'vendor'] } } };
  const init = wf.initRepo(ctx, { templateFile: path.join(r.factoryDir, 'house-rules.md') });
  assert.deepEqual(init.links, ['node_modules'], 'missing and tracked directories are left out');
  assert.deepEqual(JSON.parse(read(path.join(r.factoryDir, 'config.json'))).worktree.links, ['node_modules']);

  writeFileSync(path.join(r.factoryDir, 'house-rules.md'), '# Rules\n\n<!-- UNCONFIRMED: no protected paths found -->\n');
  appendFileSync(path.join(r.repo, '.git/info/exclude'), '/missing_modules\n');
  const pf = wf.preflight({ ...ctx, config: { ...ctx.config, worktree: { links: ['node_modules', 'missing_modules'] } } });
  assert.equal(pf.ok, true, pf.problems.join('\n'));
  assert.ok(pf.warnings.some((w) => w.includes('missing_modules does not exist')));
  assert.ok(pf.warnings.some((w) => w.includes('not confirmed by the human: no protected paths found')));
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

test('preflight lists the human\'s uncommitted work only when asked', (t) => {
  const r = makeRepo();
  t.after(r.cleanup);
  assert.equal('dirty' in wf.preflight(r.ctx), false, 'the per-round checks stay cheap');
  const d = wf.preflight(r.ctx, { dirty: true }).dirty;
  assert.deepEqual(d.paths.slice().sort(), [' M app/page.js', '?? scratch-notes.txt', 'M  worker/index.js']);
  assert.equal(d.count, 3);
  assert.equal(d.staged, 1);
  assert.equal(d.truncated, false);
});

test('secret paths and credential-looking lines: real formats are refused, placeholders and local hosts are not', () => {
  for (const p of ['.env', 'apps/web/.env.local', '.envrc', 'worker/.dev.vars', '.git-credentials', '.pypirc', 'infra/prod.tfvars',
    'infra/terraform.tfstate', 'infra/terraform.tfstate.backup', 'keys/AuthKey_ABC.p8', 'svc.keytab', 'kubeconfig', 'id_ed25519', 'certs/server.key',
    '.env-prod', 'apps/api/.env_local', 'deploy/prod.env', 'keys/deploy.ppk', 'vpn/office.ovpn', 'infra/prod.auto.tfvars.json', '.terraformrc',
    '.ssh/config', 'home/.gnupg/pubring.kbx', '.kube/config', 'ci/.docker/config.json']) {
    assert.equal(isSecretPath(p), true, p);
  }
  for (const p of ['.env.example', 'infra/prod.tfvars.example', 'lib/env.js', 'docs/secrets.md', 'kubeconfig.md', 'src/keys.ts',
    '.env-example', 'deploy/sample.env', 'config/env.ts', 'docs/ssh/config.md', 'src/docker/config.json', 'kube/config.yaml']) {
    assert.equal(isSecretPath(p), false, p);
  }

  // Every token is assembled at run time so no key-shaped literal sits in the source.
  const r = (n, chars = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7') => chars.repeat(Math.ceil(n / chars.length)).slice(0, n);
  const lines = (file, ...added) => `+++ b/${file}\n${added.map((l) => `+${l}`).join('\n')}\n`;
  const caught = [
    ['github_pat', `github_pat_${r(60)}`],
    ['glpat', `glpat-${r(24)}`],
    ['npm', `npm_${r(36)}`],
    ['openai project', `sk-proj-${r(40)}`],
    ['stripe webhook', `whsec_${r(32)}`],
    ['aws temporary', `ASIA${'ABCDEFGHIJKLMNOP'}`],
    ['slack webhook', ['https://hooks.slack.com/services', `T${r(8).toUpperCase()}`, `B${r(8).toUpperCase()}`, r(24)].join('/')],
    ['sendgrid', ['SG', r(22), r(43)].join('.')],
    ['encrypted key', ['-----BEGIN', 'ENCRYPTED PRIVATE KEY-----'].join(' ')],
    ['pgp key block', ['-----BEGIN PGP', 'PRIVATE KEY BLOCK-----'].join(' ')],
    ['google oauth secret', `GOCSPX-${r(28)}`],
    ['digitalocean', `dop_v1_${'0a1b2c3d'.repeat(8)}`],
    ['hugging face', `hf_${r(34)}`],
    ['shopify', `shpat_${'0a1b2c3d'.repeat(4)}`],
    ['supabase access token', `sbp_${'0a1b2c3d4e'.repeat(4)}`],
    ['supabase secret key', `sb_secret_${r(24)}`],
    ['pypi', ['pypi', `AgEIcHlwaS5vcmc${r(60)}`].join('-')],
    ['telegram bot', `${'12345678'}:AA${r(33)}`],
    ['registry token', `//registry.npmjs.org/:_authToken=${r(36)}`],
    ['remote db url', `DATABASE_URL=${['postgres://app', `${r(12)}@db.prod-cluster.net:5432/app`].join(':')}`],
    ['remote db ip', `${['mongodb://svc', `${r(10)}@10.20.30.40/app`].join(':')}`],
  ];
  for (const [what, line] of caught) assert.deepEqual(secretLines(lines('lib/config.js', line)), ['lib/config.js'], what);

  const allowed = [
    ['local db', ['postgres://postgres', 'postgres@localhost:5432/test'].join(':')],
    ['loopback db', ['mysql://root', 'rootpw@127.0.0.1/app'].join(':')],
    ['compose service name', ['postgres://app', 'app@db:5432/app'].join(':')],
    ['env placeholder', ['postgres://app', '${DB_PASSWORD}@db.prod-cluster.net/app'].join(':')],
    ['example domain', ['postgres://user', 'password@db.example.com/app'].join(':')],
    ['short prefix only', 'const prefix = "sk-proj-";'],
    ['pgp public key', ['-----BEGIN PGP', 'PUBLIC KEY BLOCK-----'].join(' ')],
    ['registry token from the environment', '//registry.npmjs.org/:_authToken=${NPM_TOKEN}'],
    ['a function name', 'const file = hf_hub_download(repo_id, filename);'],
    ['a number and a colon', 'chat 12345678: AA batteries included'],
    ['prose', 'Set GITHUB_TOKEN in your environment; never commit it.'],
  ];
  for (const [what, line] of allowed) assert.deepEqual(secretLines(lines('lib/config.js', line)), [], what);
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
  assert.match(read(path.join(run.runDir, 'escalation.md')), /limit of 2 automatic revision rounds\./);
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

test('the escalation file states the configured revision limit, not a fixed one', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const ctx = { ...r.ctx, config: { ...r.ctx.config, revisionMax: 1 } };
  const { run } = startAndBuild(wf, ctx);
  wf.escalate(ctx, { by: 'orchestrator', reason: 'needs a decision' });
  assert.match(read(path.join(run.runDir, 'escalation.md')), /limit of 1 automatic revision round\./);
});

test('preflight warns when a container build or npm publish would take factory/ along, and never blocks on it', (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  const packaging = () => wf.preflight(r.ctx).warnings.filter((w) => w.includes('factory/'));
  assert.deepEqual(packaging(), [], 'no container file and no package.json: nothing to warn about');

  write(path.join(r.repo, 'Dockerfile'), 'FROM scratch\nCOPY . .\n');
  write(path.join(r.repo, 'package.json'), JSON.stringify({ name: 'lib', version: '1.0.0' }));
  let w = packaging();
  assert.equal(w.length, 2);
  assert.match(w[0], /\.dockerignore/);
  assert.match(w[1], /npm publish/);
  assert.equal(wf.preflight(r.ctx).ok, true, 'warnings never block a run');

  write(path.join(r.repo, '.dockerignore'), 'node_modules\n/factory/\n');
  write(path.join(r.repo, 'package.json'), JSON.stringify({ name: 'app', private: true }));
  assert.deepEqual(packaging(), [], 'an ignore line and a private package');

  write(path.join(r.repo, '.dockerignore'), '# everything out, then the app back in\n*\n!src\n');
  write(path.join(r.repo, 'package.json'), JSON.stringify({ name: 'lib', files: ['dist'] }));
  assert.deepEqual(packaging(), [], 'an allow-list and a "files" list');

  write(path.join(r.repo, '.dockerignore'), 'factory-old\n!factory\n');
  write(path.join(r.repo, 'package.json'), JSON.stringify({ name: 'lib' }));
  write(path.join(r.repo, '.npmignore'), 'factory\n');
  w = packaging();
  assert.equal(w.length, 1, 'a near-miss pattern does not count; an .npmignore line does');
  assert.match(w[0], /\.dockerignore/);
});
