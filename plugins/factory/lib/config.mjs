// Where the factory lives and what its configuration says. The plugin holds
// the code, the agents and the defaults (config.json next to this folder);
// each repository holds its own state and overrides in <repo>/factory/.
// Every function takes its roots explicitly so tests can point it at a
// scratch repository.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './fsutil.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PLUGIN_DIR = path.resolve(HERE, '..');

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return cwd;
  }
}

export const DEFAULT_REPO_DIR = process.env.FACTORY_REPO ? path.resolve(process.env.FACTORY_REPO) : gitRoot(process.cwd());
export const DEFAULT_FACTORY_DIR = process.env.FACTORY_DIR ? path.resolve(process.env.FACTORY_DIR) : path.join(DEFAULT_REPO_DIR, 'factory');

export const expandHome = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export function factoryPaths(factoryDir = DEFAULT_FACTORY_DIR) {
  return {
    factoryDir,
    board: path.join(factoryDir, 'board.json'),
    usage: path.join(factoryDir, 'usage.json'),
    config: path.join(factoryDir, 'config.json'),
    houseRules: path.join(factoryDir, 'house-rules.md'),
    runs: path.join(factoryDir, 'runs'),
    worktrees: path.join(factoryDir, 'worktrees'),
    cache: path.join(factoryDir, '.cache'),
  };
}

// Claude Code keeps a project's session records in
// <profile>/projects/<repo path, every non-alphanumeric character as "-">,
// for each profile directory (~/.claude, ~/.claude-<name>). Only directories
// that exist are returned.
export function defaultUsageSources(repoDir, home = os.homedir()) {
  const slug = path.resolve(repoDir).replace(/[^A-Za-z0-9]/g, '-');
  let profiles = [];
  try {
    profiles = readdirSync(home).filter((d) => /^\.claude(-[^/]+)?$/.test(d));
  } catch {
    profiles = [];
  }
  return profiles.map((p) => path.join(home, p, 'projects', slug)).filter((d) => existsSync(d));
}

// The plugin's defaults with the repository's factory/config.json on top.
// Agents and required plugins always come from the plugin: they must match
// its agent files.
export function loadConfig(factoryDir = DEFAULT_FACTORY_DIR, { pluginDir = PLUGIN_DIR, repoDir = path.dirname(factoryDir) } = {}) {
  const base = readJson(path.join(pluginDir, 'config.json'), {}) ?? {};
  const raw = readJson(factoryPaths(factoryDir).config, {}) ?? {};
  const pick = (k) => ({ ...(base[k] ?? {}), ...(raw[k] ?? {}) });
  const usage = { staleMs: 8000, pricing: null, ...pick('usage') };
  if (!Array.isArray(usage.sources)) usage.sources = defaultUsageSources(repoDir);
  const revisionMax = [raw.revisionMax, base.revisionMax].find(Number.isInteger) ?? 2;
  return {
    dashboard: { host: '127.0.0.1', port: 4100, pollMs: 2000, usagePollMs: 5000, ...pick('dashboard') },
    revisionMax,
    agents: base.agents ?? {},
    usage,
    files: { maxBytes: 512 * 1024, ...pick('files') },
    worktree: { links: ['node_modules'], ...pick('worktree') },
    plugins: { required: [], bundled: [], orchestratorSkills: [], ...(base.plugins ?? {}) },
  };
}

// Roles in workflow order, with their area for reviewers.
export const reviewRoles = (config) => Object.entries(config.agents).filter(([, a]) => a.stage === 'review').map(([role, a]) => ({ role, ...a }));
export const roleForAgentName = (config, agentName) =>
  Object.entries(config.agents).find(([, a]) => a.agent === agentName)?.[0] ?? null;

// The definition file of a configured agent ("factory:builder" → agents/builder.md).
export const agentFile = (agentName, pluginDir = PLUGIN_DIR) => path.join(pluginDir, 'agents', `${agentName.split(':').pop()}.md`);
