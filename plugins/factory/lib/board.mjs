// The board: factory/board.json, the single source of truth for workflow
// state. Only the orchestrator writes it, always through factory/bin/fac.mjs
// (writeBoard below). The dashboard and the usage collector only read it.

import { existsSync, mkdirSync, openSync, closeSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { nowIso, readJson, writeJsonAtomic } from './fsutil.mjs';
import { factoryPaths, reviewRoles } from './config.mjs';

export const BOARD_VERSION = 2;

export const RUN_STATUSES = ['IDLE', 'RUNNING', 'WAITING_FOR_HUMAN', 'APPROVED', 'MERGED', 'STOPPED'];
export const STAGES = ['request', 'worktree', 'spec', 'build', 'review', 'approve', 'merge'];
export const STAGE_STATUSES = ['PENDING', 'ACTIVE', 'DONE', 'CHANGES', 'WAITING', 'BLOCKED'];
export const AGENT_STATUSES = ['IDLE', 'RUNNING', 'DONE', 'FAILED', 'BLOCKED'];
export const REVIEW_STATUSES = ['PENDING', 'RUNNING', 'PASS', 'CHANGES'];
export const ARTIFACT_STATUSES = ['PENDING', 'WRITING', 'READY', 'UPDATED', 'FAILED', 'UNAVAILABLE'];
export const DECISIONS = ['APPROVE', 'ESCALATE'];

export const STAGE_LABELS = {
  request: 'Feature request',
  worktree: 'Isolated worktree',
  spec: 'Spec',
  build: 'Build',
  review: 'Reviews',
  approve: 'Approval',
  merge: 'Merge back',
};

const LOG_LIMIT = 500;

export function emptyBoard(config) {
  const agents = {};
  for (const [role, a] of Object.entries(config.agents)) {
    agents[role] = { status: 'IDLE', model: a.model, observedModel: null, sessions: [] };
  }
  return {
    version: BOARD_VERSION,
    runId: null,
    feature: null,
    branch: null,
    startCommit: null,
    factoryBranch: null,
    worktree: null,
    orchestrator: null,
    status: 'IDLE',
    stage: null,
    stages: Object.fromEntries(STAGES.map((s) => [s, 'PENDING'])),
    agents,
    revision: { round: 0, max: config.revisionMax, human: 0, pending: null },
    rounds: [],
    reviews: [],
    requestedChanges: [],
    approval: { decision: null, by: null, reason: null, artifactId: null, at: null },
    artifacts: [],
    usage: { file: 'usage.json' },
    timeline: [],
    log: [],
    createdAt: null,
    updatedAt: null,
    endedAt: null,
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const str = (v) => (typeof v === 'string' && v.length ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);

// Turns whatever is on disk into a board the UI can render. Unknown values
// fall back to safe defaults and are reported, so a hand-edited or
// half-migrated board never crashes the dashboard.
export function normalizeBoard(raw, config) {
  const errors = [];
  const base = emptyBoard(config);
  if (!isObj(raw)) return { board: base, errors: ['board.json is not a JSON object'] };
  if (raw.version !== BOARD_VERSION) errors.push(`board version ${raw.version ?? 'missing'}, expected ${BOARD_VERSION}`);

  const b = { ...base };
  for (const k of ['runId', 'branch', 'startCommit', 'factoryBranch', 'worktree', 'createdAt', 'updatedAt', 'endedAt']) b[k] = str(raw[k]);
  b.feature = isObj(raw.feature) ? { title: str(raw.feature.title) ?? 'Untitled', request: typeof raw.feature.request === 'string' ? raw.feature.request : '' } : null;
  b.orchestrator = isObj(raw.orchestrator) ? { sessionId: str(raw.orchestrator.sessionId), model: str(raw.orchestrator.model) } : null;

  b.status = oneOf(raw.status, RUN_STATUSES, 'IDLE');
  if (raw.status !== undefined && b.status !== raw.status) errors.push(`unknown status "${raw.status}"`);
  b.stage = oneOf(raw.stage, STAGES, null);

  for (const s of STAGES) {
    const v = isObj(raw.stages) ? raw.stages[s] : undefined;
    b.stages[s] = oneOf(v, STAGE_STATUSES, 'PENDING');
    if (v !== undefined && v !== b.stages[s]) errors.push(`stage ${s}: unknown status "${v}"`);
  }

  for (const role of Object.keys(base.agents)) {
    const a = isObj(raw.agents) ? raw.agents[role] : undefined;
    if (!isObj(a)) continue;
    b.agents[role] = {
      status: oneOf(a.status, AGENT_STATUSES, 'IDLE'),
      model: base.agents[role].model,
      observedModel: str(a.observedModel),
      sessions: arr(a.sessions).filter(isObj).map((s) => ({
        agentId: str(s.agentId),
        stage: oneOf(s.stage, STAGES, null),
        round: Number.isInteger(s.round) ? s.round : 0,
        pass: Number.isInteger(s.pass) ? s.pass : null,
        resumed: s.resumed === true,
        startedAt: str(s.startedAt),
        endedAt: str(s.endedAt),
        result: str(s.result),
      })),
    };
    if (isObj(a) && a.model && a.model !== base.agents[role].model) {
      errors.push(`agent ${role}: board says model ${a.model}, config says ${base.agents[role].model}`);
    }
  }
  if (isObj(raw.agents)) {
    for (const role of Object.keys(raw.agents)) if (!base.agents[role]) errors.push(`unknown agent role "${role}"`);
  }

  const rev = isObj(raw.revision) ? raw.revision : {};
  b.revision = {
    round: Number.isInteger(rev.round) && rev.round >= 0 ? rev.round : 0,
    max: config.revisionMax,
    human: Number.isInteger(rev.human) && rev.human >= 0 ? rev.human : 0,
    pending: oneOf(rev.pending, ['auto', 'human'], null),
  };
  if (b.revision.round > b.revision.max) errors.push(`revision round ${b.revision.round} exceeds the maximum of ${b.revision.max}`);

  b.rounds = arr(raw.rounds).filter(isObj).map((r) => ({
    round: Number.isInteger(r.round) ? r.round : 0,
    label: str(r.label) ?? `Round ${r.round}`,
    human: r.human === true,
    commit: str(r.commit),
    committedAt: str(r.committedAt),
    files: arr(r.files).filter(isObj).map((f) => ({ path: str(f.path), change: str(f.change) ?? 'M', oldPath: str(f.oldPath) })),
  }));

  const areas = reviewRoles(config).map((r) => r.area);
  b.reviews = arr(raw.reviews).filter(isObj).map((p) => {
    const results = {};
    for (const area of areas) {
      const r = isObj(p.results) ? p.results[area] : undefined;
      results[area] = {
        status: oneOf(r?.status, REVIEW_STATUSES, 'PENDING'),
        artifactId: str(r?.artifactId),
        findings: Number.isInteger(r?.findings) ? r.findings : null,
        note: str(r?.note),
      };
    }
    return { pass: Number.isInteger(p.pass) ? p.pass : 0, round: Number.isInteger(p.round) ? p.round : 0, commit: str(p.commit), startedAt: str(p.startedAt), results };
  });

  b.requestedChanges = arr(raw.requestedChanges).filter(isObj).map((c) => ({
    pass: Number.isInteger(c.pass) ? c.pass : 0,
    area: str(c.area),
    severity: oneOf(c.severity, ['blocker', 'should-fix'], 'should-fix'),
    summary: str(c.summary) ?? '',
    artifactId: str(c.artifactId),
  }));

  const ap = isObj(raw.approval) ? raw.approval : {};
  b.approval = { decision: oneOf(ap.decision, DECISIONS, null), by: str(ap.by), reason: str(ap.reason), artifactId: str(ap.artifactId), at: str(ap.at) };

  b.artifacts = arr(raw.artifacts).filter((a) => isObj(a) && str(a.id) && str(a.path)).map((a) => ({
    ...a,
    status: oneOf(a.status, ARTIFACT_STATUSES, 'UNAVAILABLE'),
  }));
  b.timeline = arr(raw.timeline).filter((t) => isObj(t) && str(t.at));
  b.log = arr(raw.log).filter((l) => isObj(l) && str(l.at) && typeof l.text === 'string').slice(-LOG_LIMIT);
  return { board: b, errors };
}

export function readBoard(file, config) {
  if (!existsSync(file)) return { ok: true, board: emptyBoard(config), errors: [], missing: true };
  const INVALID = Symbol('invalid');
  const raw = readJson(file, INVALID);
  if (raw === INVALID) return { ok: false, board: emptyBoard(config), errors: ['board.json is not valid JSON'] };
  const { board, errors } = normalizeBoard(raw, config);
  return { ok: errors.length === 0, board, errors };
}

// The current board plus every archived run (runs/<id>/run.json), newest
// first. The current board wins for its own run.
export function loadBoards(factoryDir, config) {
  const p = factoryPaths(factoryDir);
  const { board } = readBoard(p.board, config);
  const out = board.runId ? [board] : [];
  let dirs = [];
  try {
    dirs = readdirSync(p.runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {}
  for (const id of dirs) {
    if (id === board.runId) continue;
    const file = path.join(p.runs, id, 'run.json');
    if (!existsSync(file)) continue;
    const r = readBoard(file, config);
    if (r.board.runId === id) out.push(r.board);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

// ---------------------------------------------------------------------------
// Writing (orchestrator only)

// A tiny exclusive lock so two fac.mjs calls never interleave a
// read-modify-write of the board. Stale locks (a crashed call) expire.
function withLock(lockFile, fn) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lockFile, 'wx'));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > 30_000) rmSync(lockFile, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`board is locked (${lockFile})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockFile, { force: true });
  }
}

export function writeBoard(factoryDir, board) {
  const p = factoryPaths(factoryDir);
  board.updatedAt = nowIso();
  board.log = board.log.slice(-LOG_LIMIT);
  writeJsonAtomic(p.board, board);
  if (board.runId) {
    mkdirSync(path.join(p.runs, board.runId), { recursive: true });
    writeJsonAtomic(path.join(p.runs, board.runId, 'run.json'), board);
  }
}

// Read, change, write, under the lock. `fn` mutates the board in place and
// may return a value; throwing leaves the board untouched.
export function updateBoard(factoryDir, config, fn) {
  const p = factoryPaths(factoryDir);
  return withLock(`${p.board}.lock`, () => {
    const { board, errors } = readBoard(p.board, config);
    if (errors.some((e) => e.includes('not valid JSON') || e.includes('not a JSON object'))) {
      throw new Error(`refusing to overwrite a corrupt board: ${errors.join('; ')}`);
    }
    const result = fn(board);
    writeBoard(factoryDir, board);
    return result;
  });
}

export function logEvent(board, text) {
  board.log.push({ at: nowIso(), text });
}

export function setStage(board, stage, status) {
  board.stages[stage] = status;
  if (status === 'ACTIVE' || status === 'WAITING' || status === 'BLOCKED') board.stage = stage;
  board.timeline.push({ at: nowIso(), stage, status });
}

// The stage the run was in at a given time, from the timeline. Used to put
// orchestrator token usage on a stage.
export function stageAt(board, iso) {
  let current = 'request';
  for (const t of board.timeline) {
    if (t.at > iso) break;
    if (t.status === 'ACTIVE') current = t.stage;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Report parsing

// Line 1 `Review: <area>`, line 2 `Result: PASS | CHANGES`. Anything else is
// malformed and counts as CHANGES.
export function parseReviewReport(text, expectedArea) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const m1 = /^Review:\s*([a-z-]+)\s*$/i.exec((lines[0] ?? '').trim());
  const m2 = /^Result:\s*(PASS|CHANGES)\s*$/.exec((lines[1] ?? '').trim());
  if (!m1 || !m2) return { valid: false, result: 'CHANGES', reason: 'report missing or malformed (line 1 must be "Review: <area>", line 2 "Result: PASS | CHANGES")', findings: [] };
  if (expectedArea && m1[1].toLowerCase() !== expectedArea) {
    return { valid: false, result: 'CHANGES', reason: `report is for area "${m1[1]}", expected "${expectedArea}"`, findings: [] };
  }
  return { valid: true, area: m1[1].toLowerCase(), result: m2[1], findings: parseFindings(text) };
}

// Numbered findings with a severity tag, e.g.
//   1. **[blocker]** `lib/x.js:12` — what is wrong
//   2. [should-fix] Missing test for …
// Only blocker and should-fix findings are requested changes.
export function parseFindings(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:#+\s*)?(\d+)[.)]\s+(.*)$/.exec(line);
    if (!m) continue;
    const sev = /\b(blocker|should-fix)\b/i.exec(m[2]);
    if (!sev) continue;
    const summary = m[2].replace(/\*\*/g, '').replace(/\[?\b(blocker|should-fix)\b\]?:?/i, '').replace(/^[\s—:-]+/, '').trim();
    out.push({ n: Number(m[1]), severity: sev[1].toLowerCase(), summary: summary.slice(0, 240) });
  }
  return out;
}

export function parseApproval(text) {
  const m = /^Decision:\s*(APPROVE|ESCALATE)\s*$/m.exec(String(text ?? ''));
  if (!m) return { valid: false, decision: 'ESCALATE', reason: 'approval.md missing or has no "Decision: APPROVE | ESCALATE" line' };
  const why = /^#+\s*(?:Why|Decision explanation|Explanation)[^\n]*\n+([^\n#][^\n]*)/im.exec(text);
  return { valid: true, decision: m[1], reason: why ? why[1].replace(/^[-*]\s*/, '').trim().slice(0, 240) : null };
}
