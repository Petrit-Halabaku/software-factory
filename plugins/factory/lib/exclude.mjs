// Continuous protection: before a run starts, before a round is committed
// and before a merge-back, check that every factory path is ignored through
// .git/info/exclude and that none is tracked or staged. The plugin's own
// files live outside the repository; only <repo>/factory/ and the dependency
// links inside factory worktrees need excluding.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { git, gitOut } from './git.mjs';

export const BLOCK_HEADER = '# CLAUDE CODE SOFTWARE FACTORY — LOCAL ONLY';

// "/factory/", plus one anchored pattern per linked dependency directory: a
// worktree's link is a symlink, which a "node_modules/" (directories only)
// rule in .gitignore does not match.
export const requiredPatterns = (links = []) => ['/factory/', ...links.map((l) => `/${l.replace(/^\/+|\/+$/g, '')}`)];

// Representative paths for every kind of factory file.
export const PROBE_PATHS = [
  'factory/house-rules.md',
  'factory/config.json',
  'factory/board.json',
  'factory/board.json.lock',
  'factory/usage.json',
  'factory/.cache/usage-index.json',
  'factory/runs/probe/run.json',
  'factory/runs/probe/request.md',
  'factory/runs/probe/spec.md',
  'factory/runs/probe/plan.md',
  'factory/runs/probe/build.md',
  'factory/runs/probe/reviews/pass-1/security.md',
  'factory/runs/probe/reviews/pass-3/ui-design.md',
  'factory/runs/probe/approval.md',
  'factory/runs/probe/escalation.md',
  'factory/runs/probe/merge.md',
  'factory/runs/probe/changes.patch',
  'factory/runs/probe/artifacts/round-0.patch',
  'factory/runs/probe/artifacts/final/lib/x.js',
  'factory/worktrees/probe/lib/x.js',
];

// Paths that must stay visible to Git: the factory must not hide app code.
export const MUST_NOT_IGNORE = ['lib/factory-probe.js', 'app/page.js', 'src/factory.js', '.claude/settings.json', '.claude/agents/other-agent.md'];

export function excludeFile(repo) {
  return path.resolve(repo, gitOut(repo, ['rev-parse', '--git-path', 'info/exclude']));
}

function checkIgnore(repo, paths) {
  const out = git(repo, ['check-ignore', '-v', '-n', '--no-index', '--stdin'], { input: `${paths.join('\n')}\n`, allowFail: true }).stdout;
  const result = {};
  for (const line of out.split('\n').filter(Boolean)) {
    const [src, p] = line.split('\t');
    const [source, lineNo, ...pattern] = src.split(':');
    result[p] = source ? { source, line: Number(lineNo), pattern: pattern.join(':') } : null;
  }
  return result;
}

// Append the factory block, or the patterns it lacks, to info/exclude,
// keeping everything already there. Returns the patterns added.
export function ensureExclusions(repo, { links = [] } = {}) {
  const file = excludeFile(repo);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  const missing = requiredPatterns(links).filter((p) => !lines.has(p));
  if (!missing.length) return { file, added: [] };
  const header = lines.has(BLOCK_HEADER) ? '' : `\n# ============================================\n${BLOCK_HEADER}\n# ============================================\n\n`;
  appendFileSync(file, `${text && !text.endsWith('\n') ? '\n' : ''}${header}${missing.join('\n')}\n`);
  return { file, added: missing };
}

// Returns { ok, problems[], checks[] }. `cwd` may be the main checkout or a
// linked worktree (both read the same info/exclude).
export function checkExclusions(cwd, { links = [] } = {}) {
  const problems = [];
  const file = excludeFile(cwd);
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    problems.push(`cannot read ${file}`);
  }
  const lines = new Set(text.split('\n').map((l) => l.trim()));
  for (const p of requiredPatterns(links)) if (!lines.has(p)) problems.push(`${file} is missing the pattern ${p}`);

  const ignored = checkIgnore(cwd, PROBE_PATHS);
  const checks = PROBE_PATHS.map((p) => ({ path: p, match: ignored[p] ?? null }));
  for (const c of checks) {
    if (!c.match) problems.push(`${c.path} is not ignored`);
    else if (path.resolve(cwd, c.match.source) !== file) problems.push(`${c.path} is ignored by ${c.match.source}, not by info/exclude`);
  }
  const visible = checkIgnore(cwd, MUST_NOT_IGNORE);
  for (const p of MUST_NOT_IGNORE) {
    if (visible[p] && /info\/exclude$/.test(visible[p].source)) problems.push(`${p} is hidden by the factory exclusions (${visible[p].pattern}); they are too broad`);
  }

  const tracked = git(cwd, ['ls-files', '--', 'factory']).stdout.split('\n').filter(Boolean);
  for (const t of tracked) problems.push(`factory file is tracked by Git: ${t} (ask the human before changing its tracking state)`);
  const staged = git(cwd, ['diff', '--cached', '--name-only', '--', 'factory']).stdout.split('\n').filter(Boolean);
  for (const s of staged) problems.push(`factory file is staged: ${s}`);

  return { ok: problems.length === 0, problems, checks, excludeFile: file };
}
