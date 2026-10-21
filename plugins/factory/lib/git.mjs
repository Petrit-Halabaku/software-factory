// Git primitives for the factory. Everything goes through spawnSync with an
// argument array (never a shell), so paths with spaces or quotes are safe.
// Write operations are only ever called from workflow.mjs, which only the
// orchestrator runs.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { sha256 } from './fsutil.mjs';

export class FactoryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' };

export function git(cwd, args, { input, allowFail = false, buffer = false } = {}) {
  const r = spawnSync('git', args, { cwd, input, env: ENV, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new FactoryError('GIT', `git ${args.join(' ')} failed: ${String(r.stderr).trim()}`, { code: r.status });
  }
  return { code: r.status, stdout: r.stdout, stderr: buffer ? String(r.stderr) : r.stderr };
}

export const gitOut = (cwd, args) => git(cwd, args).stdout.trim();

export function currentBranch(repo) {
  return gitOut(repo, ['branch', '--show-current']) || null;
}

export const headCommit = (repo) => gitOut(repo, ['rev-parse', 'HEAD']);

export function commitExists(repo, sha) {
  if (!sha || !/^[0-9a-f]{7,64}$/.test(sha)) return false;
  return git(repo, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }).code === 0;
}

export function refExists(repo, ref) {
  return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`], { allowFail: true }).code === 0;
}

// `git status` as a map path -> XY code (untracked files included).
export function statusMap(repo) {
  const out = git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).stdout;
  const parts = out.split('\0').filter(Boolean);
  const map = {};
  for (let i = 0; i < parts.length; i++) {
    const xy = parts[i].slice(0, 2);
    map[parts[i].slice(3)] = xy;
    if (xy[0] === 'R' || xy[0] === 'C') i++; // rename source follows
  }
  return map;
}

// A fingerprint of the index: every entry's mode, blob and stage. If this is
// unchanged, nothing was staged or unstaged.
export const indexFingerprint = (repo) => sha256(git(repo, ['ls-files', '-s', '-z']).stdout);

export function hashFiles(repo, paths) {
  const existing = paths.filter((p) => existsSync(path.join(repo, p)));
  if (!existing.length) return {};
  const out = git(repo, ['hash-object', '--stdin-paths'], { input: `${existing.join('\n')}\n` }).stdout.trim().split('\n');
  return Object.fromEntries(existing.map((p, i) => [p, out[i]]));
}

// Merge, cherry-pick, revert, rebase or squash state left in the repository.
export function pendingOperations(repo) {
  const names = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'SQUASH_MSG', 'rebase-merge', 'rebase-apply'];
  return names.filter((n) => existsSync(path.resolve(repo, gitOut(repo, ['rev-parse', '--git-path', n]))));
}

export function parseNameStatus(out) {
  const parts = out.split('\0').filter(Boolean);
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i];
    const change = code[0];
    if (change === 'R' || change === 'C') {
      files.push({ change: 'R', oldPath: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ change, path: parts[i + 1], oldPath: null });
      i += 1;
    }
  }
  return files;
}

export const diffFiles = (repo, from, to) =>
  parseNameStatus(git(repo, ['diff', '--name-status', '-z', '--find-renames', from, to]).stdout);

export const stagedFiles = (repo) =>
  parseNameStatus(git(repo, ['diff', '--cached', '--name-status', '-z', '--find-renames', 'HEAD']).stdout);

export function diffText(repo, from, to, file, oldPath) {
  const paths = oldPath && oldPath !== file ? [oldPath, file] : [file];
  return git(repo, ['diff', '--find-renames', '--no-color', '--no-ext-diff', from, to, '--', ...paths]).stdout;
}

export function blobSize(repo, commit, file) {
  const r = git(repo, ['cat-file', '-s', `${commit}:${file}`], { allowFail: true });
  return r.code === 0 ? Number(r.stdout.trim()) : null;
}

export function showBlob(repo, commit, file) {
  const r = git(repo, ['cat-file', 'blob', `${commit}:${file}`], { allowFail: true, buffer: true });
  return r.code === 0 ? r.stdout : null;
}

// ---------------------------------------------------------------------------
// Path policy: what may never be committed, merged back or shown.

const FACTORY_INFRA = /^factory\//;
export const isFactoryPath = (p) => FACTORY_INFRA.test(p);
export const isDependencyPath = (p) => /(^|\/)node_modules(\/|$)/.test(p);

export function isSecretPath(p) {
  const base = p.split('/').pop().toLowerCase();
  if (/\.(example|sample|template)$/.test(base)) return false;
  return (
    /^\.env($|\.)/.test(base) ||
    /\.(pem|key|p12|pfx|jks|keystore|crt|cer)$/.test(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) ||
    ['.npmrc', '.netrc', '.pgpass', '.htpasswd', 'service-account.json', 'secrets.json', 'secrets.yml', 'secrets.yaml', '.secrets'].includes(base) ||
    /^credentials($|\.)/.test(base)
  );
}

// Added lines that look like a live credential.
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/,
  /\bsk_live_[0-9A-Za-z]{16,}/,
  /\brk_live_[0-9A-Za-z]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-[A-Za-z0-9]{40,}\b/,
];

export function secretLines(diff) {
  const hits = [];
  let file = null;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++') && SECRET_CONTENT.some((re) => re.test(line))) hits.push(file);
  }
  return [...new Set(hits)];
}

export function policyViolations(files) {
  const bad = [];
  for (const f of files) {
    for (const p of [f.path, f.oldPath].filter(Boolean)) {
      if (isFactoryPath(p)) bad.push({ path: p, why: 'factory infrastructure' });
      else if (isDependencyPath(p)) bad.push({ path: p, why: 'dependency directory' });
      else if (isSecretPath(p)) bad.push({ path: p, why: 'secret-bearing file' });
    }
  }
  return bad;
}
