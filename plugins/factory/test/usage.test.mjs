// Token monitoring on synthetic Claude Code session records.

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.mjs';
import { emptyBoard } from '../lib/board.mjs';
import { attribute, attributionIndex, buildReport, collectUsage, currentFiveHourBlock, mergeRecord, modelFamily, parseRecord, refreshUsageIndex } from '../lib/usage.mjs';
import { REAL_FACTORY, tmpRoot } from './helpers.mjs';

const NOW = Date.parse('2026-10-21T15:00:00Z');
const T = (min) => new Date(NOW - min * 60e3).toISOString();
const msg = ({ id, req = `req_${id}`, model = 'claude-opus-5-5', t, agentId, sidechain = Boolean(agentId), session = 'orch', usage = { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } }) =>
  JSON.stringify({ type: 'assistant', sessionId: session, agentId, isSidechain: sidechain, requestId: req, timestamp: t, uuid: `u-${id}-${Math.random()}`, message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'PRIVATE PROMPT TEXT' }], usage } });

function fixture() {
  const root = tmpRoot();
  const src = path.join(root, 'projects', 'proj');
  const sub = path.join(src, 'orch', 'subagents');
  mkdirSync(sub, { recursive: true });
  const files = {
    main: path.join(src, 'orch.jsonl'),
    other: path.join(src, 'other-session.jsonl'),
    spec: path.join(sub, 'agent-aspec.jsonl'),
    build: path.join(sub, 'agent-abuild.jsonl'),
    build2: path.join(sub, 'agent-abuild2.jsonl'),
    ux: path.join(sub, 'agent-aux.jsonl'),
    explore: path.join(sub, 'agent-aexplore.jsonl'),
  };
  writeFileSync(files.main, [
    JSON.stringify({ type: 'user', message: { content: 'secret prompt' } }),
    msg({ id: 'm-before', t: T(200) }), // before the run: not run consumption
    msg({ id: 'm1', t: T(100) }),
    msg({ id: 'm1', t: T(100), usage: { input_tokens: 10, output_tokens: 40, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000 } }), // incremental snapshot
    msg({ id: 'm1', t: T(100) }), // repeated record
    msg({ id: 'm2', t: T(20), model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } }),
    msg({ id: 'm3', t: T(15), usage: null }), // no usage at all
    '{"type":"assistant", broken json',
  ].join('\n') + '\n');
  writeFileSync(files.other, msg({ id: 'o1', t: T(60 * 30), session: 'other', model: 'claude-sonnet-5-5' }) + '\n');
  writeFileSync(files.spec, msg({ id: 's1', t: T(95), agentId: 'aspec' }) + '\n');
  // the builder is resumed for revision 1 (same id), then restarted (new id)
  writeFileSync(files.build, [msg({ id: 'b1', t: T(80), agentId: 'abuild' }), msg({ id: 'b2', t: T(40), agentId: 'abuild' })].join('\n') + '\n');
  writeFileSync(files.build2, msg({ id: 'b3', t: T(25), agentId: 'abuild2' }) + '\n');
  // UX configured as Sonnet; this one record really ran on Haiku
  writeFileSync(files.ux, [msg({ id: 'x1', t: T(60), agentId: 'aux', model: 'claude-sonnet-5-5' }), msg({ id: 'x2', t: T(59), agentId: 'aux', model: 'claude-haiku-5-5' })].join('\n') + '\n');
  writeFileSync(files.explore, msg({ id: 'e1', t: T(50), agentId: 'aexplore', model: 'claude-haiku-5-5' }) + '\n');
  writeFileSync(path.join(sub, 'agent-aexplore.meta.json'), JSON.stringify({ agentType: 'Explore' }));
  return { root, src, files };
}

function fixtureBoard(config) {
  const b = emptyBoard(config);
  Object.assign(b, { runId: '20261021-1320-demo', status: 'MERGED', createdAt: T(105).replace(/\.\d{3}Z$/, 'Z'), endedAt: T(10).replace(/\.\d{3}Z$/, 'Z'), orchestrator: { sessionId: 'orch' } });
  b.timeline = [
    { at: T(105), stage: 'spec', status: 'ACTIVE' },
    { at: T(85), stage: 'build', status: 'ACTIVE' },
    { at: T(65), stage: 'review', status: 'ACTIVE' },
    { at: T(45), stage: 'build', status: 'ACTIVE' },
    { at: T(30), stage: 'build', status: 'ACTIVE' },
    { at: T(12), stage: 'approve', status: 'ACTIVE' },
  ].map((x) => ({ ...x, at: x.at.replace(/\.\d{3}Z$/, 'Z') }));
  const s = (agentId, stage, round, startedMin, pass = null) => ({ agentId, stage, round, pass, startedAt: T(startedMin).replace(/\.\d{3}Z$/, 'Z'), endedAt: null });
  b.agents['spec-writer'].sessions = [s('aspec', 'spec', 0, 100)];
  b.agents.builder.sessions = [s('abuild', 'build', 0, 85), { ...s('abuild', 'build', 1, 45), resumed: true }, s('abuild2', 'build', 2, 30)];
  b.agents.ux.sessions = [s('aux', 'review', 0, 65, 1)];
  b.rounds = [{ round: 0, label: 'Initial build' }, { round: 1, label: 'Revision 1' }, { round: 2, label: 'Revision 2' }];
  return b;
}

