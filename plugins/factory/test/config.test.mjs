// Configuration: the plugin's defaults, a repository's overrides on top, and
// where Claude Code's session records for a repository are found.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { defaultUsageSources, loadConfig } from '../lib/config.mjs';
import { REAL_FACTORY, tmpRoot } from './helpers.mjs';

test('defaultUsageSources: every profile that has records for the repository, and nothing else', () => {
  const home = tmpRoot();
  const repo = '/work/My Repo.v2';
  const slug = '-work-My-Repo-v2';
  for (const p of ['.claude', '.claude-team', '.claude-alt']) mkdirSync(path.join(home, p, 'projects'), { recursive: true });
  mkdirSync(path.join(home, '.claude', 'projects', slug));
  mkdirSync(path.join(home, '.claude-team', 'projects', slug));
  mkdirSync(path.join(home, '.claudette', 'projects', slug), { recursive: true });
  assert.deepEqual(defaultUsageSources(repo, home).sort(), [path.join(home, '.claude', 'projects', slug), path.join(home, '.claude-team', 'projects', slug)].sort());
  assert.deepEqual(defaultUsageSources(repo, path.join(home, 'missing')), []);
});

test('loadConfig: plugin defaults, repository overrides on top, agents and plugins only from the plugin', () => {
  const root = tmpRoot();
  const factoryDir = path.join(root, 'factory');
  mkdirSync(factoryDir);
  writeFileSync(path.join(factoryDir, 'config.json'), JSON.stringify({
    dashboard: { port: 4200 }, revisionMax: 3, usage: { sources: ['/x'] }, worktree: { links: ['node_modules', 'web/node_modules'] },
    agents: { builder: { agent: 'evil', model: 'haiku' } }, plugins: { required: [] },
  }));
  const c = loadConfig(factoryDir, { pluginDir: REAL_FACTORY });
  assert.equal(c.dashboard.port, 4200);
  assert.equal(c.dashboard.host, '127.0.0.1');
  assert.equal(c.revisionMax, 3);
  assert.deepEqual(c.usage.sources, ['/x']);
  assert.equal(c.usage.staleMs, 8000);
  assert.deepEqual(c.worktree.links, ['node_modules', 'web/node_modules']);
  assert.equal(c.agents.builder.agent, 'factory:builder');
  assert.ok(c.plugins.required.length > 0);

  const bare = loadConfig(path.join(root, 'none', 'factory'), { pluginDir: REAL_FACTORY });
  assert.equal(bare.revisionMax, 2);
  assert.deepEqual(bare.worktree.links, ['node_modules']);
  assert.ok(Array.isArray(bare.usage.sources));
});
