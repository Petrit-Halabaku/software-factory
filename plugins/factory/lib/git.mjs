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

const SECRET_FILES = new Set([
  '.envrc', '.dev.vars', '.npmrc', '.netrc', '.pgpass', '.htpasswd', '.pypirc', '.git-credentials', '.dockercfg',
  '.vault-token', '.terraformrc', 'terraform.rc', 'kubeconfig', 'service-account.json', 'secrets.json', 'secrets.yml',
  'secrets.yaml', '.secrets',
]);

// A template is meant to be committed; its added lines are still scanned.
const TEMPLATE_SUFFIX = /\.(example|sample|template)$/;
const TEMPLATE_WORD = /(^|[._-])(example|sample|template)([._-]|$)/;

export function isSecretPath(p) {
  const lower = p.toLowerCase();
  const base = lower.split('/').pop();
  if (TEMPLATE_SUFFIX.test(base)) return false;
  // Other spellings of an env file: .env-prod, .env_local, prod.env.
  if ((/^\.env[-_]/.test(base) || /\.env$/.test(base)) && !TEMPLATE_WORD.test(base)) return true;
  return (
    /^\.env($|\.)/.test(base) ||
    /\.(pem|key|p8|p12|pfx|jks|keystore|keytab|kdbx|ppk|ovpn|crt|cer|tfvars|tfstate)$/.test(base) ||
    /\.tfstate\.backup$/.test(base) ||
    /\.tfvars\.json$/.test(base) ||
    /^id_(rsa|dsa|ecdsa|ed25519)/.test(base) ||
    SECRET_FILES.has(base) ||
    /^credentials($|\.)/.test(base) ||
    /(^|\/)\.(ssh|gnupg)\//.test(lower) ||
    /(^|\/)(\.kube\/config|\.docker\/config\.json)$/.test(lower)
  );
}

// Added lines that look like a live credential: formats specific enough that
// a match is almost never anything else.
const SECRET_CONTENT = [
  /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/,
  /\b[rs]k_live_[0-9A-Za-z]{16,}/, // Stripe secret and restricted keys
  /\bwhsec_[0-9A-Za-z]{24,}/, // Stripe webhook signing secrets
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{40,}/, // GitHub fine-grained tokens
  /\bglpat-[A-Za-z0-9_-]{20,}/, // GitLab tokens
  /\bnpm_[A-Za-z0-9]{36}\b/, // npm tokens
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bxapp-\d-[A-Za-z0-9-]{10,}/, // Slack app tokens
  /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/, // Slack webhooks
  /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, // SendGrid
  /\bsk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}/, // OpenAI project, service and admin keys
  /\bsk-[A-Za-z0-9]{40,}\b/,
  /\bGOCSPX-[A-Za-z0-9_-]{28}/, // Google OAuth client secrets
  /\bdop_v1_[a-f0-9]{64}\b/, // DigitalOcean
  /\bhf_[A-Za-z0-9]{34,}\b/, // Hugging Face
  /\bshp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}\b/, // Shopify
  /\bsbp_[a-f0-9]{40}\b/, // Supabase access tokens
  /\bsb_secret_[A-Za-z0-9_-]{20,}/, // Supabase secret keys
  /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}/, // PyPI
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, // Telegram bot tokens
  /_authToken=(?![$<{%*])[A-Za-z0-9+/=_-]{20,}/, // a literal package-registry token
  // A password inside a connection URL to a non-local host. Placeholders
  // ($VAR, ${VAR}, <pw>, {{pw}}, %s, ***), service names without a domain
  // (db, postgres), local hosts and example domains don't count.
  /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^\s:@/]+:(?![$<{%*])[^\s@/]{3,}@(?!(?:localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|host\.docker\.internal|(?:[A-Za-z0-9-]+\.)*example\.(?:com|org|net))\b)(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})/,
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
