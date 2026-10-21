// The factory dashboard: a development-only, read-only HTTP server bound to
// localhost. It serves the static UI and four JSON endpoints. It never
// writes the board; the only file it writes is the derived usage summary
// (factory/usage.json and its cache), through the usage collector.
//
//   node factory/dashboard/server.mjs [--port N]
//   FACTORY_DIR / FACTORY_REPO point it at another factory (tests).

import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_FACTORY_DIR, DEFAULT_REPO_DIR, factoryPaths, loadConfig } from '../lib/config.mjs';
import { loadBoards, readBoard } from '../lib/board.mjs';
import { sha256 } from '../lib/fsutil.mjs';
import { FileError, RUN_ID_RE, downloadArtifact, readArtifact } from '../lib/files.mjs';
import { buildReport, collectUsage } from '../lib/usage.mjs';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const STATIC = {
  'app.mjs': 'text/javascript; charset=utf-8',
  'util.mjs': 'text/javascript; charset=utf-8',
  'markdown.mjs': 'text/javascript; charset=utf-8',
  'highlight.mjs': 'text/javascript; charset=utf-8',
  'diff.mjs': 'text/javascript; charset=utf-8',
  'workflow.mjs': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export function createDashboard(ctx, { port } = {}) {
  const cfg = ctx.config.dashboard;
  const host = cfg.host;
  if (process.env.NODE_ENV === 'production') throw new Error('The factory dashboard is development-only and refuses to run with NODE_ENV=production.');
  if (!LOOPBACK.has(host)) throw new Error(`The factory dashboard only binds to localhost (config says ${host}).`);
  const paths = factoryPaths(ctx.factoryDir);
  let usageCache = { at: 0, index: null, error: null };

  function refreshUsage(boards, runId) {
    if (Date.now() - usageCache.at < cfg.usagePollMs && usageCache.index) return usageCache;
    try {
      const { index } = collectUsage(ctx, { boards, runId });
      usageCache = { at: Date.now(), index, error: null };
    } catch (e) {
      usageCache = { at: Date.now(), index: usageCache.index, error: e.message };
    }
    return usageCache;
  }

  function selectedBoard(url) {
    const run = url.searchParams.get('run');
    const current = readBoard(paths.board, ctx.config);
    if (!run || run === current.board.runId) return { ...current, current: true };
    if (!RUN_ID_RE.test(run)) throw new FileError(400, 'invalid run id');
    const file = path.join(paths.runs, run, 'run.json');
    try {
      statSync(file);
    } catch {
      throw new FileError(404, 'unknown run');
    }
    const r = readBoard(file, ctx.config);
    if (r.board.runId !== run) throw new FileError(404, 'unknown run');
    return { ...r, current: false };
  }

  function send(req, res, status, body, type, extra = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const etag = `"${sha256(buf).slice(0, 32)}"`;
    const headers = { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-cache', ETag: etag, ...extra };
    if (status === 200 && req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(status, { ...headers, 'Content-Length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }
  const json = (req, res, status, value) => send(req, res, status, JSON.stringify(value), 'application/json; charset=utf-8');

  function handle(req, res) {
    // DNS-rebinding guard: only answer requests addressed to localhost.
    const hostHeader = String(req.headers.host ?? '');
    const hostname = hostHeader.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    if (!LOOPBACK.has(hostname)) return json(req, res, 421, { error: 'This dashboard only answers on localhost.' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'read-only' });
    const url = new URL(req.url, `http://${hostHeader || 'localhost'}`);

    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(req, res, 200, readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');
    }
    if (url.pathname.startsWith('/static/')) {
      const name = url.pathname.slice('/static/'.length);
      if (!Object.hasOwn(STATIC, name)) return json(req, res, 404, { error: 'not found' });
      return send(req, res, 200, readFileSync(path.join(PUBLIC, name)), STATIC[name]);
    }
    if (url.pathname === '/favicon.ico') return send(req, res, 204, '', 'image/x-icon');

    if (url.pathname === '/api/state') {
      const sel = selectedBoard(url);
      const currentRunId = readBoard(paths.board, ctx.config).board.runId;
      const runs = loadBoards(ctx.factoryDir, ctx.config).map((b) => ({ runId: b.runId, title: b.feature?.title ?? b.runId, status: b.status, createdAt: b.createdAt, updatedAt: b.updatedAt }));
      return json(req, res, 200, {
        board: sel.board,
        valid: sel.ok,
        errors: sel.errors,
        current: sel.current,
        currentRunId,
        runs,
        config: { agents: ctx.config.agents, revisionMax: ctx.config.revisionMax, pollMs: cfg.pollMs, usagePollMs: cfg.usagePollMs },
      });
    }
    if (url.pathname === '/api/usage') {
      const sel = selectedBoard(url);
      const boards = loadBoards(ctx.factoryDir, ctx.config);
      const current = readBoard(paths.board, ctx.config).board;
      const u = refreshUsage(boards, current.runId);
      if (!u.index) return json(req, res, 200, { available: false, error: u.error ?? 'no usage data yet' });
      const report = buildReport(u.index, { config: ctx.config, boards, runId: sel.board.runId });
      return json(req, res, 200, { ...report, error: u.error });
    }
    if (url.pathname === '/api/artifact') {
      const sel = selectedBoard(url);
      const id = url.searchParams.get('id');
      const version = url.searchParams.get('version') ?? undefined;
      if (url.searchParams.get('download') === '1') {
        const { name, buf } = downloadArtifact(ctx, sel.board, id, { version });
        return send(req, res, 200, buf, 'application/octet-stream', { 'Content-Disposition': `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, '_')}"`, 'Cache-Control': 'no-store' });
      }
      const result = readArtifact(ctx, sel.board, id, { view: url.searchParams.get('view') ?? 'content', version, against: url.searchParams.get('against') ?? undefined });
      return json(req, res, 200, result);
    }
    return json(req, res, 404, { error: 'not found' });
  }

  const server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch (e) {
      const status = e instanceof FileError ? e.status : 500;
      if (status === 500) console.error('[factory dashboard]', e);
      json(req, res, status, { error: status === 500 ? 'internal error (see the dashboard terminal)' : e.message });
    }
  });
  return { server, listen: () => new Promise((resolve) => server.listen(port ?? cfg.port, host, () => resolve(server.address()))) };
}

export async function startServer(ctx, opts = {}) {
  const { listen } = createDashboard(ctx, opts);
  const addr = await listen();
  console.log(`Factory dashboard: http://${addr.address === '::1' ? '[::1]' : addr.address}:${addr.port}/  (development only, Ctrl-C to stop)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const i = process.argv.indexOf('--port');
  const ctx = { repoDir: DEFAULT_REPO_DIR, factoryDir: DEFAULT_FACTORY_DIR, config: loadConfig(DEFAULT_FACTORY_DIR, { repoDir: DEFAULT_REPO_DIR }) };
  startServer(ctx, { port: i > 0 ? Number(process.argv[i + 1]) : undefined }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
