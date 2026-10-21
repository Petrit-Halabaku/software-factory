// Read-only access to artifact contents for the dashboard. Callers pass a
// registered artifact id; this module never takes a filesystem path from a
// request. Run documents are read from factory/runs/<id>/ only, application
// files from the run's retained commits or its final snapshot only.

import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { factoryPaths } from './config.mjs';
import { blobSize, commitExists, diffText, isSecretPath, showBlob } from './git.mjs';

export class FileError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const RUN_ID_RE = /^\d{8}-\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTIFACT_ID_RE = /^a[0-9a-f]{16}$/;

// A relative path with no traversal, no absolute root and no NUL.
export function safeRelative(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || p.includes('\\')) return null;
  if (path.posix.isAbsolute(p)) return null;
  const norm = path.posix.normalize(p);
  if (norm !== p || norm === '.' || norm.startsWith('../') || norm.split('/').includes('..')) return null;
  return norm;
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

// Resolve a file inside `root`, refusing symlinks anywhere on the way and
// anything whose real path leaves the root.
export function resolveInside(root, rel) {
  const safe = safeRelative(rel);
  if (!safe) throw new FileError(400, 'invalid path');
  const realRoot = realpathSync(root);
  let cur = realRoot;
  for (const part of safe.split('/')) {
    cur = path.join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      throw new FileError(404, 'file not found');
    }
    if (st.isSymbolicLink()) throw new FileError(403, 'symbolic links are not served');
  }
  const real = realpathSync(cur);
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new FileError(403, 'outside the run directory');
  return real;
}

function content(buf, artifact, maxBytes, extra = {}) {
  if (buf.length > maxBytes) return { kind: 'too-large', size: buf.length, maxBytes, ...extra };
  if (artifact.fileType === 'binary' || looksBinary(buf)) return { kind: 'binary', size: buf.length, ...extra };
  return { kind: artifact.fileType === 'markdown' ? 'markdown' : 'code', language: artifact.fileType, size: buf.length, text: buf.toString('utf8'), ...extra };
}

export function findArtifact(board, artifactId) {
  if (!ARTIFACT_ID_RE.test(String(artifactId))) throw new FileError(400, 'invalid artifact id');
  const a = board.artifacts.find((x) => x.id === artifactId);
  if (!a) throw new FileError(404, 'unknown artifact');
  if (a.runId !== board.runId) throw new FileError(403, 'artifact belongs to another run');
  if (isSecretPath(a.path)) throw new FileError(403, 'sensitive files are not served');
  return a;
}

function runFileBuffer(ctx, board, a) {
  const root = path.join(factoryPaths(ctx.factoryDir).runs, board.runId);
  const abs = resolveInside(root, a.path);
  const size = statSync(abs).size;
  if (size > ctx.config.files.maxBytes) return { tooLarge: size };
  return { buf: readFileSync(abs) };
}

function versionOf(a, version) {
  if (!a.versions?.length) throw new FileError(404, 'no versions recorded');
  if (version === undefined || version === null || version === '') return a.versions.at(-1);
  const v = a.versions.find((x) => String(x.round) === String(version));
  if (!v) throw new FileError(404, 'no such version of this file');
  return v;
}

function gitFileBuffer(ctx, board, a, v) {
  if (v.change === 'D') return { unavailable: 'The file was deleted in this round.' };
  if (commitExists(ctx.repoDir, v.commit)) {
    const size = blobSize(ctx.repoDir, v.commit, a.path);
    if (size === null) return { unavailable: 'The file is not in this commit.' };
    if (size > ctx.config.files.maxBytes) return { tooLarge: size };
    return { buf: showBlob(ctx.repoDir, v.commit, a.path), source: 'commit' };
  }
  // The commit is gone (branch deleted). Only the final version was
  // snapshotted; never show it in place of an earlier one.
  const isFinal = v === a.versions.at(-1);
  if (isFinal && a.snapshot) {
    try {
      const root = path.join(factoryPaths(ctx.factoryDir).runs, board.runId);
      const abs = resolveInside(root, a.snapshot);
      if (statSync(abs).size > ctx.config.files.maxBytes) return { tooLarge: statSync(abs).size };
      return { buf: readFileSync(abs), source: 'snapshot' };
    } catch (e) {
      if (!(e instanceof FileError)) throw e;
    }
  }
  return { unavailable: 'This version is no longer available: its commit was deleted and no snapshot was kept.' };
}

// Extract one file's section from a saved patch.
export function patchSection(patch, file, oldPath) {
  const parts = String(patch).split(/^(?=diff --git )/m);
  return parts.find((s) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(s);
    return m && (m[2] === file || (oldPath && m[1] === oldPath));
  }) ?? null;
}

