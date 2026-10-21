// Scratch repositories for the factory tests. Nothing here touches the real
// checkout: every repo is created under FACTORY_TEST_TMP (or the OS temp dir).

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REAL_FACTORY = path.resolve(HERE, '..');

export const tmpRoot = () => {
  const base = process.env.FACTORY_TEST_TMP || os.tmpdir();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(path.join(base, 'factory-test-'));
};

export function sh(cwd, cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, ...opts });
}
export const g = (cwd, ...args) => sh(cwd, 'git', args).trim();

export const EXCLUDE_BLOCK = `
# ============================================
# CLAUDE CODE SOFTWARE FACTORY — LOCAL ONLY
# ============================================

/factory/
/node_modules
/worker/node_modules
`;

// A small app repository with the factory installed (excluded) inside it,
// and the human's own staged, unstaged and untracked changes.
export function makeRepo({ humanChanges = true, usageSources = [] } = {}) {
  const root = tmpRoot();
  const repo = path.join(root, 'repo');
  mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 'factory-test@example.com');
  g(repo, 'config', 'user.name', 'Factory Test');
  g(repo, 'config', 'commit.gpgsign', 'false');
  g(repo, 'config', 'core.hooksPath', '/dev/null');
  mkdirSync(path.join(repo, 'app'));
  mkdirSync(path.join(repo, 'lib'));
  mkdirSync(path.join(repo, 'worker'));
  writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(path.join(repo, 'app/page.js'), 'export default function Page() {\n  return null;\n}\n');
  writeFileSync(path.join(repo, 'lib/math.js'), 'export const add = (a, b) => a + b;\n');
  writeFileSync(path.join(repo, 'lib/notes.md'), '# Notes\n\nline one\nline two\nline three\n');
  writeFileSync(path.join(repo, 'worker/index.js'), 'console.log("worker");\n');
  g(repo, 'add', '-A');
  g(repo, 'commit', '-q', '-m', 'initial');
  mkdirSync(path.join(repo, 'node_modules/dep'), { recursive: true });
  writeFileSync(path.join(repo, 'node_modules/dep/index.js'), '');
  mkdirSync(path.join(repo, 'worker/node_modules'), { recursive: true });

  appendFileSync(path.join(repo, '.git/info/exclude'), EXCLUDE_BLOCK);
  const factoryDir = path.join(repo, 'factory');
  mkdirSync(factoryDir);
  // The repository's own overrides; agents and plugins come from the plugin.
  writeFileSync(path.join(factoryDir, 'config.json'), JSON.stringify({ usage: { sources: usageSources }, worktree: { links: ['node_modules', 'worker/node_modules'] } }, null, 2));
  writeFileSync(path.join(factoryDir, 'house-rules.md'), '# House rules\n\nA scratch repository.\n');

  if (humanChanges) {
    writeFileSync(path.join(repo, 'app/page.js'), 'export default function Page() {\n  return "human edit";\n}\n');
    writeFileSync(path.join(repo, 'worker/index.js'), 'console.log("worker, staged by the human");\n');
    g(repo, 'add', 'worker/index.js');
    writeFileSync(path.join(repo, 'scratch-notes.txt'), 'untracked human file\n');
  }
  const ctx = { repoDir: repo, factoryDir, config: loadConfig(factoryDir) };
  return { root, repo, factoryDir, ctx, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const read = (p) => readFileSync(p, 'utf8');
export const write = (p, text) => {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, text);
};

export const report = (area, result, findings = []) =>
  `Review: ${area}\nResult: ${result}\n\n## Findings\n${findings.map((f, i) => `${i + 1}. **[${f[0]}]** \`lib/math.js:1\` — ${f[1]}`).join('\n') || 'None.'}\n\n## Checked\n- everything\n`;

// Drive a run up to "reviews pending" with one builder round.
export function startAndBuild(wf, ctx, { files = { 'lib/math.js': 'export const add = (a, b) => a + b;\nexport const sub = (a, b) => a - b;\n', 'lib/math.test.js': 'import test from "node:test";\n' } } = {}) {
  const run = wf.startRun(ctx, { title: 'Add subtraction helper', request: 'Please add a sub() helper to lib/math.js with a test.', sessionId: 'orch-session' });
  wf.agentStart(ctx, 'spec-writer', { agentId: 'aspec' });
  write(path.join(run.runDir, 'spec.md'), '# Spec\n\n1. AC1 sub works\n');
  write(path.join(run.runDir, 'plan.md'), '# Plan\n\n- edit lib/math.js\n');
  wf.agentDone(ctx, 'spec-writer');
  wf.agentStart(ctx, 'builder', { agentId: 'abuild' });
  for (const [rel, text] of Object.entries(files)) write(path.join(run.worktreeAbs, rel), text);
  write(path.join(run.runDir, 'build.md'), '# Build\n\nChanged: lib/math.js, lib/math.test.js\n');
  wf.agentDone(ctx, 'builder');
  const round = wf.commitRound(ctx);
  return { run, round };
}

export function reviewAll(wf, ctx, runDir, results) {
  const start = wf.reviewStart(ctx);
  for (const role of ['security', 'ux', 'ui-design', 'code']) wf.agentStart(ctx, role, { agentId: `a${role.replace('-', '')}${start.pass}`, pass: start.pass });
  for (const [role, area] of [['security', 'security'], ['ux', 'ux'], ['ui-design', 'ui-design'], ['code', 'code']]) {
    const r = results[area] ?? ['PASS'];
    if (r !== 'MISSING') write(path.join(runDir, 'reviews', `pass-${start.pass}`, `${area}.md`), report(area, r[0], r[1] ?? []));
    wf.agentDone(ctx, role);
  }
  return { ...start, outcome: wf.reviewOutcome(ctx) };
}
