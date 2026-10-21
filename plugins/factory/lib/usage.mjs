// Read-only token monitoring from Claude Code's own local session records.
//
// Sources: the project's transcript directories (config.usage.sources):
//   <session>.jsonl                          main threads (the orchestrator)
//   <session>/subagents/agent-<id>.jsonl     one file per subagent
//   <session>/subagents/agent-<id>.meta.json its agent type
// Only assistant records are read, and only their ids, model, timestamp and
// the four usage counters are kept. No prompt or message text is stored.
//
// Aggregation formula (per deduplicated API message):
//   key   = message.id + "|" + requestId   (record uuid when message.id is absent)
//   field = max over every record with that key, for input_tokens,
//           output_tokens, cache_creation_input_tokens, cache_read_input_tokens
//           (Claude Code writes repeated and incremental snapshots of one
//           message; taking the max counts each message once)
//   total processed = input + output + cache write + cache read
// Each message counts once in every window, however many files or parses
// it appears in.

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { expandHome, factoryPaths } from './config.mjs';
import { STAGES, stageAt } from './board.mjs';
import { readJson, writeJsonAtomic } from './fsutil.mjs';

const CACHE_VERSION = 1;
const FIELDS = ['i', 'o', 'cw', 'cr'];
export const FAMILIES = ['Opus', 'Sonnet', 'Haiku'];

export function modelFamily(model) {
  const m = String(model ?? '').toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return 'Other';
}

function listSourceFiles(sources) {
  const files = [];
  const report = [];
  for (const src of sources) {
    const dir = expandHome(src);
    if (!existsSync(dir)) {
      report.push({ path: src, exists: false, files: 0 });
      continue;
    }
    let count = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        files.push({ file: path.join(dir, e.name), kind: 'main', agentId: null, metaFile: null });
        count++;
      } else if (e.isDirectory()) {
        const sub = path.join(dir, e.name, 'subagents');
        if (!existsSync(sub)) continue;
        for (const f of readdirSync(sub)) {
          const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(f);
          if (!m) continue;
          files.push({ file: path.join(sub, f), kind: 'subagent', agentId: m[1], metaFile: path.join(sub, `agent-${m[1]}.meta.json`) });
          count++;
        }
      }
    }
    report.push({ path: src, exists: true, files: count });
  }
  return { files, report };
}

// Parse one transcript line into a usage record, or null.
export function parseRecord(line, fallbackAgentId = null) {
  if (!line.includes('"assistant"')) return null;
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (r?.type !== 'assistant' || !r.message) return null;
  const msg = r.message;
  if (!msg.model || msg.model === '<synthetic>') return null;
  const key = `${msg.id ?? r.uuid ?? ''}|${r.requestId ?? ''}`;
  if (key === '|') return null;
  const u = msg.usage;
  const num = (v) => (Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    key,
    m: msg.model,
    t: r.timestamp ?? null,
    s: r.sessionId ?? null,
    a: r.agentId ?? (r.isSidechain ? fallbackAgentId : null) ?? fallbackAgentId,
    u: Boolean(u && typeof u === 'object'),
    i: num(u?.input_tokens),
    o: num(u?.output_tokens),
    cw: num(u?.cache_creation_input_tokens),
    cr: num(u?.cache_read_input_tokens),
  };
}

export function mergeRecord(records, rec) {
  const cur = records[rec.key];
  if (!cur) {
    const { key, ...rest } = rec;
    records[key] = rest;
    return true;
  }
  let changed = false;
  for (const f of FIELDS) {
    if (rec[f] > cur[f]) {
      cur[f] = rec[f];
      changed = true;
    }
  }
  if (rec.u && !cur.u) cur.u = changed = true;
  if (rec.t && (!cur.t || rec.t < cur.t)) cur.t = rec.t;
  if (!cur.a && rec.a) cur.a = rec.a;
  return changed;
}

function readNew(file, offset, size) {
  const fd = openSync(file, 'r');
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    let got = 0;
    while (got < len) {
      const n = readSync(fd, buf, got, len - got, offset + got);
      if (!n) break;
      got += n;
    }
    const last = buf.lastIndexOf(0x0a, got - 1);
    if (last < 0) return { text: '', consumed: 0 };
    return { text: buf.subarray(0, last + 1).toString('utf8'), consumed: last + 1 };
  } finally {
    closeSync(fd);
  }
}