function diffFor(ctx, board, a, v, against) {
  const idx = a.versions.indexOf(v);
  let from;
  let fromLabel;
  if (against === 'prev') {
    const prevRound = board.rounds.filter((r) => r.round < v.round).at(-1);
    from = prevRound?.commit ?? board.startCommit;
    fromLabel = prevRound?.label ?? 'start';
  } else if (against !== undefined && against !== null && against !== '' && against !== 'start') {
    const r = board.rounds.find((x) => String(x.round) === String(against));
    if (!r) throw new FileError(404, 'no such round to compare against');
    from = r.commit;
    fromLabel = r.label;
  } else {
    from = board.startCommit;
    fromLabel = 'start';
  }
  const meta = { from: fromLabel, to: v.label ?? `round ${v.round}`, change: v.change, oldPath: v.oldPath };
  if (commitExists(ctx.repoDir, from) && commitExists(ctx.repoDir, v.commit)) {
    return { kind: 'diff', text: diffText(ctx.repoDir, from, v.commit, a.path, v.oldPath), source: 'git', ...meta };
  }
  // Commits gone: fall back to the patches saved at commit and merge time.
  const root = path.join(factoryPaths(ctx.factoryDir).runs, board.runId);
  const candidates = [];
  if (fromLabel === 'start' && idx === a.versions.length - 1) candidates.push('changes.patch');
  if (against === 'prev') candidates.push(`artifacts/round-${v.round}.patch`);
  for (const rel of candidates) {
    try {
      const section = patchSection(readFileSync(resolveInside(root, rel), 'utf8'), a.path, v.oldPath);
      if (section) return { kind: 'diff', text: section, source: rel, ...meta };
    } catch (e) {
      if (!(e instanceof FileError)) throw e;
    }
  }
  return { kind: 'unavailable', message: 'The commits for this comparison were deleted and no saved patch covers it.', ...meta };
}

export function readArtifact(ctx, board, artifactId, { view = 'content', version, against } = {}) {
  const a = findArtifact(board, artifactId);
  const meta = { artifact: a };
  if (a.status === 'PENDING' || a.status === 'WRITING' || a.status === 'FAILED') {
    return { ...meta, kind: 'unavailable', message: a.status === 'FAILED' ? 'The producing agent finished without writing this file.' : 'This file is not ready yet.' };
  }
  if (a.kind === 'run-file') {
    if (view !== 'content') throw new FileError(400, 'run documents have no diff or history');
    let r;
    try {
      r = runFileBuffer(ctx, board, a);
    } catch (e) {
      if (e instanceof FileError && e.status === 404) return { ...meta, kind: 'unavailable', message: 'The file no longer exists.' };
      throw e;
    }
    if (r.tooLarge) return { ...meta, kind: 'too-large', size: r.tooLarge, maxBytes: ctx.config.files.maxBytes };
    return { ...meta, ...content(r.buf, a, ctx.config.files.maxBytes) };
  }
  if (a.kind !== 'git-file') throw new FileError(400, 'unsupported artifact');
  if (view === 'history') {
    return {
      ...meta,
      kind: 'history',
      versions: a.versions.map((v, i) => ({
        ...v,
        available: commitExists(ctx.repoDir, v.commit) || (i === a.versions.length - 1 && Boolean(a.snapshot) && existsSync(path.join(factoryPaths(ctx.factoryDir).runs, board.runId, a.snapshot))),
      })),
    };
  }
  const v = versionOf(a, version);
  if (view === 'diff') return { ...meta, version: v, ...diffFor(ctx, board, a, v, against) };
  if (view !== 'content') throw new FileError(400, 'unknown view');
  const r = gitFileBuffer(ctx, board, a, v);
  if (r.unavailable) return { ...meta, version: v, kind: 'unavailable', message: r.unavailable };
  if (r.tooLarge) return { ...meta, version: v, kind: 'too-large', size: r.tooLarge, maxBytes: ctx.config.files.maxBytes };
  return { ...meta, version: v, ...content(r.buf, a, ctx.config.files.maxBytes, { source: r.source }) };
}

// Raw bytes for the download action (same checks as the viewer).
export function downloadArtifact(ctx, board, artifactId, { version } = {}) {
  const a = findArtifact(board, artifactId);
  if (a.status === 'PENDING' || a.status === 'WRITING' || a.status === 'FAILED') throw new FileError(409, 'file is not ready');
  if (a.kind === 'run-file') {
    const r = runFileBuffer(ctx, board, a);
    if (r.tooLarge) throw new FileError(413, 'file is too large');
    return { name: a.path.split('/').pop(), buf: r.buf };
  }
  const r = gitFileBuffer(ctx, board, a, versionOf(a, version));
  if (r.unavailable) throw new FileError(404, r.unavailable);
  if (r.tooLarge) throw new FileError(413, 'file is too large');
  return { name: a.path.split('/').pop(), buf: r.buf };
}
