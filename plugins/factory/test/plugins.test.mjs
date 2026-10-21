// The plugin check: parsing agent skill lists and planning the commands that
// install, enable or update what the agents need. Never calls the claude CLI.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { agentSkills, checkPlugins, namedSkills, planPlugins } from '../lib/plugins.mjs';
import { REAL_FACTORY } from './helpers.mjs';

const REQUIRED = [
  { id: 'superpowers@claude-plugins-official', marketplace: 'anthropics/claude-plugins-official' },
  { id: 'understand-anything@understand-anything', marketplace: 'Lum1104/Understand-Anything' },
];
const enabled = (id) => ({ id, enabled: true, installPath: `/plugins/${id}` });
const plan = (over = {}) =>
  planPlugins({
    required: REQUIRED,
    bundled: ['code-review'],
    installed: REQUIRED.map((r) => enabled(r.id)),
    marketplaces: ['claude-plugins-official', 'understand-anything'],
    skills: {},
    hasSkill: () => true,
    hasUserSkill: () => false,
    repoDir: '/repo',
    ...over,
  });

test('agentSkills: block list, inline list, quoted names, none', () => {
  const block = '---\nname: x\nskills:\n  - superpowers:test-driven-development\n  - "code-review"\nmodel: opus\n---\nbody\n  - not-a-skill\n';
  assert.deepEqual(agentSkills(block), ['superpowers:test-driven-development', 'code-review']);
  assert.deepEqual(agentSkills('---\nskills: [a:b, c]\n---\n'), ['a:b', 'c']);
  assert.deepEqual(agentSkills('---\nname: x\n---\n'), []);
  assert.deepEqual(agentSkills('no frontmatter'), []);
});

test('planPlugins: everything present is ok', () => {
  const r = plan({ skills: { 'factory-builder': ['superpowers:test-driven-development', 'code-review'] } });
  assert.deepEqual(r, { ok: true, actions: [], problems: [] });
});

test('planPlugins: a missing plugin is installed, through its marketplace source when that is not added yet', () => {
  const r = plan({ installed: [enabled(REQUIRED[0].id)], marketplaces: ['claude-plugins-official'] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.actions, [{ plugin: REQUIRED[1].id, action: 'install', reason: 'not installed', command: 'claude plugin install understand-anything --marketplace Lum1104/Understand-Anything' }]);
  const known = plan({ installed: [enabled(REQUIRED[1].id)] });
  assert.equal(known.actions[0].command, 'claude plugin install superpowers@claude-plugins-official');
});

test('planPlugins: an installed but disabled plugin is enabled', () => {
  const r = plan({ installed: [enabled(REQUIRED[0].id), { id: REQUIRED[1].id, enabled: false, installPath: '/x' }] });
  assert.deepEqual(r.actions.map((a) => a.command), ['claude plugin enable understand-anything@understand-anything']);
});

test('planPlugins: a skill the installed version lacks asks for one update per plugin', () => {
  const r = plan({
    skills: { 'factory-builder': ['superpowers:new-skill', 'superpowers:other-new'], orchestrator: ['superpowers:test-driven-development'] },
    hasSkill: (p, s) => s === 'test-driven-development',
  });
  assert.deepEqual(r.actions, [{ plugin: REQUIRED[0].id, action: 'update', reason: 'the installed version ships no skill new-skill', command: 'claude plugin update superpowers@claude-plugins-official' }]);
});

test("planPlugins: another project's install does not count, this repo's project install wins over the user one", () => {
  const sp = REQUIRED[0].id;
  const elsewhere = { id: sp, enabled: true, installPath: '/old', projectPath: '/home' };
  const r = plan({ installed: [elsewhere, enabled(REQUIRED[1].id)] });
  assert.deepEqual(r.actions.map((a) => a.action), ['install']);
  const skills = { 'factory-builder': ['superpowers:tdd'] };
  const seen = [];
  const hasSkill = (p) => (seen.push(p), true);
  plan({ installed: [elsewhere, enabled(sp), { id: sp, enabled: true, installPath: '/mine', projectPath: '/repo' }, enabled(REQUIRED[1].id)], skills, hasSkill });
  plan({ installed: [elsewhere, enabled(sp), enabled(REQUIRED[1].id)], skills, hasSkill });
  assert.deepEqual(seen, ['/mine', `/plugins/${sp}`]);
});

test('planPlugins: skills from unlisted plugins and unknown bare skills are problems, user skills are fine', () => {
  const r = plan({ skills: { 'factory-code': ['vercel:nextjs', 'impeccable', 'mystery'] }, hasUserSkill: (s) => s === 'impeccable' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.actions, []);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /vercel:nextjs.*plugins\.required/);
  assert.match(r.problems[1], /mystery/);
});

test('the real agent files name only skills from required plugins or bundled ones', () => {
  const config = loadConfig(REAL_FACTORY);
  const skills = namedSkills(config, REAL_FACTORY);
  assert.ok(Object.values(skills).flat().length > 0, 'the agents preload skills');
  const r = planPlugins({
    required: config.plugins.required,
    bundled: config.plugins.bundled,
    installed: config.plugins.required.map((p) => enabled(p.id)),
    marketplaces: [],
    skills,
    hasSkill: () => true,
    hasUserSkill: () => false,
    repoDir: path.dirname(REAL_FACTORY),
  });
  assert.deepEqual(r.problems, []);
});

test('checkPlugins: reads the CLI through the injected lister', () => {
  const config = loadConfig(REAL_FACTORY);
  const calls = [];
  const list = (args) => {
    calls.push(args.join(' '));
    return args.includes('marketplace') ? [] : config.plugins.required.map((p) => enabled(p.id));
  };
  const r = checkPlugins({ repoDir: path.dirname(REAL_FACTORY), config, pluginDir: REAL_FACTORY }, { list });
  assert.deepEqual(calls, ['plugin list', 'plugin marketplace list']);
  assert.ok(r.skills['factory:builder'].length > 0);
});