function setup() {
  const fx = fixture();
  const factoryDir = path.join(fx.root, 'factory');
  mkdirSync(factoryDir);
  const config = loadConfig(REAL_FACTORY);
  config.usage.sources = [fx.src];
  const ctx = { factoryDir, repoDir: fx.root, config };
  return { ...fx, ctx, config, board: fixtureBoard(config) };
}

const famRow = (w, f) => w.byModel.find((m) => m.family === f);
const roleRow = (w, r) => w.byAgent.find((m) => m.role === r);

test('parsing keeps only ids, model, time and the four counters', () => {
  const rec = parseRecord(msg({ id: 'p1', t: T(1), agentId: 'ax' }));
  assert.deepEqual(Object.keys(rec).sort(), ['a', 'cr', 'cw', 'i', 'key', 'm', 'o', 's', 't', 'u']);
  assert.equal(JSON.stringify(rec).includes('PRIVATE'), false);
  assert.equal(parseRecord(msg({ id: 'p2', model: '<synthetic>' })), null);
  assert.equal(parseRecord('{"type":"user"}'), null);
  assert.equal(parseRecord('not json "assistant"'), null);
  assert.deepEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-x'].map(modelFamily), ['Opus', 'Sonnet', 'Haiku', 'Other']);
});

test('duplicates and incremental snapshots count once, with the largest value per field', () => {
  const records = {};
  mergeRecord(records, parseRecord(msg({ id: 'd', t: T(5), usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 } })));
  mergeRecord(records, parseRecord(msg({ id: 'd', t: T(5), usage: { input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 } })));
  mergeRecord(records, parseRecord(msg({ id: 'd', t: T(5), usage: { input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 7 } })));
  assert.equal(Object.keys(records).length, 1);
  assert.deepEqual([records['d|req_d'].i, records['d|req_d'].o, records['d|req_d'].cr], [3, 9, 7]);
});