// Bring the cached index up to date, reading only bytes appended since the
// last call. Returns { records, agentTypes, sources, changed }.
export function refreshUsageIndex(ctx, { cacheFile } = {}) {
  const cache = cacheFile ?? path.join(factoryPaths(ctx.factoryDir).cache, 'usage-index.json');
  let idx = readJson(cache, null);
  if (!idx || idx.version !== CACHE_VERSION) idx = { version: CACHE_VERSION, files: {}, records: {}, agentTypes: {} };
  const { files, report } = listSourceFiles(ctx.config.usage.sources);
  let changed = false;
  for (const f of files) {
    let st;
    try {
      st = statSync(f.file);
    } catch {
      continue;
    }
    let entry = idx.files[f.file];
    if (!entry || st.size < entry.offset) entry = idx.files[f.file] = { offset: 0, size: 0 };
    if (f.agentId && !idx.agentTypes[f.agentId] && f.metaFile) {
      const meta = readJson(f.metaFile, null);
      if (meta?.agentType) {
        idx.agentTypes[f.agentId] = meta.agentType;
        changed = true;
      }
    }
    if (st.size === entry.offset) continue;
    const { text, consumed } = readNew(f.file, entry.offset, st.size);
    for (const line of text.split('\n')) {
      const rec = line && parseRecord(line, f.agentId);
      if (rec) mergeRecord(idx.records, rec);
    }
    entry.offset += consumed;
    entry.size = st.size;
    changed = true;
  }
  if (changed) writeJsonAtomic(cache, idx);
  return { records: idx.records, agentTypes: idx.agentTypes, sources: report, changed };
}

// ---------------------------------------------------------------------------
// Attribution

// While a run waits for the human (an escalation sets a stage BLOCKED until
// the next stage starts or finishes), the orchestrator session may do other
// work; those messages are not the run's.
function waitingAt(board, iso) {
  let waiting = false;
  for (const t of board.timeline) {
    if (t.at > iso) break;
    if (t.status === 'BLOCKED') waiting = true;
    else if (t.status === 'ACTIVE' || t.status === 'DONE') waiting = false;
  }
  return waiting;
}

function roundAt(board, iso) {
  let n = -1;
  for (const t of board.timeline) {
    if (t.at > iso) break;
    if (t.stage === 'build' && t.status === 'ACTIVE') n++;
  }
  return Math.max(0, n);
}

export function attributionIndex(boards) {
  const agents = new Map();
  const orchestrators = [];
  for (const b of boards) {
    if (!b?.runId) continue;
    for (const [role, a] of Object.entries(b.agents)) {
      for (const s of a.sessions) {
        if (!s.agentId) continue;
        if (!agents.has(s.agentId)) agents.set(s.agentId, []);
        agents.get(s.agentId).push({ runId: b.runId, role, ...s });
      }
    }
    if (b.orchestrator?.sessionId && b.createdAt) orchestrators.push({ runId: b.runId, sessionId: b.orchestrator.sessionId, from: b.createdAt, to: b.endedAt, board: b });
  }
  for (const list of agents.values()) list.sort((x, y) => String(x.startedAt).localeCompare(String(y.startedAt)));
  return { agents, orchestrators, boards: new Map(boards.filter((b) => b?.runId).map((b) => [b.runId, b])) };
}

const iso = (t) => String(t ?? '').replace(/\.\d{3}Z$/, 'Z');
const plus = (t, s) => new Date(Date.parse(t) + s * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function attribute(rec, ai) {
  const t = iso(rec.t);
  if (rec.a) {
    const sessions = ai.agents.get(rec.a);
    if (!sessions) return { runId: null, role: 'other-subagent' };
    // A resumed agent keeps its id: the session whose start is the latest
    // one at or before this message (with a little grace for the gap
    // between spawning and recording) owns it.
    let s = sessions[0];
    for (const x of sessions) if (x.startedAt && x.startedAt <= plus(t, 120)) s = x;
    return { runId: s.runId, role: s.role, stage: s.stage, round: s.round, pass: s.pass, agentId: rec.a };
  }
  for (const o of ai.orchestrators) {
    if (o.sessionId === rec.s && t >= o.from && (!o.to || t <= o.to) && !waitingAt(o.board, t)) {
      return { runId: o.runId, role: 'orchestrator', stage: stageAt(o.board, t), round: roundAt(o.board, t) };
    }
  }
  return { runId: null, role: 'other-main' };
}

// ---------------------------------------------------------------------------
// Windows and summaries

// ccusage-style blocks: a block starts at the hour of its first message and
// lasts five hours; the next message after that starts a new block. This is
// a local reporting window, not Anthropic's plan quota.
export function currentFiveHourBlock(times, now) {
  const sorted = times.filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b);
  let start = null;
  for (const t of sorted) {
    if (start === null || t >= start + 5 * 3600e3) start = Math.floor(t / 3600e3) * 3600e3;
  }
  if (start === null || now >= start + 5 * 3600e3) return null;
  return { from: new Date(start).toISOString(), to: new Date(start + 5 * 3600e3).toISOString() };
}

