// The plugins and skills the factory's agents rely on. Claude Code skips a
// skill named in an agent file's `skills:` list that it cannot find, with
// only a debug-log warning, so the orchestrator runs this check before every
// run and installs, enables or updates whatever is missing.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_DIR, agentFile } from './config.mjs';

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

// The `skills:` list in one agent file's frontmatter, as a YAML block list
// or an inline list.
export function agentSkills(text) {
  const lines = (/^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '').split('\n');
  const i = lines.findIndex((l) => /^skills:/.test(l));
  if (i < 0) return [];
  const inline = lines[i].replace(/^skills:\s*/, '').trim();
  if (inline) return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
  const out = [];
  for (const l of lines.slice(i + 1)) {
    const m = /^\s+-\s+(.+)$/.exec(l);
    if (!m) break;
    out.push(unquote(m[1]));
  }
  return out;
}

// Every skill the factory names, by who uses it: each agent's preloads and
// the skills the orchestrator loads itself.
export function namedSkills(config, pluginDir = PLUGIN_DIR) {
  const byAgent = {};
  for (const a of Object.values(config.agents)) {
    const file = agentFile(a.agent, pluginDir);
    byAgent[a.agent] = existsSync(file) ? agentSkills(readFileSync(file, 'utf8')) : [];
  }
  byAgent.orchestrator = config.plugins.orchestratorSkills;
  return byAgent;
}

export const pluginShipsSkill = (installPath, skill) =>
  existsSync(path.join(installPath, 'skills', skill, 'SKILL.md')) || existsSync(path.join(installPath, 'commands', `${skill}.md`));

// Pure. `installed` is `claude plugin list --json`, `marketplaces` the names
// of the marketplaces already added. Returns the commands that fix what is
// missing, and the problems no command can fix (a skill from a plugin the
// config does not require, or an unknown skill).
export function planPlugins({ required, bundled, installed, marketplaces, skills, hasSkill, hasUserSkill, repoDir }) {
  const actions = [];
  const problems = [];
  // A project-scoped install counts only for its own project; the list
  // reports other projects' installs too, enabled or not.
  const here = installed.filter((p) => !p.projectPath || path.resolve(p.projectPath) === path.resolve(repoDir));
  const enabledEntry = (id) => here.find((p) => p.id === id && p.enabled && p.projectPath) ?? here.find((p) => p.id === id && p.enabled);
  for (const r of required) {
    const [name, market] = r.id.split('@');
    if (!here.some((p) => p.id === r.id)) {
      const command = marketplaces.includes(market) ? `claude plugin install ${r.id}` : `claude plugin install ${name} --marketplace ${r.marketplace}`;
      actions.push({ plugin: r.id, action: 'install', reason: 'not installed', command });
    } else if (!enabledEntry(r.id)) {
      actions.push({ plugin: r.id, action: 'enable', reason: 'installed but disabled', command: `claude plugin enable ${r.id}` });
    }
  }
  for (const [agent, names] of Object.entries(skills)) {
    for (const skill of names) {
      if (!skill.includes(':')) {
        if (!bundled.includes(skill) && !hasUserSkill(skill)) problems.push(`${agent} names the skill ${skill}, which is neither bundled with Claude Code nor in the skills folder`);
        continue;
      }
      const [plugin, local] = skill.split(':');
      const r = required.find((x) => x.id.split('@')[0] === plugin);
      if (!r) {
        problems.push(`${agent} names ${skill}, but config.json plugins.required does not list the plugin ${plugin}`);
        continue;
      }
      const entry = enabledEntry(r.id);
      if (!entry || hasSkill(entry.installPath, local)) continue;
      if (!actions.some((a) => a.plugin === r.id)) {
        actions.push({ plugin: r.id, action: 'update', reason: `the installed version ships no skill ${local}`, command: `claude plugin update ${r.id}` });
      }
    }
  }
  return { ok: actions.length === 0 && problems.length === 0, actions, problems };
}

function claudeJson(args) {
  const r = spawnSync('claude', [...args, '--json'], { encoding: 'utf8', timeout: 60_000 });
  if (r.error || r.status !== 0) {
    const e = new Error(`claude ${args.join(' ')} failed: ${r.error?.message ?? r.stderr.trim()}`);
    e.code = 'PLUGINS';
    throw e;
  }
  return JSON.parse(r.stdout);
}

// Checks the Claude profile this process runs under (CLAUDE_CONFIG_DIR, or
// ~/.claude).
export function checkPlugins(ctx, { list = claudeJson } = {}) {
  const configDir = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude');
  const skills = namedSkills(ctx.config, ctx.pluginDir);
  const plan = planPlugins({
    required: ctx.config.plugins.required,
    bundled: ctx.config.plugins.bundled,
    installed: list(['plugin', 'list']),
    marketplaces: list(['plugin', 'marketplace', 'list']).map((m) => m.name),
    skills,
    hasSkill: pluginShipsSkill,
    hasUserSkill: (s) => existsSync(path.join(configDir, 'skills', s, 'SKILL.md')),
    repoDir: ctx.repoDir,
  });
  return { ...plan, profile: configDir, skills };
}