test('per-model, per-agent, orchestrator, stages and rounds for a run', (t) => {
  const s = setup();
  const index = refreshUsageIndex(s.ctx);
  const report = buildReport(index, { config: s.config, boards: [s.board], runId: s.board.runId, now: NOW });
  const run = report.windows.run;
  const per = 10 + 5 + 100 + 1000; // one standard message
  // orchestrator m1 (output 40 after dedup) + m3 (no usage) are in the run window; m-before is not
  const orch = roleRow(run, 'orchestrator');
  assert.equal(orch.requests, 2);
  assert.equal(orch.total, 10 + 40 + 100 + 1000);
  assert.equal(orch.missing, 1);
  assert.equal(run.partial, true, 'a record without usage marks the window partial');
  assert.equal(roleRow(run, 'spec-writer').total, per);
  // resumed + restarted builder: one role, two sessions, three messages
  const builder = roleRow(run, 'builder');
  assert.equal(builder.requests, 3);
  assert.equal(builder.sessions, 2);
  assert.equal(builder.total, 3 * per);
  // configured Sonnet, observed Sonnet and Haiku: never assumed
  const ux = roleRow(run, 'ux');
  assert.deepEqual(ux.observedModels, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.equal(famRow(run, 'Haiku').requests, 1);
  assert.equal(famRow(run, 'Sonnet').requests, 1);
  // roles that did not run are listed with zero, not dropped
  assert.equal(roleRow(run, 'approver').total, 0);
  assert.equal(famRow(run, 'Opus').requests, 1 + 1 + 1 + 3);
  assert.ok(Math.abs(run.byModel.reduce((a, m) => a + m.share, 0) - 1) < 1e-9);
  // the non-factory Explore agent is not in the run
  assert.equal(run.byAgent.some((r) => r.role === 'other-subagent'), false);
  // rounds: initial build 0, revision 1 (resumed id), revision 2 (restart)
  const rounds = Object.fromEntries(run.byRound.map((r) => [r.label, r.requests]));
  assert.deepEqual(rounds, { 'Initial build': 5, 'Revision 1': 1, 'Revision 2': 2 });
  const byAgentRound = (id) => attribute(index.records[`${id}|req_${id}`], attributionIndex([s.board]));
  assert.deepEqual([byAgentRound('b1').round, byAgentRound('b2').round, byAgentRound('b3').round], [0, 1, 2]);
  assert.equal(byAgentRound('x1').stage, 'review');
  assert.equal(byAgentRound('m1').stage, 'spec');
  assert.equal(byAgentRound('m3').stage, 'build');
  const stages = Object.fromEntries(run.byStage.map((x) => [x.stage, x.requests]));
  assert.equal(stages.build, 4);
  // no cost without configured pricing, and no invented quota
  assert.equal(run.cost.available, false);
  assert.equal(report.quota.available, false);
});

test('reporting windows filter by time; unattributed usage is labelled', (t) => {
  const s = setup();
  const index = refreshUsageIndex(s.ctx);
  const report = buildReport(index, { config: s.config, boards: [s.board], runId: s.board.runId, now: NOW });
  const w = report.windows;
  assert.equal(w['24h'].totals.requests, 10, 'everything but the 30-hour-old session');
  assert.equal(w['7d'].totals.requests, 11);
  assert.equal(w.all.totals.requests, 11);
  const other = roleRow(w['24h'], 'other-subagent');
  assert.equal(other.requests, 1);
  assert.equal(other.unattributed, true);
  assert.equal(roleRow(w['24h'], 'other-main').requests, 1, 'the orchestrator session before the run started');
  // the open 5-hour block began at the hour of the first message after a 5-hour gap
  assert.equal(currentFiveHourBlock([T(300), T(100)], NOW), null, 'a block that began at 10:00 closed at 15:00');
  assert.deepEqual(currentFiveHourBlock([T(200), T(100)], NOW), { from: '2026-10-21T11:00:00.000Z', to: '2026-10-21T16:00:00.000Z' });
  assert.equal(w['5h'].from, '2026-10-21T11:00:00.000Z');
  assert.equal(w['5h'].totals.requests, 10, 'the 11:40 message opened the block; the 30-hour-old one is outside');
  const blk = currentFiveHourBlock([T(60 * 30), T(100), T(5)], NOW);
  assert.equal(blk.from, '2026-10-21T13:00:00.000Z');
  assert.equal(currentFiveHourBlock([T(60 * 8)], NOW), null, 'no open block after 5 quiet hours');
  assert.match(w['5h'].note, /not your plan's usage allowance/);
});

test('orchestrator messages while the run waits for the human are not the run\'s', () => {
  const s = setup();
  // escalated at T(20), approved at T(14): m3 at T(15) falls in the wait
  s.board.timeline.push({ at: T(20).replace(/\.\d{3}Z$/, 'Z'), stage: 'approve', status: 'BLOCKED' }, { at: T(14).replace(/\.\d{3}Z$/, 'Z'), stage: 'approve', status: 'DONE' });
  s.board.timeline.sort((a, b) => a.at.localeCompare(b.at));
  const index = refreshUsageIndex(s.ctx);
  const ai = attributionIndex([s.board]);
  assert.equal(attribute(index.records['m3|req_m3'], ai).role, 'other-main');
  assert.equal(attribute(index.records['m1|req_m1'], ai).role, 'orchestrator');
});

test('pricing, when configured, gives a labelled estimate', () => {
  const s = setup();
  s.config.usage.pricing = { opus: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 } };
  const report = buildReport(refreshUsageIndex(s.ctx), { config: s.config, boards: [s.board], runId: s.board.runId, now: NOW });
  const c = report.windows.run.cost;
  assert.equal(c.available, true);
  assert.equal(c.estimate, true);
  assert.match(c.note, /Not a subscription charge/);
  assert.ok(c.usd > 0);
});

test('incremental refresh reads only new lines and never double counts on re-parse', () => {
  const s = setup();
  const first = refreshUsageIndex(s.ctx);
  const count = Object.keys(first.records).length;
  const again = refreshUsageIndex(s.ctx);
  assert.equal(again.changed, false);
  assert.equal(Object.keys(again.records).length, count);
  appendFileSync(s.files.spec, msg({ id: 's2', t: T(2), agentId: 'aspec' }) + '\n' + msg({ id: 's1', t: T(95), agentId: 'aspec' }) + '\n');
  const third = refreshUsageIndex(s.ctx);
  assert.equal(Object.keys(third.records).length, count + 1);
  const cache = readFileSync(path.join(s.ctx.factoryDir, '.cache', 'usage-index.json'), 'utf8');
  assert.equal(cache.includes('PRIVATE PROMPT TEXT') || cache.includes('secret prompt'), false, 'no prompt text is stored');
});

test('missing sources are unavailable, and collecting never touches the board', () => {
  const s = setup();
  const boardFile = path.join(s.ctx.factoryDir, 'board.json');
  writeFileSync(boardFile, JSON.stringify(s.board));
  const before = readFileSync(boardFile, 'utf8');
  collectUsage(s.ctx, { boards: [s.board], runId: s.board.runId, now: NOW });
  assert.equal(readFileSync(boardFile, 'utf8'), before);
  const usage = JSON.parse(readFileSync(path.join(s.ctx.factoryDir, 'usage.json'), 'utf8'));
  assert.equal(usage.runs['20261021-1320-demo'].requests > 0, true);
  s.config.usage.sources = [path.join(s.root, 'nope')];
  const r = buildReport(refreshUsageIndex({ ...s.ctx, factoryDir: path.join(s.root, 'f2') }), { config: s.config, boards: [], runId: null, now: NOW });
  assert.equal(r.available, false);
  assert.equal(r.sources[0].exists, false);
});