const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, requests: 0, missing: 0 });
function add(acc, r) {
  acc.input += r.i;
  acc.output += r.o;
  acc.cacheWrite += r.cw;
  acc.cacheRead += r.cr;
  acc.total += r.i + r.o + r.cw + r.cr;
  acc.requests += 1;
  if (!r.u) acc.missing += 1;
}

function estimateCost(byModel, pricing) {
  if (!pricing || typeof pricing !== 'object') return { available: false, reason: 'No pricing is configured (factory/config.json usage.pricing), so no cost is shown.' };
  let total = 0;
  const rows = [];
  for (const m of byModel) {
    const p = pricing[m.family.toLowerCase()];
    if (!p || m.requests === 0) continue;
    const c = (m.input * (p.input ?? 0) + m.output * (p.output ?? 0) + m.cacheWrite * (p.cacheWrite ?? 0) + m.cacheRead * (p.cacheRead ?? 0)) / 1e6;
    rows.push({ family: m.family, usd: c });
    total += c;
  }
  return { available: true, estimate: true, usd: total, byModel: rows, note: 'API-equivalent estimate from configured per-million-token prices. Not a subscription charge.' };
}

export const ROLE_LABELS = { orchestrator: 'Orchestrator', 'other-main': 'Main sessions outside factory runs', 'other-subagent': 'Other subagents (not factory)' };

function summarize(entries, { config, board, label, key, from, to, pricing }) {
  const totals = zero();
  const models = new Map(FAMILIES.map((f) => [f, { family: f, ids: new Set(), ...zero() }]));
  const agents = new Map();
  const stages = new Map();
  const rounds = new Map();
  for (const { r, att } of entries) {
    add(totals, r);
    const fam = modelFamily(r.m);
    if (!models.has(fam)) models.set(fam, { family: fam, ids: new Set(), ...zero() });
    const mm = models.get(fam);
    mm.ids.add(r.m);
    add(mm, r);
    if (!agents.has(att.role)) agents.set(att.role, { role: att.role, observed: new Set(), sessions: new Set(), ...zero() });
    const ag = agents.get(att.role);
    ag.observed.add(r.m);
    if (att.agentId) ag.sessions.add(att.agentId);
    add(ag, r);
    if (att.runId) {
      const st = att.stage ?? 'request';
      if (!stages.has(st)) stages.set(st, zero());
      add(stages.get(st), r);
      const rd = att.round ?? 0;
      if (!rounds.has(rd)) rounds.set(rd, zero());
      add(rounds.get(rd), r);
    }
  }
  const share = (n) => (totals.total ? n / totals.total : 0);
  const byModel = [...models.values()].map(({ ids, ...m }) => ({ ...m, models: [...ids].sort(), used: m.requests > 0, share: share(m.total) }));

  const roles = [...Object.keys(config.agents), 'orchestrator'];
  const rows = [];
  for (const role of roles) {
    const ag = agents.get(role);
    const cfg = config.agents[role];
    if (!ag && key !== 'run') continue;
    rows.push({
      role,
      label: cfg?.label ?? ROLE_LABELS[role],
      configuredModel: cfg?.model ?? null,
      observedModels: ag ? [...ag.observed].sort() : [],
      status: role === 'orchestrator' ? (board?.status === 'RUNNING' ? 'RUNNING' : board?.runId ? 'DONE' : 'IDLE') : board?.agents?.[role]?.status ?? null,
      sessions: ag ? ag.sessions.size : 0,
      ...(ag ? (({ observed, sessions, role: _r, ...t }) => t)(ag) : zero()),
      share: ag ? share(ag.total) : 0,
    });
  }
  for (const role of ['other-main', 'other-subagent']) {
    const ag = agents.get(role);
    if (ag) rows.push({ role, label: ROLE_LABELS[role], unattributed: true, configuredModel: null, observedModels: [...ag.observed].sort(), status: null, sessions: ag.sessions.size, ...(({ observed, sessions, role: _r, ...t }) => t)(ag), share: share(ag.total) });
  }

  const roundLabel = (n) => board?.rounds?.find((r) => r.round === n)?.label ?? (n === 0 ? 'Initial build' : `Round ${n}`);
  return {
    key, label, from, to,
    totals,
    partial: totals.missing > 0,
    byModel,
    byAgent: rows,
    byStage: STAGES.filter((s) => stages.has(s)).map((s) => ({ stage: s, ...stages.get(s), share: share(stages.get(s).total) })),
    byRound: [...rounds.keys()].sort((a, b) => a - b).map((n) => ({ round: n, label: roundLabel(n), ...rounds.get(n), share: share(rounds.get(n).total) })),
    cost: estimateCost(byModel, pricing),
  };
}

