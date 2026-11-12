#!/usr/bin/env node
// Inventory of the skills installed for one Claude Code profile and project,
// tagged by domain and task and ranked against a query.
//
//   node inventory.mjs [--query "words"] [--project DIR] [--profile DIR] [--limit N] [--all]
//
// Read-only. It reads SKILL.md and command files, the plugin registry and
// settings, and checks whether binaries are on PATH and whether environment
// variables are set. It never prints a variable's value.
//
// The session's own skill listing stays the authority on what the session can
// invoke. This adds what the listing lacks: where each skill lives, whether
// its plugin is enabled, and what it needs that may be missing here.

import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Domain and task vocabularies. A keyword of four or more characters also
// matches longer words that start with it ("debug" matches "debugging");
// shorter keywords match whole words only. Multi-word keywords match phrases.
export const DOMAINS = {
  'design-ui': ['design', 'ui', 'ux', 'layout', 'typography', 'colour', 'color', 'theme', 'dark mode', 'component', 'interface', 'visual', 'landing page', 'screen', 'polish', 'accessibility', 'a11y', 'responsive', 'tailwind', 'css', 'shadcn', 'toggle', 'button', 'modal', 'dialog', 'sidebar', 'navbar', 'dashboard'],
  motion: ['animation', 'animate', 'motion', 'transition', 'spring', 'easing', 'keyframe', 'gesture'],
  frontend: ['react', 'nextjs', 'next.js', 'vue', 'svelte', 'frontend', 'browser', 'dom', 'hydration', 'vite', 'webpack', 'turbopack', 'tsx'],
  'code-quality': ['review', 'refactor', 'simplify', 'lint', 'cleanup', 'quality', 'readability', 'maintainab', 'duplicat', 'dead code'],
  debugging: ['debug', 'bug', 'error', 'fail', 'crash', 'broken', 'regression', 'flaky', 'stack trace', 'root cause'],
  testing: ['test', 'tdd', 'coverage', 'e2e', 'playwright', 'jest', 'vitest', 'verif', 'qa'],
  planning: ['plan', 'spec', 'brainstorm', 'architect', 'requirement', 'roadmap', 'scope', 'design doc'],
  security: ['security', 'vulnerab', 'auth', 'authenticat', 'authoriz', 'secret', 'xss', 'csrf', 'injection', 'permission', 'rls'],
  data: ['database', 'sql', 'postgres', 'migration', 'schema', 'query', 'supabase', 'prisma', 'orm', 'redis'],
  'deploy-infra': ['deploy', 'hosting', 'vercel', 'ci', 'pipeline', 'docker', 'kubernetes', 'dns', 'domain', 'serverless', 'edge', 'cdn', 'cache', 'environment variable'],
  payments: ['stripe', 'payment', 'checkout', 'billing', 'subscription', 'invoice'],
  'design-tools': ['figma', 'figjam', 'mockup', 'wireframe', 'design system', 'design token'],
  documents: ['pdf', 'docx', 'word document', 'xlsx', 'excel', 'spreadsheet', 'pptx', 'powerpoint', 'slide', 'deck'],
  writing: ['research', 'summar', 'writing', 'copy', 'article', 'documentation', 'readme', 'changelog', 'prompt'],
  'ai-apps': ['llm', 'ai', 'agent', 'claude', 'anthropic', 'openai', 'model', 'rag', 'embedding', 'mcp', 'sdk'],
  'claude-code': ['claude code', 'skill', 'plugin', 'hook', 'settings.json', 'keybinding', 'statusline', 'slash command', 'subagent', 'workflow'],
  media: ['video', 'launch', 'demo', 'screenshot', 'image', 'gif', 'audio'],
  integrations: ['email', 'gmail', 'calendar', 'drive', 'slack', 'jira', 'linear', 'notion', 'github', 'crm', 'webhook'],
};

export const TASKS = {
  create: ['build', 'create', 'add', 'make', 'implement', 'generat', 'new', 'scaffold'],
  change: ['change', 'update', 'refactor', 'migrat', 'upgrad', 'rename', 'port', 'convert', 'improv', 'redesign'],
  review: ['review', 'audit', 'check', 'critique', 'inspect', 'assess', 'evaluat'],
  fix: ['fix', 'debug', 'repair', 'resolv', 'broken', 'fail', 'error', 'bug'],
  verify: ['test', 'verif', 'validat', 'prove', 'qa', 'confirm'],
  plan: ['plan', 'spec', 'brainstorm', 'architect', 'scope'],
  explain: ['explain', 'understand', 'learn', 'onboard', 'tour', 'teach'],
  operate: ['deploy', 'release', 'ship', 'publish', 'monitor', 'configur', 'setup', 'install'],
  write: ['write', 'draft', 'document', 'summar', 'report'],
};

