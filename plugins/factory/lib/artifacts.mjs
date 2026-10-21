// The artifact registry: metadata and references for every file a run
// produces, stored in board.artifacts. Document bodies are never stored in
// the board; the dashboard fetches them by artifact id when opened.
//
// Two kinds:
//   run-file  a document in factory/runs/<id>/ (spec, plan, reviews, …)
//   git-file  an application file the builder changed, read from the
//             retained factory commits (or a final snapshot after cleanup)

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { nowIso, sha256 } from './fsutil.mjs';

export const artifactId = (runId, kind, p) => `a${sha256(`${runId}\0${kind}\0${p}`).slice(0, 16)}`;

const EXT_TYPES = {
  md: 'markdown', markdown: 'markdown', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx', ts: 'typescript',
  tsx: 'tsx', py: 'python', json: 'json', yml: 'yaml', yaml: 'yaml', sql: 'sql', css: 'css', scss: 'css', html: 'html',
  htm: 'html', sh: 'shell', bash: 'shell', zsh: 'shell', txt: 'text', log: 'text', patch: 'diff', diff: 'diff', toml: 'text',
  env: 'text', svg: 'html', xml: 'html',
};
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|woff2?|ttf|otf|mp4|mov|mp3|wasm|sqlite|db)$/i;

export function fileType(p) {
  if (BINARY_EXT.test(p)) return 'binary';
  const base = p.split('/').pop();
  if (base === 'Dockerfile' || base === 'Makefile') return 'text';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return EXT_TYPES[ext] ?? 'text';
}

export const isTestPath = (p) => /(^|\/)(__tests__|tests?)\/|\.(test|spec)\.[a-z]+$/i.test(p);

// Where each known run document comes from.
export function describeRunFile(rel, config) {
  const reviewByArea = Object.fromEntries(Object.entries(config.agents).filter(([, a]) => a.area).map(([role, a]) => [a.area, role]));
  const m = /^reviews\/pass-(\d+)\/([a-z-]+)\.md$/.exec(rel);
  if (m) {
    const role = reviewByArea[m[2]] ?? null;
    return { name: `${m[2]}.md`, category: 'review', stage: 'review', agent: role, pass: Number(m[1]), area: m[2] };
  }
  const known = {
    'request.md': { name: 'Feature request', category: 'specification', stage: 'request', agent: 'orchestrator' },
    'spec.md': { name: 'spec.md', category: 'specification', stage: 'spec', agent: 'spec-writer' },
    'plan.md': { name: 'plan.md', category: 'specification', stage: 'spec', agent: 'spec-writer' },
    'build.md': { name: 'build.md', category: 'implementation', stage: 'build', agent: 'builder' },
    'approval.md': { name: 'approval.md', category: 'approval', stage: 'approve', agent: 'approver' },
    'escalation.md': { name: 'escalation.md', category: 'finalization', stage: 'approve', agent: 'orchestrator' },
    'merge.md': { name: 'merge.md', category: 'finalization', stage: 'merge', agent: 'orchestrator' },
    'changes.patch': { name: 'changes.patch', category: 'finalization', stage: 'merge', agent: 'orchestrator' },
    'main-status.txt': { name: 'Main checkout status', category: 'other', stage: 'worktree', agent: 'orchestrator' },
  };
  if (known[rel]) return { ...known[rel] };
  const r = /^artifacts\/round-(\d+)\.patch$/.exec(rel);
  if (r) return { name: `round-${r[1]}.patch`, category: 'implementation', stage: 'build', agent: 'orchestrator', round: Number(r[1]) };
  return { name: rel.split('/').pop(), category: 'other', stage: null, agent: null };
}

// Files in the run directory that are never listed: the board copy, locks,
// temp files, and the snapshots (reached through their git-file entries).
const SKIP = (rel) =>
  rel === 'run.json' || rel.startsWith('artifacts/final/') || rel === 'artifacts/main-status.json' || /\.tmp-|\.lock$|(^|\/)\./.test(rel);

function walk(dir, root = dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (rel === 'artifacts/final') continue;
      walk(abs, root, out);
    } else if (e.isFile() && !SKIP(rel)) out.push(rel);
  }
  return out;
}

const runningRoles = (board) => new Set(Object.entries(board.agents).filter(([, a]) => a.status === 'RUNNING').map(([r]) => r));