// The full report for one selected run plus the time windows.
export function buildReport(index, { config, boards, runId, now = Date.now() }) {
  const ai = attributionIndex(boards);
  const board = ai.boards.get(runId) ?? null;
  const all = Object.values(index.records).map((r) => ({ r, att: attribute(r, ai) }));
  const pricing = config.usage.pricing;
  const available = index.sources.some((s) => s.exists && s.files > 0);
  const since = (ms) => new Date(now - ms).toISOString();
  const block = currentFiveHourBlock(all.map((e) => e.r.t), now);
  const nowIsoStr = new Date(now).toISOString();
  const windows = {
    run: summarize(all.filter((e) => runId && e.att.runId === runId), { config, board, key: 'run', label: 'This run', from: board?.createdAt ?? null, to: board?.endedAt ?? null, pricing }),
    '5h': summarize(block ? all.filter((e) => e.r.t >= block.from && e.r.t < block.to) : [], { config, board, key: '5h', label: 'Current 5-hour window', from: block?.from ?? null, to: block?.to ?? null, pricing }),
    '24h': summarize(all.filter((e) => e.r.t >= since(86400e3)), { config, board, key: '24h', label: 'Last 24 hours', from: since(86400e3), to: nowIsoStr, pricing }),
    '7d': summarize(all.filter((e) => e.r.t >= since(7 * 86400e3)), { config, board, key: '7d', label: 'Last 7 days', from: since(7 * 86400e3), to: nowIsoStr, pricing }),
    all: summarize(all, { config, board, key: 'all', label: 'All local history', from: all.reduce((m, e) => (e.r.t && (!m || e.r.t < m) ? e.r.t : m), null), to: nowIsoStr, pricing }),
  };
  windows['5h'].note = block
    ? 'Calculated locally from your session records (ccusage-style 5-hour block). It is not your plan\'s usage allowance.'
    : 'No messages in the last 5 hours, so no local 5-hour block is open.';
  return {
    generatedAt: nowIsoStr,
    runId,
    available,
    sources: index.sources,
    records: all.length,
    quota: { available: false, label: 'Unavailable', note: 'No supported local source reports your plan\'s quota or reset time.' },
    windows,
  };
}

// Refresh the index, then write factory/usage.json for the current run with
// a small total per archived run.
export function collectUsage(ctx, { boards, runId, now } = {}) {
  const index = refreshUsageIndex(ctx);
  const report = buildReport(index, { config: ctx.config, boards, runId, now });
  const ai = attributionIndex(boards);
  const perRun = {};
  for (const r of Object.values(index.records)) {
    const att = attribute(r, ai);
    if (!att.runId) continue;
    perRun[att.runId] ??= zero();
    add(perRun[att.runId], r);
  }
  const summary = { generatedAt: report.generatedAt, runId, available: report.available, sources: report.sources, quota: report.quota, windows: report.windows, runs: perRun };
  writeJsonAtomic(factoryPaths(ctx.factoryDir).usage, summary);
  return { report, index };
}