const STOPWORDS = new Set(('a about after all also an and any app are as at be before best but by can could do does done find for from get gets good got help how i if in into is issue issues it its just keep keeps like make me more most my need not of on only or our please problem problems really should skill skills so some still than that the their them then there these thing things this those to too use using very want way we what when where which while why will with would x you your').split(' '));

// Shell words that say nothing about what a skill needs installed.
const NOT_A_PREREQUISITE = new Set(('alias awk basename bash break builtin case cat cd chmod chown command continue cp cut date declare diff dirname do done echo elif else env esac eval exec exit export false fi find for function grep head if in kill let ln local ls mkdir mktemp mv printf ps pwd read readlink realpath return rm rmdir sed set sh shift sleep sort source stat sudo tail tee test then time touch tr trap true type uniq unset until wait wc while xargs zsh').split(' '));

const tokenize = (text) => String(text).toLowerCase().match(/[a-z0-9][a-z0-9+#.]*/g)?.map((t) => t.replace(/\.+$/, '')) ?? [];

function keywordHit(keyword, tokens, text) {
  if (keyword.includes(' ') || keyword.includes('.')) return text.includes(keyword);
  return keyword.length >= 4 ? tokens.some((t) => t.startsWith(keyword)) : tokens.includes(keyword);
}

// "animating" and "animation", "debugging" and "debug", "tests" and "test".
const SUFFIXES = ['ations', 'ation', 'ments', 'ment', 'ings', 'ing', 'ers', 'er', 'ies', 'es', 'ed', 's'];
function stem(word) {
  if (word.length <= 5) return word;
  const suffix = SUFFIXES.find((s) => word.endsWith(s) && word.length - s.length >= 4);
  return suffix ? word.slice(0, -suffix.length) : word;
}
function termMatch(term, tokens) {
  if (term.length < 4) return tokens.includes(term);
  const a = stem(term);
  return tokens.some((t) => {
    if (t.length < 4) return false;
    const b = stem(t);
    return a.startsWith(b) || b.startsWith(a);
  });
}

export function classify(text) {
  const lower = String(text).toLowerCase();
  const tokens = tokenize(lower);
  const pick = (table) => Object.entries(table).filter(([, kws]) => kws.some((k) => keywordHit(k, tokens, lower))).map(([name]) => name);
  return { domains: pick(DOMAINS), tasks: pick(TASKS) };
}

// ---------------------------------------------------------------------------
// Frontmatter: the YAML subset skill files use (scalars, quoted strings,
// folded and literal blocks, simple lists, lists of one-key maps).

export function parseFrontmatter(text) {
  const lines = String(text).split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { data: {}, body: String(text), error: 'no frontmatter' };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { data: {}, body: String(text), error: 'frontmatter is not closed' };
  const data = {};
  const unquote = (v) => {
    const s = v.trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\"/g, '"');
    return s;
  };
  for (let i = 1; i < end; i++) {
    const m = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const block = [];
      while (i + 1 < end && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      data[key] = raw.startsWith('>') ? block.filter(Boolean).join(' ') : block.join('\n');
    } else if (raw === '') {
      const items = [];
      while (i + 1 < end && /^\s*-\s+/.test(lines[i + 1])) {
        const item = lines[++i].replace(/^\s*-\s+/, '');
        const kv = item.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        items.push(kv ? { [kv[1]]: unquote(kv[2]) } : unquote(item));
      }
      data[key] = items.length ? items : '';
    } else if (raw.startsWith('[') && raw.endsWith(']')) {
      data[key] = raw.slice(1, -1).split(',').map(unquote).filter(Boolean);
    } else data[key] = unquote(raw);
  }
  return { data, body: lines.slice(end + 1).join('\n'), error: null };
}

// ---------------------------------------------------------------------------
// What a skill needs to run, as checkable facts.

function onPath(bin, pathDirs) {
  return pathDirs.some((d) => {
    try {
      accessSync(path.join(d, bin), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

export function requirements(frontmatter, body, { env = process.env } = {}) {
  const text = String(body);
  const pathDirs = String(env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const mcp = [...new Set([...text.matchAll(/mcp__([A-Za-z0-9_-]+?)__[A-Za-z0-9_]/g)].map((m) => m[1]))];

  const bins = new Set();
  const npx = new Set();
  for (const r of frontmatter.requires ?? []) if (r && typeof r === 'object' && r.binary) bins.add(r.binary);
  for (const m of text.matchAll(/command -v ([A-Za-z0-9_.-]+)/g)) bins.add(m[1]);
  for (const m of text.matchAll(/\b(?:npm (?:i|install) -g|pnpm add -g|yarn global add|brew install|pipx install|cargo install|go install)\s+(@?[A-Za-z0-9_./-]+)/g)) {
    bins.add(m[1].split('/').pop().replace(/@.*$/, ''));
  }
  for (const m of text.matchAll(/\bnpx (?:-y |--yes )?(@?[A-Za-z0-9_./-]+(?:@[A-Za-z0-9_.-]+)?)/g)) npx.add(m[1]);
  // The first word of each command line in shell code blocks.
  for (const block of text.matchAll(/```(?:bash|sh|shell|zsh|console|terminal)\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const words = line.replace(/^\s*\$\s+/, '').trim().split(/\s+/).filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
      const w = words[0];
      if (w && /^[a-z][a-z0-9._-]+$/.test(w) && !NOT_A_PREREQUISITE.has(w)) bins.add(w);
    }
  }

  const envNames = new Set();
  for (const r of frontmatter.requires ?? []) if (r && typeof r === 'object' && r.env) envNames.add(r.env);
  for (const m of text.matchAll(/\$\{?([A-Z][A-Z0-9_]*(?:API_KEY|_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS))\b/g)) envNames.add(m[1]);

  const host = [];
  if (/desktop app/i.test(text)) host.push('desktop-app');
  if (/browser extension|chrome extension|claude in chrome/i.test(text)) host.push('browser-extension');
  if (/\bcomputer use\b/i.test(text)) host.push('computer-use');
  if (/\bcowork\b/i.test(text)) host.push('cowork');

  const binList = [...bins].sort().map((name) => ({ name, found: onPath(name, pathDirs) }));
  binList.sort((a, b) => Number(a.found) - Number(b.found));
  return {
    mcp,
    bins: binList.slice(0, 12),
    npx: [...npx].slice(0, 6),
    env: [...envNames].sort().map((name) => ({ name, set: Boolean(env[name]) })),
    host,
    allowedTools: frontmatter['allowed-tools'] ?? null,
    compatibility: frontmatter.compatibility ?? null,
  };
}

// ---------------------------------------------------------------------------
// Where skills live.

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const dirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
};
const mdFiles = (dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && !f.startsWith('.'));
  } catch {
    return [];
  }
};

export function projectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

function enabledPlugins(profile, project) {
  const merged = {};
  for (const f of [path.join(profile, 'settings.json'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')]) {
    Object.assign(merged, readJson(f)?.enabledPlugins ?? {});
  }
  return merged;
}

function candidateFiles({ profile, project }) {
  const out = [];
  const userSkills = path.join(profile, 'skills');
  for (const name of dirs(userSkills)) {
    if (name === 'synced') continue;
    out.push({ scope: 'user', kind: 'skill', name, file: path.join(userSkills, name, 'SKILL.md') });
  }
  for (const f of mdFiles(path.join(profile, 'commands'))) out.push({ scope: 'user', kind: 'command', name: f.slice(0, -3), file: path.join(profile, 'commands', f) });
  for (const bucket of dirs(path.join(userSkills, 'synced'))) {
    for (const name of dirs(path.join(userSkills, 'synced', bucket))) out.push({ scope: 'synced', kind: 'skill', name, file: path.join(userSkills, 'synced', bucket, name, 'SKILL.md') });
  }

  const enabled = enabledPlugins(profile, project);
  const registry = readJson(path.join(profile, 'plugins', 'installed_plugins.json'));
  for (const [id, installs] of Object.entries(registry?.plugins ?? {})) {
    const install = (Array.isArray(installs) ? installs : [installs]).find((r) => r && (!r.projectPath || path.resolve(r.projectPath) === project));
    if (!install?.installPath) continue;
    const plugin = id.split('@')[0];
    const state = id in enabled ? Boolean(enabled[id]) : null;
    for (const name of dirs(path.join(install.installPath, 'skills'))) {
      out.push({ scope: 'plugin', kind: 'skill', name: `${plugin}:${name}`, plugin: id, enabled: state, file: path.join(install.installPath, 'skills', name, 'SKILL.md') });
    }
    for (const f of mdFiles(path.join(install.installPath, 'commands'))) {
      out.push({ scope: 'plugin', kind: 'command', name: `${plugin}:${f.slice(0, -3)}`, plugin: id, enabled: state, file: path.join(install.installPath, 'commands', f) });
    }
  }

  for (const name of dirs(path.join(project, '.claude', 'skills'))) out.push({ scope: 'project', kind: 'skill', name, file: path.join(project, '.claude', 'skills', name, 'SKILL.md') });
  for (const f of mdFiles(path.join(project, '.claude', 'commands'))) out.push({ scope: 'project', kind: 'command', name: f.slice(0, -3), file: path.join(project, '.claude', 'commands', f) });
  return out.filter((c) => existsSync(c.file) && statSync(c.file).isFile());
}

// ---------------------------------------------------------------------------

function score(entry, queryTerms, query) {
  const nameTokens = tokenize(entry.name.replace(/[:_-]/g, ' '));
  const descTokens = tokenize(`${entry.description} ${entry.argumentHint ?? ''}`);
  const matched = [];
  let s = 0;
  for (const term of queryTerms) {
    const inName = termMatch(term, nameTokens);
    const inDesc = termMatch(term, descTokens);
    if (inName) s += 2;
    if (inDesc) s += 1;
    if (inName || inDesc) matched.push(term);
  }
  const sharedDomains = entry.domains.filter((d) => query.domains.includes(d));
  const sharedTasks = entry.tasks.filter((t) => query.tasks.includes(t));
  s += 2 * sharedDomains.length + sharedTasks.length;
  return { score: s, matched, sharedDomains, sharedTasks };
}

export function inventory({ profile, project, query = '', limit = 15, all = false, env = process.env } = {}) {
  const prof = path.resolve(profile ?? env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
  const proj = projectRoot(project ?? process.cwd());
  const q = { text: query, ...classify(query) };
  const queryTerms = [...new Set(tokenize(query).filter((t) => !STOPWORDS.has(t) && t.length > 1))];

  // The same skill synced into two buckets, or installed twice, counts once.
  const seen = new Map();
  const unique = [];
  for (const c of candidateFiles({ profile: prof, project: proj })) {
    const key = `${c.scope}\0${c.name}`;
    if (seen.has(key)) {
      seen.get(key).copies++;
      continue;
    }
    const entry = { ...c, copies: 1 };
    seen.set(key, entry);
    unique.push(entry);
  }

  const skills = unique.map((c) => {
    const text = readFileSync(c.file, 'utf8');
    const { data, body, error } = parseFrontmatter(text);
    const description = String(data.description ?? '').replace(/\s+/g, ' ').trim();
    const entry = {
      name: c.scope === 'plugin' ? c.name : (data.name ?? c.name),
      scope: c.scope,
      kind: c.kind,
      ...(c.plugin ? { plugin: c.plugin, enabled: c.enabled } : {}),
      description: description.length > 300 ? `${description.slice(0, 297)}...` : description,
      argumentHint: data['argument-hint'] ?? null,
      invocation: {
        model: String(data['disable-model-invocation'] ?? 'false') !== 'true',
        user: String(data['user-invocable'] ?? 'true') !== 'false',
      },
      ...classify(`${c.name} ${description}`),
      requires: requirements(data, body, { env }),
      path: c.file,
      ...(c.copies > 1 ? { copies: c.copies } : {}),
      ...(error && c.kind === 'skill' ? { parseError: error } : {}),
    };
    return queryTerms.length || q.domains.length ? { ...entry, ...score(entry, queryTerms, q) } : entry;
  });

  const ranked = queryTerms.length || q.domains.length ? skills.filter((s) => all || s.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)) : skills.sort((a, b) => a.name.localeCompare(b.name));
  const shown = all ? ranked : ranked.slice(0, limit);
  const byScope = {};
  for (const s of skills) byScope[s.scope] = (byScope[s.scope] ?? 0) + 1;
  return {
    profile: prof,
    project: proj,
    query: q,
    total: skills.length,
    byScope,
    shown: shown.length,
    skills: shown,
    notes: [
      'Built-in skills (for example code-review, simplify, security-review) may be listed in the session without files here; the session listing is the authority on what can be invoked now.',
      'Synced skills (scope "synced") can appear in the session listing under a prefix, such as anthropic-skills:<name>.',
      'A plugin skill whose plugin is disabled (enabled: false) is not invocable until the plugin is enabled and plugins are reloaded.',
    ],
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = parseArgs(process.argv.slice(2));
  const result = inventory({
    profile: typeof args.profile === 'string' ? args.profile : undefined,
    project: typeof args.project === 'string' ? args.project : undefined,
    query: typeof args.query === 'string' ? args.query : '',
    limit: args.limit ? Number(args.limit) : 15,
    all: Boolean(args.all),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