// The round a document belongs to: the build round in progress (or under
// review) when it was produced.
const currentRound = (board) => Math.max(0, board.rounds.length - (board.stages.build === 'ACTIVE' ? 0 : 1));

// Scan factory/runs/<id>/ and bring every run-file entry up to date.
// A file whose producing agent is still running is WRITING (listed, not
// openable); it becomes READY when the orchestrator records the agent as
// done. A file that changed after being READY becomes UPDATED.
export function syncRunFiles(board, runDir, config) {
  const now = nowIso();
  const running = runningRoles(board);
  const seen = new Set();
  for (const rel of walk(runDir)) {
    const abs = path.join(runDir, rel);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const id = artifactId(board.runId, 'run', rel);
    seen.add(id);
    const meta = describeRunFile(rel, config);
    let a = board.artifacts.find((x) => x.id === id);
    const hash = st.size <= 8 * 1024 * 1024 ? sha256(readFileSync(abs)) : `size:${st.size}:${st.mtimeMs}`;
    if (!a) {
      a = {
        id, runId: board.runId, kind: 'run-file', path: rel, ...meta, fileType: fileType(rel),
        round: meta.round ?? (meta.stage === 'build' || meta.category === 'review' ? currentRound(board) : null),
        status: 'PENDING', createdAt: new Date(st.birthtimeMs || st.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      };
      board.artifacts.push(a);
    }
    const producerRunning = a.agent && running.has(a.agent) && (a.pass == null || board.reviews.at(-1)?.pass === a.pass);
    if (producerRunning) a.status = 'WRITING';
    else if (a.hash && a.hash !== hash && (a.status === 'READY' || a.status === 'UPDATED')) a.status = 'UPDATED';
    else if (a.status !== 'UPDATED' || a.hash !== hash) a.status = 'READY';
    if (a.hash !== hash) a.updatedAt = now;
    a.hash = hash;
    a.version = hash.slice(0, 12);
    a.size = st.size;
    a.mtime = new Date(st.mtimeMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  for (const a of board.artifacts) {
    if (a.kind === 'run-file' && !seen.has(a.id) && a.status !== 'PENDING' && a.status !== 'FAILED') a.status = 'UNAVAILABLE';
  }
}

// A document the run expects but that does not exist yet (e.g. a review
// report while its reviewer runs).
export function expectRunFile(board, rel, config, extra = {}) {
  const id = artifactId(board.runId, 'run', rel);
  if (board.artifacts.some((a) => a.id === id)) return id;
  board.artifacts.push({ id, runId: board.runId, kind: 'run-file', path: rel, ...describeRunFile(rel, config), fileType: fileType(rel), status: 'PENDING', ...extra });
  return id;
}

export function markFailed(board, rel) {
  const a = board.artifacts.find((x) => x.id === artifactId(board.runId, 'run', rel));
  if (a && a.status === 'PENDING') a.status = 'FAILED';
}

export const runFileId = (board, rel) => artifactId(board.runId, 'run', rel);

// Register the application files of one committed round. Each file gets one
// entry with a version per round that touched it.
export function registerRound(board, round) {
  for (const f of round.files) {
    const id = artifactId(board.runId, 'git', f.path);
    let a = board.artifacts.find((x) => x.id === id);
    const version = { round: round.round, label: round.label, commit: round.commit, change: f.change, oldPath: f.oldPath ?? null, at: round.committedAt };
    if (!a) {
      a = {
        id, runId: board.runId, kind: 'git-file', path: f.path, name: f.path.split('/').pop(), category: 'implementation',
        group: isTestPath(f.path) ? 'tests' : 'changed', stage: 'build', agent: 'builder', fileType: fileType(f.path),
        createdAt: round.committedAt, versions: [],
      };
      board.artifacts.push(a);
    }
    a.versions = a.versions.filter((v) => v.round !== round.round).concat(version).sort((x, y) => x.round - y.round);
    const first = a.versions[0];
    a.change = first.change === 'A' ? 'added' : a.versions.at(-1).change === 'D' ? 'deleted' : first.change === 'R' ? 'renamed' : 'modified';
    a.round = round.round;
    a.version = round.commit.slice(0, 12);
    a.updatedAt = round.committedAt;
    a.status = a.versions.length > 1 ? 'UPDATED' : 'READY';
  }
}

export function existsInRun(runDir, rel) {
  return existsSync(path.join(runDir, rel));
}
