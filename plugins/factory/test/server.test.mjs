// The dashboard server: localhost only, read-only, development only.

import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import path from 'node:path';
import { createDashboard, locateDashboard, probeDashboard } from '../dashboard/server.mjs';
import * as wf from '../lib/workflow.mjs';
import { readBoard } from '../lib/board.mjs';
import { repoId } from '../lib/config.mjs';
import { makeRepo, startAndBuild } from './helpers.mjs';

function get(port, p, { host = `127.0.0.1:${port}`, method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: p, method, headers: { host, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('serves the UI and the board on localhost, read-only, with safe errors', async (t) => {
  const r = makeRepo({ humanChanges: false });
  t.after(r.cleanup);
  startAndBuild(wf, r.ctx);
  const { server, listen } = createDashboard(r.ctx, { port: 0 });
  const { port } = await listen();
  t.after(() => server.close());

  const index = await get(port, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(index.headers['x-content-type-options'], 'nosniff');
  assert.match(index.body, /Software Factory/);
  assert.equal((await get(port, '/static/app.mjs')).status, 200);
  assert.equal((await get(port, '/static/../../lib/board.mjs')).status, 404);
  assert.equal((await get(port, '/static/%2e%2e%2fserver.mjs')).status, 404);

  const state = await get(port, '/api/state');
  assert.equal(state.status, 200);
  const body = JSON.parse(state.body);
  assert.equal(body.board.status, 'RUNNING');
  assert.equal(body.valid, true);
  assert.equal(body.board.artifacts.some((a) => 'text' in a), false, 'no document bodies in the board');
  const again = await get(port, '/api/state', { headers: { 'if-none-match': state.headers.etag } });
  assert.equal(again.status, 304, 'unchanged board: nothing to download or re-render');

  assert.equal((await get(port, '/api/state', { host: 'evil.example:80' })).status, 421, 'DNS rebinding');
  assert.equal((await get(port, '/api/state', { method: 'POST' })).status, 405);
  assert.equal((await get(port, '/api/artifact?id=../../etc/passwd')).status, 400);
  assert.equal((await get(port, '/api/artifact?id=a0000000000000000')).status, 404);
  assert.equal((await get(port, '/api/state?run=../../x')).status, 400);
  assert.equal((await get(port, '/api/state?run=20200101-0000-nope')).status, 404);

  const b = readBoard(path.join(r.factoryDir, 'board.json'), r.ctx.config).board;
  const spec = b.artifacts.find((a) => a.path === 'spec.md');
  const doc = JSON.parse((await get(port, `/api/artifact?id=${spec.id}`)).body);
  assert.equal(doc.kind, 'markdown');
  const dl = await get(port, `/api/artifact?id=${spec.id}&download=1`);
  assert.match(dl.headers['content-disposition'], /attachment; filename="spec.md"/);
  const usage = JSON.parse((await get(port, '/api/usage')).body);
  assert.equal(usage.available, false, 'no session records configured in the scratch factory');
});

test('dashboard-status tells this repository\'s dashboard from another one and from none', async (t) => {
  const a = makeRepo({ humanChanges: false });
  t.after(a.cleanup);
  const b = makeRepo({ humanChanges: false });
  t.after(b.cleanup);
  const run = startAndBuild(wf, a.ctx).run;
  const { server, listen } = createDashboard(a.ctx, { port: 0 });
  const { port } = await listen();
  let open = true;
  t.after(() => open && server.close());

  const state = JSON.parse((await get(port, '/api/state')).body);
  assert.equal(state.repoId, repoId(a.ctx.repoDir));
  assert.equal(state.repoId.includes('/'), false, 'no path on the wire');

  const ours = await probeDashboard(a.ctx, { port });
  assert.deepEqual(ours, { state: 'ours', url: `http://127.0.0.1:${port}/`, port, currentRunId: run.runId });
  assert.equal((await probeDashboard(b.ctx, { port })).state, 'other', 'answers, but for another repository');

  // Without a port: the configured one and the next two.
  const onPort = (ctx, p) => ({ ...ctx, config: { ...ctx.config, dashboard: { ...ctx.config.dashboard, port: p } } });
  assert.deepEqual(await locateDashboard(onPort(a.ctx, port)), ours, 'found on the configured port');
  assert.deepEqual(await locateDashboard(onPort(a.ctx, port - 1)), ours, 'found on the next port, where it starts when the first is held');
  const elsewhere = await locateDashboard(onPort(b.ctx, port));
  assert.notEqual(elsewhere.state, 'ours');
  assert.notEqual(elsewhere.port, port, 'another repository is never pointed at this dashboard');

  await new Promise((resolve) => server.close(resolve));
  open = false;
  assert.equal((await probeDashboard(a.ctx, { port })).state, 'down');
  assert.deepEqual(await locateDashboard(onPort(a.ctx, port)), { state: 'down', url: null, port, currentRunId: null }, 'nothing running: the first free port to start on, and no address to hand over');
});

test('refuses production and non-loopback binds', () => {
  const r = makeRepo({ humanChanges: false });
  try {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    assert.throws(() => createDashboard(r.ctx), /development-only/);
    process.env.NODE_ENV = prev;
    if (prev === undefined) delete process.env.NODE_ENV;
    assert.throws(() => createDashboard({ ...r.ctx, config: { ...r.ctx.config, dashboard: { ...r.ctx.config.dashboard, host: '0.0.0.0' } } }), /only binds to localhost/);
  } finally {
    r.cleanup();
  }
});
