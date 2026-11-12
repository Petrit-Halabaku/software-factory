// The skill inventory, against a scratch profile and project. Never reads
// the real Claude Code profile.

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMAINS, TASKS, classify, inventory, parseFrontmatter } from '../skills/skill-finder/scripts/inventory.mjs';

const write = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const skill = (name, description, body = '') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

function scratch() {
  const root = mkdtempSync(path.join(process.env.FACTORY_TEST_TMP || os.tmpdir(), 'skill-finder-test-'));
  const profile = path.join(root, 'profile');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  mkdirSync(path.join(project, '.git'), { recursive: true });
  mkdirSync(bin);

  write(path.join(profile, 'skills', 'bug-hunt', 'SKILL.md'), skill('bug-hunt', 'Use when a test is failing or a bug needs a root cause, before proposing fixes.',
    'Run the suite:\n\n```bash\nfakevideo -i input.mp4\nmissingtool --check\ncd somewhere && ls\n```\n\nUse mcp__tracker__search_issues. Export ${TRACKER_API_KEY} first.'));
  write(path.join(profile, 'skills', 'broken', 'SKILL.md'), '---\nname: broken\ndescription: never closed\n');
  write(path.join(profile, 'commands', 'standup.md'), '---\ndescription: Draft a standup summary from recent commits.\n---\n\nSummarise.\n');
  for (const bucket of ['bucket-a', 'bucket-b']) write(path.join(profile, 'skills', 'synced', bucket, 'report-pdf', 'SKILL.md'), skill('report-pdf', 'Create and convert PDF documents and reports.'));

  const toolkit = path.join(root, 'cache', 'toolkit');
  write(path.join(toolkit, 'skills', 'review-helper', 'SKILL.md'), skill('review-helper', 'Review a branch for correctness and security issues.'));
  write(path.join(toolkit, 'commands', 'ship.md'), '---\ndescription: Deploy the current project to production.\n---\n\nShip it.\n');
  const elsewhere = path.join(root, 'cache', 'elsewhere');
  write(path.join(elsewhere, 'skills', 'other-project-only', 'SKILL.md'), skill('other-project-only', 'Debug failing tests in another project.'));
  write(path.join(profile, 'plugins', 'installed_plugins.json'), JSON.stringify({
    version: 2,
    plugins: {
      'toolkit@market': [{ scope: 'user', installPath: toolkit }],
      'elsewhere@market': [{ scope: 'project', projectPath: path.join(root, 'some-other-repo'), installPath: elsewhere }],
    },
  }));
  write(path.join(profile, 'settings.json'), JSON.stringify({ enabledPlugins: { 'toolkit@market': false } }));
  write(path.join(project, '.claude', 'skills', 'house-style', 'SKILL.md'), skill('house-style', 'Apply this repository\'s UI conventions to new screens.'));

  write(path.join(bin, 'fakevideo'), '#!/bin/sh\n');
  chmodSync(path.join(bin, 'fakevideo'), 0o755);
  return { root, profile, project, bin, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('finds user, synced, plugin and project skills; skips other projects\' installs; reports disabled plugins', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const r = inventory({ profile: s.profile, project: path.join(s.project, 'sub', 'dir'), all: true, env: { PATH: s.bin } });
  const names = r.skills.map((k) => k.name).sort();
  assert.deepEqual(names, ['broken', 'bug-hunt', 'house-style', 'report-pdf', 'standup', 'toolkit:review-helper', 'toolkit:ship']);
  assert.equal(r.project, s.project, 'the project root is the enclosing Git repository');
  assert.deepEqual(r.byScope, { user: 3, synced: 1, plugin: 2, project: 1 });
  assert.equal(r.skills.find((k) => k.name === 'standup').kind, 'command', 'a command in the profile is found too');
  const byName = Object.fromEntries(r.skills.map((k) => [k.name, k]));
  assert.equal(byName['report-pdf'].copies, 2, 'the same skill synced twice counts once');
  assert.equal(byName['toolkit:review-helper'].enabled, false);
  assert.equal(byName['toolkit:ship'].kind, 'command');
  assert.equal(byName.broken.parseError, 'frontmatter is not closed');
});

test('requirements: binaries on PATH, MCP servers, environment variables by name only', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const secret = 'value-that-must-never-appear';
  const r = inventory({ profile: s.profile, project: s.project, all: true, env: { PATH: s.bin, TRACKER_API_KEY: secret } });
  const hunt = r.skills.find((k) => k.name === 'bug-hunt');
  assert.deepEqual(hunt.requires.bins, [{ name: 'missingtool', found: false }, { name: 'fakevideo', found: true }], 'missing first; cd and ls are not prerequisites');
  assert.deepEqual(hunt.requires.mcp, ['tracker']);
  assert.deepEqual(hunt.requires.env, [{ name: 'TRACKER_API_KEY', set: true }]);
  assert.equal(JSON.stringify(r).includes(secret), false, 'no environment value in the output');

  const unset = inventory({ profile: s.profile, project: s.project, all: true, env: { PATH: s.bin } });
  assert.deepEqual(unset.skills.find((k) => k.name === 'bug-hunt').requires.env, [{ name: 'TRACKER_API_KEY', set: false }]);
});

test('ranking: the skill that fits the task comes first, and unrelated skills are left out', (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const r = inventory({ profile: s.profile, project: s.project, query: 'why is my login test failing', env: { PATH: s.bin } });
  assert.equal(r.skills[0].name, 'bug-hunt');
  assert.ok(r.skills[0].matched.includes('test') && r.skills[0].matched.includes('failing'));
  assert.ok(r.query.domains.includes('debugging') && r.query.domains.includes('testing'));
  assert.equal(r.skills.some((k) => k.name === 'house-style'), false);

  const pdf = inventory({ profile: s.profile, project: s.project, query: 'turn my notes into a PDF report', env: { PATH: s.bin } });
  assert.equal(pdf.skills[0].name, 'report-pdf');
});

test('classify and frontmatter parsing', () => {
  assert.deepEqual(classify('Animate the dark mode toggle'), { domains: ['design-ui', 'motion'], tasks: [] });
  assert.ok(classify('deploy to production and configure environment variables').tasks.includes('operate'));
  const fm = parseFrontmatter('---\nname: x\ndescription: >\n  Folded text\n  over lines.\nallowed-tools: [Read, "Bash"]\nrequires:\n  - binary: docker\n  - env: SOME_TOKEN\n---\nbody\n');
  assert.equal(fm.error, null);
  assert.equal(fm.data.description, 'Folded text over lines.');
  assert.deepEqual(fm.data['allowed-tools'], ['Read', 'Bash']);
  assert.deepEqual(fm.data.requires, [{ binary: 'docker' }, { env: 'SOME_TOKEN' }]);
  assert.equal(fm.body, 'body\n');
  assert.equal(parseFrontmatter('no frontmatter here').error, 'no frontmatter');
});

test('the domain and task tables in references/domains.md name exactly the script\'s vocabularies', () => {
  const doc = readFileSync(fileURLToPath(new URL('../skills/skill-finder/references/domains.md', import.meta.url)), 'utf8');
  const firstCells = (heading) => {
    const section = doc.split(/^## /m).find((part) => part.startsWith(`${heading}\n`)) ?? '';
    return section.split('\n').map((l) => /^\| ([a-z][a-z-]*) \|/.exec(l)?.[1]).filter(Boolean).sort();
  };
  assert.deepEqual(firstCells('Domains'), Object.keys(DOMAINS).sort());
  assert.deepEqual(firstCells('Tasks'), Object.keys(TASKS).sort());
});
