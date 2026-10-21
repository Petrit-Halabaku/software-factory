// Factory dashboard. Polls /api/state and /api/usage, and re-renders only the
// sections whose data changed, so an unchanged board causes no DOM work at
// all (no flicker, no layout shift). Document contents are fetched only when
// a file is opened in the drawer.

import { ago, chip, clock, compact, esc, hashString, num, pct, short, statusLabel, storageGet, storageSet, timeZone, tone, when } from './util.mjs';
import { renderMarkdown } from './markdown.mjs';
import { highlightLines, LANGUAGE_NAMES } from './highlight.mjs';
import { renderDiff } from './diff.mjs';
import { renderWorkflow } from './workflow.mjs';

const $ = (sel, root = document) => root.querySelector(sel);
const params = new URLSearchParams(location.search);

const S = {
  run: params.get('run') || null,
  state: null,
  stateText: null,
  usage: null,
  usageText: null,
  usageError: null,
  window: storageGet('window', 'run'),
  collapsed: storageGet('collapsed', {}),
  filter: '',
  logAll: false,
  requestOpen: false,
  lastOk: null,
  failing: false,
  sigs: {},
  drawer: null,
};

const ROLE_ORDER = ['spec-writer', 'builder', 'security', 'ux', 'ui-design', 'code', 'approver'];
const MODEL_NAME = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const modelName = (m) => MODEL_NAME[m] ?? m ?? '—';
const famOf = (id) => (/opus/i.test(id) ? 'Opus' : /sonnet/i.test(id) ? 'Sonnet' : /haiku/i.test(id) ? 'Haiku' : 'Other');

const qs = (extra = {}) => {
  const p = new URLSearchParams();
  if (S.run) p.set('run', S.run);
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

function section(id, sigData, render) {
  const el = document.getElementById(id);
  if (!el) return;
  const sig = hashString(JSON.stringify(sigData));
  if (S.sigs[id] === sig) return;
  S.sigs[id] = sig;
  el.innerHTML = render();
}

const artById = (id) => S.state?.board.artifacts.find((a) => a.id === id);
const isReady = (a) => a && (a.status === 'READY' || a.status === 'UPDATED');
const runFile = (rel) => S.state?.board.artifacts.find((a) => a.kind === 'run-file' && a.path === rel);
const openBtn = (a, label, cls = 'btn btn-sm') =>
  a ? `<button type="button" class="${cls}" data-open-artifact="${esc(a.id)}"${isReady(a) ? '' : ' disabled'} title="${esc(a.path)}">${esc(label)}${isReady(a) ? '' : ` · ${esc(statusLabel(a.status))}`}</button>` : '';

// ---------------------------------------------------------------------------
// Sections

function renderHeader() {
  const { board, runs, current, currentRunId } = S.state;
  section('run-select-wrap', { runs, sel: board.runId, current, currentRunId }, () => {
    if (!runs.length) return '<span class="muted">No runs yet</span>';
    const idle = !currentRunId ? `<option value=""${!board.runId ? ' selected' : ''}>No active run</option>` : '';
    return `<label class="sr-only" for="run-select">Run</label><select id="run-select" class="select">${idle}${runs.map((r) => `<option value="${esc(r.runId)}"${r.runId === board.runId ? ' selected' : ''}>${esc(r.title)} · ${esc(statusLabel(r.status))}</option>`).join('')}</select>`;
  });
  section('run-status', { s: board.status, current }, () => `${chip(board.status)}${current ? '' : '<span class="chip chip-mute">Archived run</span>'}`);
}

function renderAlerts() {
  const { valid, errors } = S.state;
  section('alerts', { valid, errors, failing: S.failing, usageError: S.usageError }, () => {
    const out = [];
    if (S.failing) out.push(`<div class="alert alert-bad" role="alert"><strong>Dashboard server unreachable.</strong> Showing the last data received; retrying every few seconds. Start it with <code>node factory/bin/fac.mjs dashboard</code>.</div>`);
    if (!valid) out.push(`<div class="alert alert-warn" role="alert"><strong>The board has problems.</strong> It is shown with safe defaults.<ul>${errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>`);
    return out.join('');
  });
}

function renderRun() {
  const { board } = S.state;
  const docs = ['spec.md', 'plan.md', 'build.md', 'approval.md', 'escalation.md', 'merge.md'].map(runFile).filter(Boolean);
  section('run', { f: board.feature, runId: board.runId, branch: board.branch, start: board.startCommit, fb: board.factoryBranch, wt: board.worktree, rev: board.revision, createdAt: board.createdAt, endedAt: board.endedAt, docs: docs.map((d) => [d.id, d.status]), open: S.requestOpen, status: board.status }, () => {
    if (!board.runId) {
      return `<div class="empty-state"><h2>No factory run yet</h2><p>Start one from Claude Code with <code>/factory &lt;feature request&gt;</code>. This page updates by itself.</p></div>`;
    }
    const label = { 'spec.md': 'View Spec', 'plan.md': 'View Plan', 'build.md': 'View build.md', 'approval.md': 'View approval', 'escalation.md': 'View escalation', 'merge.md': 'View merge notes' };
    const req = board.feature?.request ?? '';
    const long = req.length > 220;
    return `<div class="run-head">
      <div class="run-title"><h2>${esc(board.feature?.title ?? board.runId)}</h2><p class="mono muted small">${esc(board.runId)}</p></div>
      <div class="run-docs">${docs.map((d) => openBtn(d, label[d.path])).join('')}</div>
    </div>
    <blockquote class="request${long && !S.requestOpen ? ' clamp' : ''}" id="request-text">${esc(req)}</blockquote>
    ${long ? `<button type="button" class="link-btn" data-toggle-request aria-expanded="${S.requestOpen}" aria-controls="request-text">${S.requestOpen ? 'Show less' : 'Show the whole request'}</button>` : ''}
    <dl class="facts">
      <div><dt>Started from</dt><dd><span class="mono">${esc(board.branch)}</span> @ <span class="mono">${esc(short(board.startCommit))}</span></dd></div>
      <div><dt>Factory branch</dt><dd class="mono">${esc(board.factoryBranch ?? '—')}</dd></div>
      <div><dt>Worktree</dt><dd class="mono">${esc(board.worktree ?? '—')}</dd></div>
      <div><dt>Revisions</dt><dd>${board.revision.round} of ${board.revision.max}${board.revision.human ? ` · ${board.revision.human} by you` : ''}</dd></div>
      <div><dt>Started</dt><dd>${esc(when(board.createdAt))}</dd></div>
      <div><dt>${board.endedAt ? 'Ended' : 'Updated'}</dt><dd>${esc(when(board.endedAt ?? board.updatedAt))}</dd></div>
    </dl>`;
  });
}

function renderWorkflowSection() {
  const { board, config } = S.state;
  section('workflow-body', { st: board.stages, ag: Object.fromEntries(Object.entries(board.agents).map(([k, v]) => [k, v.status])), rv: board.reviews.at(-1)?.results, rev: board.revision, ap: board.approval, status: board.status, rounds: board.rounds.map((r) => r.label), arts: board.artifacts.filter((a) => a.kind === 'run-file').map((a) => [a.path, a.status]), feat: Boolean(board.feature), wt: board.factoryBranch }, () => renderWorkflow(board, config));
}

function usageRole(role) {
  return S.usage?.windows?.run?.byAgent?.find((r) => r.role === role) ?? null;
}

function renderAgents() {
  const { board, config } = S.state;
  const roles = ROLE_ORDER.filter((r) => config.agents[r]).concat(Object.keys(config.agents).filter((r) => !ROLE_ORDER.includes(r)));
  const sig = { a: board.agents, u: S.usage?.windows?.run?.byAgent?.map((r) => [r.role, r.total, r.observedModels]), status: board.status, orch: board.orchestrator };
  section('agents-body', sig, () => {
    const row = (role, label, configured, status, sessions, u) => {
      const observed = u?.observedModels ?? [];
      const mismatch = configured && observed.length && observed.some((m) => famOf(m) !== modelName(configured));
      return `<tr>
        <th scope="row">${esc(label)}</th>
        <td>${configured ? `<span class="model model-${esc(configured)}">${esc(modelName(configured))}</span>` : '<span class="muted">—</span>'}${observed.length ? `<div class="small ${mismatch ? 'text-warn' : 'muted'}" title="Models seen in the session records">${mismatch ? 'observed ' : ''}${esc(observed.join(', '))}</div>` : ''}</td>
        <td>${status ? chip(status) : '<span class="muted">—</span>'}</td>
        <td class="num hide-sm">${sessions}</td>
        <td class="num">${u ? esc(compact(u.total)) : '<span class="muted">—</span>'}</td>
        <td class="num hide-sm">${u ? esc(pct(u.share)) : '<span class="muted">—</span>'}</td>
      </tr>`;
    };
    const rows = roles.map((role) => {
      const a = board.agents[role];
      return row(role, config.agents[role].label, config.agents[role].model, a?.status ?? 'IDLE', a?.sessions.length ?? 0, usageRole(role));
    });
    const orch = usageRole('orchestrator');
    rows.push(row('orchestrator', 'Orchestrator', null, board.runId ? (board.status === 'RUNNING' ? 'RUNNING' : 'DONE') : 'IDLE', board.orchestrator?.sessionId ? 1 : 0, orch));
    return `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Status</th><th scope="col" class="num hide-sm">Sessions</th><th scope="col" class="num">Tokens</th><th scope="col" class="num hide-sm">Share</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>
    <p class="small muted">Tokens: this run, from Claude Code's session records. Orchestrator model: ${esc(orch?.observedModels?.join(', ') || board.orchestrator?.model || 'not observed yet')}.</p>`;
  });
}

function renderReviews() {
  const { board, config } = S.state;
  const areas = Object.values(config.agents).filter((a) => a.stage === 'review');
  section('reviews-body', { r: board.reviews, c: board.requestedChanges, rounds: board.rounds.map((r) => [r.round, r.label, r.commit]), arts: board.artifacts.filter((a) => a.category === 'review').map((a) => [a.id, a.status]) }, () => {
    if (!board.reviews.length) return '<p class="empty">No review pass yet. The four reviewers run in parallel after each committed build.</p>';
    const rows = board.reviews.map((p) => {
      const round = board.rounds.find((r) => r.round === p.round);
      return `<tr><th scope="row"><div>Pass ${p.pass}</div><div class="small muted">${esc(round?.label ?? `Round ${p.round}`)} · <span class="mono">${esc(short(p.commit))}</span></div></th>${areas
        .map((a) => {
          const r = p.results[a.area];
          const art = r?.artifactId ? artById(r.artifactId) : null;
          const inner = chip(r?.status ?? 'PENDING', r?.status === 'RUNNING' ? 'Running' : statusLabel(r?.status ?? 'PENDING'));
          return `<td>${isReady(art) ? `<button type="button" class="cell-btn" data-open-artifact="${esc(art.id)}" aria-label="View ${esc(a.label)} review, pass ${p.pass}: ${esc(r.status)}">${inner}<span class="view-hint">View</span></button>` : inner}${r?.note ? `<div class="small text-warn">${esc(r.note)}</div>` : ''}</td>`;
        })
        .join('')}</tr>`;
    });
    const last = board.reviews.at(-1).pass;
    const changes = board.requestedChanges.filter((c) => c.pass === last);
    const older = board.requestedChanges.filter((c) => c.pass !== last);
    const item = (c) => `<li><span class="chip chip-${c.severity === 'blocker' ? 'bad' : 'warn'}">${esc(c.severity)}</span> <span class="muted">${esc(c.area)}</span> ${esc(c.summary)}${c.artifactId && isReady(artById(c.artifactId)) ? ` <button type="button" class="link-btn" data-open-artifact="${esc(c.artifactId)}">report</button>` : ''}</li>`;
    return `<div class="table-wrap"><table class="table review-table"><thead><tr><th scope="col">Pass</th>${areas.map((a) => `<th scope="col">${esc(a.label)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>
      ${changes.length ? `<h3 class="h3">Requested changes · pass ${last}</h3><ul class="changes">${changes.map(item).join('')}</ul>` : ''}
      ${older.length ? `<details class="older"><summary>Earlier requested changes (${older.length})</summary><ul class="changes">${older.map((c) => item({ ...c, summary: `pass ${c.pass}: ${c.summary}` })).join('')}</ul></details>` : ''}`;
  });
}

function renderApproval() {
  const { board } = S.state;
  section('approval-body', { ap: board.approval, status: board.status, st: board.stages.approve, m: board.stages.merge, docs: ['approval.md', 'escalation.md', 'merge.md'].map((p) => runFile(p)?.status) }, () => {
    const ap = board.approval;
    const docs = ['approval.md', 'escalation.md', 'merge.md'].map(runFile).filter(Boolean);
    const waiting = board.status === 'WAITING_FOR_HUMAN';
    return `<div class="approval">
      <div class="approval-decision">${ap.decision ? chip(ap.decision, ap.decision === 'APPROVE' ? 'Approved' : 'Escalated') : chip('PENDING', board.runId ? 'Not decided' : 'No run')}${ap.by ? `<span class="muted small">by ${esc(ap.by)}${ap.at ? ` · ${esc(when(ap.at))}` : ''}</span>` : ''}</div>
      ${ap.reason ? `<p>${esc(ap.reason)}</p>` : ''}
      ${waiting ? `<div class="callout callout-warn"><strong>Waiting for you.</strong> Run <code>/factory approve [note]</code> to apply the work as unstaged changes, or tell the orchestrator what to change.</div>` : ''}
      ${board.status === 'MERGED' ? `<div class="callout callout-ok"><strong>Merged back</strong> into <span class="mono">${esc(board.branch)}</span> as unstaged changes. Nothing was committed or pushed.</div>` : ''}
      <div class="btn-row">${docs.map((d) => openBtn(d, d.path)).join('')}</div>
    </div>`;
  });
}

function renderRevisions() {
  const { board } = S.state;
  section('revisions-body', { rounds: board.rounds, rev: board.revision, build: board.stages.build, reviews: board.reviews.map((p) => [p.round, Object.values(p.results).map((r) => r.status)]) }, () => {
    const steps = [];
    const autoCount = board.rounds.filter((r) => !r.human).length;
    const max = board.revision.max;
    for (let i = 0; i <= max; i++) {
      const label = i === 0 ? 'Initial build' : `Revision ${i}`;
      const r = board.rounds.filter((x) => !x.human)[i];
      const building = !r && board.stages.build === 'ACTIVE' && board.revision.pending !== 'human' && autoCount === i;
      const passes = r ? board.reviews.filter((p) => p.round === r.round) : [];
      const res = passes.at(-1) ? Object.values(passes.at(-1).results) : [];
      const verdict = !res.length ? '' : res.every((x) => x.status === 'PASS') ? chip('PASS', 'All PASS') : res.some((x) => x.status === 'RUNNING') ? chip('RUNNING', 'In review') : chip('CHANGES', `${res.filter((x) => x.status === 'CHANGES').length} × CHANGES`);
      steps.push(`<li class="step step-${r ? 'done' : building ? 'run' : 'idle'}"><span class="step-dot" aria-hidden="true"></span><div><div class="step-title">${esc(label)}</div><div class="small muted">${r ? `<span class="mono">${esc(short(r.commit))}</span> · ${r.files.length} file${r.files.length === 1 ? '' : 's'} · ${esc(when(r.committedAt))}` : building ? 'Building now' : 'Not needed yet'}</div>${verdict ? `<div class="step-verdict">${verdict}</div>` : ''}</div></li>`);
    }
    for (const r of board.rounds.filter((x) => x.human)) {
      steps.push(`<li class="step step-done"><span class="step-dot" aria-hidden="true"></span><div><div class="step-title">${esc(r.label)}</div><div class="small muted"><span class="mono">${esc(short(r.commit))}</span> · requested by you · does not count toward the limit</div></div></li>`);
    }
    return `<p class="small muted">${board.revision.round} of ${max} automatic revisions used${board.revision.human ? ` · ${board.revision.human} requested by you` : ''}</p><ol class="steps">${steps.join('')}</ol>`;
  });
}

function renderActivity() {
  const { board } = S.state;
  section('activity-body', { log: board.log.slice(-200), all: S.logAll }, () => {
    if (!board.log.length) return '<p class="empty">Nothing has happened yet.</p>';
    const entries = [...board.log].reverse();
    const shown = S.logAll ? entries : entries.slice(0, 25);
    return `<ol class="log">${shown.map((l) => `<li><time datetime="${esc(l.at)}" title="${esc(when(l.at))}">${esc(clock(l.at))}</time><span>${esc(l.text)}</span></li>`).join('')}</ol>
      ${entries.length > 25 ? `<button type="button" class="link-btn" data-toggle-log aria-expanded="${S.logAll}">${S.logAll ? 'Show the latest 25' : `Show all ${entries.length}`}</button>` : ''}`;
  });
}

// ---------------------------------------------------------------------------
// Token usage

const WINDOWS = [['run', 'This run'], ['5h', '5 h window'], ['24h', '24 h'], ['7d', '7 days'], ['all', 'All']];

function bar(share, cls = '') {
  const w = Math.max(0, Math.min(100, (share || 0) * 100));
  return `<svg class="bar ${cls}" viewBox="0 0 100 6" preserveAspectRatio="none" aria-hidden="true"><rect class="bar-bg" width="100" height="6" rx="3"/><rect class="bar-fg" width="${w.toFixed(2)}" height="6" rx="3"/></svg>`;
}

function renderUsage() {
  section('usage-tabs', { w: S.window }, () =>
    `<div class="segmented" role="tablist" aria-label="Reporting window">${WINDOWS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${S.window === k}" data-window="${k}" class="${S.window === k ? 'on' : ''}">${esc(l)}</button>`).join('')}</div>`);
  const u = S.usage;
  const w = u?.windows?.[S.window];
  section('usage-body', { w, avail: u?.available, err: u?.error, run: S.state?.board.runId, sources: u?.sources, quota: u?.quota }, () => {
    if (!u) return '<p class="empty">Loading token usage…</p>';
    if (!u.available) {
      return `<div class="callout callout-warn"><strong>Token usage unavailable.</strong> No Claude Code session records were found in: ${(u.sources ?? []).map((s) => `<span class="mono">${esc(s.path)}</span>`).join(', ') || 'the configured sources'}.${u.error ? ` (${esc(u.error)})` : ''}</div>`;
    }
    if (!w) return '<p class="empty">No data for this window.</p>';
    if (S.window === 'run' && !S.state?.board.runId) return '<p class="empty">No run selected. Pick a time window to see recent usage.</p>';
    const t = w.totals;
    const range = w.from ? `${when(w.from)} – ${w.to ? when(w.to) : 'now'}` : S.window === 'run' ? 'not started' : 'no activity';
    const stat = (label, value, hint) => `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(compact(value))}</div><div class="stat-hint">${esc(hint ?? num(value))}</div></div>`;
    const models = w.byModel.filter((m) => m.used || m.family !== 'Other');
    const modelRows = models.map((m) => `<tr${m.used ? '' : ' class="unused"'}><th scope="row"><span class="model model-${esc(m.family.toLowerCase())}">${esc(m.family)}</span>${m.models.length ? `<div class="small muted mono hide-sm">${esc(m.models.join(', '))}</div>` : ''}</th>
      ${m.used ? `<td class="num">${num(m.input)}</td><td class="num">${num(m.output)}</td><td class="num hide-sm">${num(m.cacheWrite)}</td><td class="num hide-sm">${num(m.cacheRead)}</td><td class="num strong">${num(m.total)}</td><td class="share">${bar(m.share, `bar-${m.family.toLowerCase()}`)}<span>${pct(m.share)}</span></td>` : `<td colspan="6" class="muted small">Not used in this window (0 requests recorded)</td>`}</tr>`).join('');
    const agentRows = w.byAgent.map((a) => `<tr${a.unattributed ? ' class="unattributed"' : ''}><th scope="row">${esc(a.label)}${a.unattributed ? '<div class="small muted">not attributable to a factory agent</div>' : ''}</th>
      <td class="hide-sm">${(() => {
        const seen = a.observedModels.map(famOf).filter((v, i, list) => list.indexOf(v) === i);
        const configured = a.configuredModel ? modelName(a.configuredModel) : null;
        const differs = seen.length && (!configured || seen.some((f) => f !== configured));
        return `${configured ? esc(configured) : esc(seen.join(', '))}${differs && configured ? `<div class="small text-warn">observed ${esc(seen.join(', '))}</div>` : ''}${!seen.length && configured ? '<div class="small muted">no records</div>' : ''}`;
      })()}</td>
      <td class="hide-sm">${a.status ? chip(a.status) : ''}</td>
      <td class="num">${num(a.input)}</td><td class="num">${num(a.output)}</td><td class="num hide-sm">${num(a.cacheWrite + a.cacheRead)}</td><td class="num strong">${num(a.total)}</td><td class="share hide-sm">${bar(a.share)}<span>${pct(a.share)}</span></td></tr>`).join('');
    const mini = (rows, labelOf) => rows.length ? `<ul class="mini-bars">${rows.map((r) => `<li><span class="mini-label">${esc(labelOf(r))}</span>${bar(r.share)}<span class="num">${esc(compact(r.total))}</span></li>`).join('')}</ul>` : '<p class="empty small">No factory-attributed usage in this window.</p>';
    const stageNames = { request: 'Feature request', worktree: 'Worktree', spec: 'Spec', build: 'Build', review: 'Reviews', approve: 'Approval', merge: 'Merge back' };
    const cost = w.cost?.available ? `<strong>~$${w.cost.usd.toFixed(2)}</strong> <span class="muted">${esc(w.cost.note)}</span>` : `<span class="muted">${esc(w.cost?.reason ?? 'Unavailable')}</span>`;
    return `<p class="small muted usage-range">${esc(w.label)} · ${esc(range)} · times in ${esc(timeZone())}${w.partial ? ` · <span class="text-warn">partial: ${num(t.missing)} records had no usage data</span>` : ''}</p>
      ${S.window === '5h' ? `<p class="small muted">${esc(w.note ?? '')}</p>` : ''}
      <div class="stats">${stat('Total processed', t.total)}${stat('Input', t.input)}${stat('Output', t.output)}${stat('Cache write', t.cacheWrite)}${stat('Cache read', t.cacheRead)}${stat('Requests', t.requests, 'API messages')}</div>
      <div class="usage-grid">
        <div><h3 class="h3">By model</h3><div class="table-wrap"><table class="table"><thead><tr><th scope="col">Model</th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num hide-sm">Cache write</th><th scope="col" class="num hide-sm">Cache read</th><th scope="col" class="num">Total</th><th scope="col">Share</th></tr></thead><tbody>${modelRows}</tbody></table></div></div>
        <div><h3 class="h3">By agent</h3>${agentRows ? `<div class="table-wrap"><table class="table"><thead><tr><th scope="col">Agent</th><th scope="col" class="hide-sm">Model</th><th scope="col" class="hide-sm">Status</th><th scope="col" class="num">Input</th><th scope="col" class="num">Output</th><th scope="col" class="num hide-sm">Cache</th><th scope="col" class="num">Total</th><th scope="col" class="hide-sm">Share</th></tr></thead><tbody>${agentRows}</tbody></table></div>` : '<p class="empty">No usage recorded in this window.</p>'}</div>
        <div class="usage-mini"><div><h3 class="h3">By stage</h3>${mini(w.byStage, (r) => stageNames[r.stage] ?? r.stage)}</div><div><h3 class="h3">By round</h3>${mini(w.byRound, (r) => r.label)}</div></div>
      </div>
      <dl class="usage-foot">
        <div><dt>Plan quota</dt><dd><span class="muted">${esc(u.quota?.label ?? 'Unavailable')}</span> <span class="small muted">${esc(u.quota?.note ?? '')}</span></dd></div>
        <div><dt>Estimated cost</dt><dd>${cost}</dd></div>
        <div><dt>How it is counted</dt><dd class="small muted">Each API message counts once (deduplicated by message and request id, largest snapshot kept). Total processed = input + output + cache write + cache read; cache reads are re-used context, billed at a lower rate than input.</dd></div>
      </dl>`;
  });
}

// ---------------------------------------------------------------------------
// Artifact explorer

const ICON = { markdown: 'MD', javascript: 'JS', jsx: 'JSX', typescript: 'TS', tsx: 'TSX', python: 'PY', json: '{}', yaml: 'YML', sql: 'SQL', css: 'CSS', html: '<>', shell: 'SH', diff: '±', text: 'TXT', binary: 'BIN' };

function artifactRow(a, { label } = {}) {
  const ready = isReady(a);
  const git = a.kind === 'git-file';
  const change = git ? `<span class="chip chip-${a.change === 'added' ? 'ok' : a.change === 'deleted' ? 'bad' : 'info'}">${esc(a.change)}</span>` : '';
  const agent = a.agent ? (S.state.config.agents[a.agent]?.label ?? (a.agent === 'orchestrator' ? 'Orchestrator' : a.agent)) : '—';
  const round = git ? `R${a.versions?.length ? a.versions.map((v) => v.round).join(',') : a.round}` : a.pass ? `Pass ${a.pass}` : Number.isInteger(a.round) ? `R${a.round}` : '';
  return `<li class="art-row${ready ? '' : ' art-off'}">
    <span class="art-icon ft-${esc(a.fileType)}" aria-hidden="true">${esc(ICON[a.fileType] ?? 'TXT')}</span>
    <div class="art-main">${ready ? `<button type="button" class="art-name" data-open-artifact="${esc(a.id)}">${esc(label ?? a.name)}</button>` : `<span class="art-name">${esc(label ?? a.name)}</span>`}
      <div class="art-sub mono">${esc(a.path)}</div></div>
    <div class="art-meta">${change}${chip(a.status)}<span class="small muted">${esc(agent)}${round ? ` · ${esc(round)}` : ''}</span></div>
    <div class="art-actions">${ready ? `<button type="button" class="btn btn-sm" data-open-artifact="${esc(a.id)}">View</button>${git && a.change !== 'deleted' ? `<button type="button" class="btn btn-sm" data-open-artifact="${esc(a.id)}" data-view="diff">Diff</button>` : git ? `<button type="button" class="btn btn-sm" data-open-artifact="${esc(a.id)}" data-view="diff">Diff</button>` : ''}` : ''}</div>
  </li>`;
}

function renderArtifacts() {
  const { board } = S.state;
  const arts = board.artifacts;
  section('artifacts-count', { n: arts.length }, () => (arts.length ? `${arts.length}` : ''));
  section('artifacts-body', { a: arts.map((x) => [x.id, x.status, x.versions?.length, x.hash]), f: S.filter }, () => {
    if (!arts.length) return '<p class="empty">Files appear here as each agent writes them: the spec and plan first, then the build, the review reports and the approval.</p>';
    const f = S.filter.trim().toLowerCase();
    const match = (a) => !f || a.path.toLowerCase().includes(f) || (a.name ?? '').toLowerCase().includes(f);
    const groups = [];
    const spec = arts.filter((a) => a.category === 'specification' && match(a));
    if (spec.length) groups.push(['Specification', `<ul class="art-list">${spec.map((a) => artifactRow(a)).join('')}</ul>`]);
    const implDocs = arts.filter((a) => a.category === 'implementation' && a.kind === 'run-file' && match(a));
    const changed = arts.filter((a) => a.kind === 'git-file' && a.group !== 'tests' && match(a));
    const tests = arts.filter((a) => a.kind === 'git-file' && a.group === 'tests' && match(a));
    if (implDocs.length || changed.length || tests.length) {
      groups.push(['Implementation', `${implDocs.length ? `<ul class="art-list">${implDocs.map((a) => artifactRow(a)).join('')}</ul>` : ''}
        ${changed.length ? `<h4 class="h4">Changed files <span class="muted">(${changed.length})</span></h4><ul class="art-list">${changed.map((a) => artifactRow(a)).join('')}</ul>` : ''}
        ${tests.length ? `<h4 class="h4">Tests <span class="muted">(${tests.length})</span></h4><ul class="art-list">${tests.map((a) => artifactRow(a)).join('')}</ul>` : ''}`]);
    }
    const reviews = arts.filter((a) => a.category === 'review' && match(a));
    if (reviews.length) {
      const passes = [...new Set(reviews.map((a) => a.pass))].sort((x, y) => x - y);
      groups.push(['Reviews', passes.map((p) => `<h4 class="h4">Pass ${p}</h4><ul class="art-list">${reviews.filter((a) => a.pass === p).map((a) => artifactRow(a)).join('')}</ul>`).join('')]);
    }
    const approval = arts.filter((a) => a.category === 'approval' && match(a));
    if (approval.length) groups.push(['Approval', `<ul class="art-list">${approval.map((a) => artifactRow(a)).join('')}</ul>`]);
    const fin = arts.filter((a) => a.category === 'finalization' && match(a));
    if (fin.length) groups.push(['Finalization', `<ul class="art-list">${fin.map((a) => artifactRow(a)).join('')}</ul>`]);
    const other = arts.filter((a) => a.category === 'other' && match(a));
    if (other.length) groups.push(['Other', `<ul class="art-list">${other.map((a) => artifactRow(a)).join('')}</ul>`]);
    if (!groups.length) return `<p class="empty">No file matches “${esc(S.filter)}”.</p>`;
    return groups.map(([title, body]) => `<section class="art-group"><h3 class="h3">${esc(title)}</h3>${body}</section>`).join('');
  });
  const filterWrap = $('#artifacts-filter-wrap');
  if (filterWrap) filterWrap.hidden = arts.length <= 8;
}

// ---------------------------------------------------------------------------
// Drawer

const drawerRoot = () => $('#drawer-root');
const cache = new Map();

async function fetchArtifact(extra) {
  const url = `/api/artifact${qs(extra)}`;
  const a = artById(extra.id);
  const key = `${url}#${a?.hash ?? ''}#${a?.versions?.length ?? ''}#${a?.status ?? ''}`;
  if (cache.has(key)) return cache.get(key);
  const res = await fetch(url, { cache: 'no-cache' });
  const body = await res.json().catch(() => ({ error: 'invalid response' }));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  cache.set(key, body);
  if (cache.size > 60) cache.delete(cache.keys().next().value);
  return body;
}

function codeView(text, lang) {
  const lines = highlightLines(text, lang);
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  return `<div class="code-view scroll-x"><table class="code-table"><tbody>${lines.map((l, i) => `<tr><td class="ln">${i + 1}</td><td class="code">${l || ' '}</td></tr>`).join('')}</tbody></table></div>`;
}

function openDrawer(id, { view, trigger } = {}) {
  const a = artById(id);
  if (!a) return;
  const opened = !S.drawer;
  S.drawer = {
    id,
    view: view ?? (a.kind === 'git-file' ? 'file' : a.fileType === 'diff' ? 'diff' : a.fileType === 'markdown' ? 'preview' : 'raw'),
    mode: 'preview',
    version: a.kind === 'git-file' ? String(a.versions?.at(-1)?.round ?? '') : null,
    against: 'start',
    text: null,
    lastFocus: opened ? trigger ?? document.activeElement : S.drawer?.lastFocus,
    scroll: 0,
  };
  const root = drawerRoot();
  root.hidden = false;
  document.body.classList.add('drawer-open');
  $('#main').setAttribute('aria-hidden', 'true');
  $('#main').inert = true;
  renderDrawer(true);
  if (opened) requestAnimationFrame(() => $('#drawer-close').focus());
}

function closeDrawer() {
  if (!S.drawer) return;
  const { lastFocus, id } = S.drawer;
  S.drawer = null;
  drawerRoot().hidden = true;
  document.body.classList.remove('drawer-open');
  $('#main').removeAttribute('aria-hidden');
  $('#main').inert = false;
  const target = lastFocus && document.contains(lastFocus) ? lastFocus : document.querySelector(`[data-open-artifact="${CSS.escape(id)}"]`);
  target?.focus();
}

function metaRow(label, value) {
  return `<div><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

async function renderDrawer(resetScroll = false) {
  const d = S.drawer;
  if (!d) return;
  const a = artById(d.id);
  const body = $('#drawer-body');
  if (!a) {
    body.innerHTML = '<p class="empty">This file is no longer in the run’s registry.</p>';
    return;
  }
  const { config, board } = S.state;
  const git = a.kind === 'git-file';
  const agent = a.agent ? (config.agents[a.agent]?.label ?? (a.agent === 'orchestrator' ? 'Orchestrator' : a.agent)) : '—';
  const version = git ? a.versions.find((v) => String(v.round) === d.version) ?? a.versions.at(-1) : null;
  $('#drawer-title').textContent = a.name;
  $('#drawer-path').textContent = git ? a.path : `factory/runs/${a.runId}/${a.path}`;
  $('#drawer-meta').innerHTML = [
    metaRow('Agent', esc(agent)),
    metaRow('Type', esc(LANGUAGE_NAMES[a.fileType] ?? a.fileType)),
    metaRow('Stage', esc({ request: 'Feature request', worktree: 'Worktree', spec: 'Spec', build: 'Build', review: 'Review', approve: 'Approval', merge: 'Merge' }[a.stage] ?? '—')),
    metaRow(git ? 'Round' : a.pass ? 'Pass' : 'Round', esc(git ? version?.label ?? '—' : a.pass ? `${a.pass}` : Number.isInteger(a.round) ? board.rounds.find((r) => r.round === a.round)?.label ?? `Round ${a.round}` : '—')),
    metaRow('Updated', esc(when(a.updatedAt ?? a.mtime ?? a.createdAt))),
    metaRow('Status', chip(a.status)),
  ].join('');

  // Tabs and selectors
  const tabs = git ? [['file', 'File'], ['diff', 'Diff'], ['history', 'History']] : a.fileType === 'diff' ? [['diff', 'Diff'], ['raw', 'Raw']] : a.fileType === 'markdown' ? [['preview', 'Preview'], ['raw', 'Raw']] : [];
  const mdToggle = git && a.fileType === 'markdown' && d.view === 'file' ? `<div class="segmented segmented-sm" role="group" aria-label="Markdown view">${[['preview', 'Preview'], ['raw', 'Raw']].map(([k, l]) => `<button type="button" data-md-mode="${k}" aria-pressed="${d.mode === k}" class="${d.mode === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : '';
  const versionSel = git && a.versions.length > 0 && d.view !== 'history'
    ? `<label class="field"><span>Version</span><select class="select select-sm" data-drawer-version>${a.versions.map((v) => `<option value="${v.round}"${String(v.round) === d.version ? ' selected' : ''}>${esc(v.label ?? `Round ${v.round}`)} · ${esc(short(v.commit))}</option>`).join('')}</select></label>`
    : '';
  const againstSel = git && d.view === 'diff'
    ? `<label class="field"><span>Compare with</span><select class="select select-sm" data-drawer-against><option value="start"${d.against === 'start' ? ' selected' : ''}>Start (${esc(short(board.startCommit))})</option><option value="prev"${d.against === 'prev' ? ' selected' : ''}>Previous round</option>${board.rounds.filter((r) => r.round < Number(d.version)).map((r) => `<option value="${r.round}"${d.against === String(r.round) ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>`
    : '';
  const siblings = a.category === 'review' ? board.artifacts.filter((x) => x.category === 'review' && x.area === a.area).sort((x, y) => x.pass - y.pass) : [];
  const passSel = siblings.length > 1 ? `<label class="field"><span>Pass</span><select class="select select-sm" data-drawer-sibling>${siblings.map((x) => `<option value="${esc(x.id)}"${x.id === a.id ? ' selected' : ''}${isReady(x) ? '' : ' disabled'}>Pass ${x.pass}${isReady(x) ? '' : ` (${esc(statusLabel(x.status))})`}</option>`).join('')}</select></label>` : '';
  $('#drawer-tabs').innerHTML = `${tabs.length ? `<div class="segmented" role="tablist" aria-label="View">${tabs.map(([k, l]) => `<button type="button" role="tab" data-drawer-view="${k}" aria-selected="${d.view === k}" class="${d.view === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}${mdToggle}${versionSel}${againstSel}${passSel}`;
  $('#drawer-tabs').hidden = !$('#drawer-tabs').innerHTML.trim();

  const dl = $('#drawer-download');
  const canDownload = isReady(a) && !(git && version?.change === 'D');
  dl.hidden = !canDownload;
  if (canDownload) dl.href = `/api/artifact${qs({ id: a.id, download: '1', version: git ? version?.round : undefined })}`;

  if (resetScroll) body.scrollTop = 0;
  const keepScroll = body.scrollTop;
  body.setAttribute('aria-busy', 'true');
  if (!body.innerHTML || resetScroll) body.innerHTML = '<div class="skeleton" aria-hidden="true"></div><p class="sr-only">Loading…</p>';
  try {
    const view = git ? (d.view === 'file' ? 'content' : d.view) : 'content';
    const res = await fetchArtifact({ id: a.id, view, version: git ? version?.round : undefined, against: git && d.view === 'diff' ? d.against : undefined });
    if (S.drawer !== d) return;
    d.text = res.text ?? null;
    $('#drawer-copy').hidden = d.text == null;
    body.innerHTML = renderContent(res, a, d);
    body.scrollTop = resetScroll ? 0 : keepScroll;
  } catch (e) {
    if (S.drawer !== d) return;
    d.text = null;
    $('#drawer-copy').hidden = true;
    body.innerHTML = `<div class="callout callout-bad"><strong>Could not load this file.</strong> ${esc(e.message)}</div>`;
  } finally {
    body.removeAttribute('aria-busy');
  }
}

function renderContent(res, a, d) {
  const sizeNote = (n) => `${num(n)} bytes`;
  if (res.kind === 'unavailable') return `<div class="callout callout-mute"><strong>Unavailable.</strong> ${esc(res.message ?? '')}</div>`;
  if (res.kind === 'too-large') return `<div class="callout callout-warn"><strong>Too large to preview</strong> (${sizeNote(res.size)}; the limit is ${sizeNote(res.maxBytes)}).</div>`;
  if (res.kind === 'binary') return `<div class="callout callout-mute"><strong>Binary file</strong> (${sizeNote(res.size)}). It is not previewed; use Download to save it.</div>`;
  if (res.kind === 'history') {
    return `<ol class="history">${res.versions.map((v) => `<li><div class="history-head"><strong>${esc(v.label ?? `Round ${v.round}`)}</strong> <span class="mono">${esc(short(v.commit))}</span> ${chip(v.change === 'A' ? 'READY' : v.change === 'D' ? 'FAILED' : 'UPDATED', { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' }[v.change] ?? v.change)}${v.available ? '' : chip('UNAVAILABLE')}</div><div class="small muted">${esc(when(v.at))}${v.oldPath ? ` · from <span class="mono">${esc(v.oldPath)}</span>` : ''}</div>${v.available ? `<div class="btn-row"><button type="button" class="btn btn-sm" data-history-open="${v.round}" data-history-view="file">View this version</button><button type="button" class="btn btn-sm" data-history-open="${v.round}" data-history-view="diff">Diff</button></div>` : ''}</li>`).join('')}</ol>`;
  }
  if (res.kind === 'diff') {
    const note = `<p class="small muted">Comparing ${esc(res.from)} → ${esc(res.to)}${res.source && res.source !== 'git' ? ` · from the saved patch <span class="mono">${esc(res.source)}</span>` : ''}</p>`;
    return note + renderDiff(res.text, a.fileType);
  }
  const src = res.source === 'snapshot' ? '<p class="small muted">Shown from the final snapshot kept at merge-back (the factory commit is gone).</p>' : '';
  const preview = a.kind === 'git-file' ? d.view === 'file' && d.mode === 'preview' : d.view === 'preview';
  if (res.kind === 'markdown' && preview) return `${src}<article class="md">${renderMarkdown(res.text)}</article>`;
  if (a.kind === 'run-file' && d.view === 'diff') return renderDiff(res.text, 'text');
  return src + codeView(res.text, res.language === 'markdown' ? 'text' : res.language);
}

function trapFocus(e) {
  if (!S.drawer || e.key !== 'Tab') return;
  const nodes = [...$('#drawer').querySelectorAll('button:not([disabled]):not([hidden]), [href]:not([hidden]), select, [tabindex]:not([tabindex="-1"])')].filter((n) => n.offsetParent !== null);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes.at(-1);
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function announce(text) {
  const live = $('#live');
  live.textContent = '';
  requestAnimationFrame(() => (live.textContent = text));
}

// ---------------------------------------------------------------------------
// Events

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, [data-open-artifact], [data-close]');
  if (!t) return;
  if (t.matches('[data-open-artifact]')) {
    if (t.hasAttribute('disabled')) return;
    return openDrawer(t.dataset.openArtifact, { view: t.dataset.view, trigger: t });
  }
  if (t.matches('[data-close], #drawer-close')) return closeDrawer();
  if (t.matches('[data-window]')) {
    S.window = t.dataset.window;
    storageSet('window', S.window);
    return renderUsage();
  }
  if (t.matches('[data-toggle-log]')) {
    S.logAll = !S.logAll;
    return renderActivity();
  }
  if (t.matches('[data-toggle-request]')) {
    S.requestOpen = !S.requestOpen;
    return renderRun();
  }
  if (t.matches('[data-collapse]')) {
    const name = t.dataset.collapse;
    S.collapsed = { ...S.collapsed, [name]: !isCollapsed(name) };
    storageSet('collapsed', S.collapsed);
    return applyCollapse();
  }
  if (t.matches('[data-drawer-view]') && S.drawer) {
    S.drawer.view = t.dataset.drawerView;
    return renderDrawer(true);
  }
  if (t.matches('[data-md-mode]') && S.drawer) {
    S.drawer.mode = t.dataset.mdMode;
    return renderDrawer();
  }
  if (t.matches('[data-history-open]') && S.drawer) {
    S.drawer.version = t.dataset.historyOpen;
    S.drawer.view = t.dataset.historyView;
    return renderDrawer(true);
  }
  if (t.matches('#drawer-copy') && S.drawer?.text != null) {
    try {
      await navigator.clipboard.writeText(S.drawer.text);
      announce('Copied to the clipboard');
      t.dataset.copied = '1';
      setTimeout(() => delete t.dataset.copied, 1500);
    } catch {
      announce('Copy failed: the browser blocked clipboard access');
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.drawer) {
    e.preventDefault();
    return closeDrawer();
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('g[data-open-artifact]')) {
    e.preventDefault();
    openDrawer(e.target.dataset.openArtifact, { trigger: e.target });
  }
  trapFocus(e);
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'run-select') {
    // The current board's own run (or the empty choice) follows board.json live.
    S.run = !t.value || t.value === S.state?.currentRunId ? null : t.value;
    const url = new URL(location.href);
    if (S.run) url.searchParams.set('run', S.run);
    else url.searchParams.delete('run');
    history.replaceState(null, '', url);
    closeDrawer();
    S.sigs = {};
    S.stateText = null;
    S.usageText = null;
    pollState();
    pollUsage();
  }
  if (!S.drawer) return;
  if (t.matches('[data-drawer-version]')) {
    S.drawer.version = t.value;
    renderDrawer(true);
  }
  if (t.matches('[data-drawer-against]')) {
    S.drawer.against = t.value;
    renderDrawer(true);
  }
  if (t.matches('[data-drawer-sibling]')) openDrawer(t.value);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'artifacts-filter') {
    S.filter = e.target.value;
    renderArtifacts();
  }
});

// Every card except the workflow collapses. Artifacts starts collapsed; the
// viewer's choices are remembered in this browser.
const COLLAPSED_BY_DEFAULT = { artifacts: true };
const isCollapsed = (name) => S.collapsed[name] ?? COLLAPSED_BY_DEFAULT[name] ?? false;

function applyCollapse() {
  for (const card of document.querySelectorAll('[data-card]')) {
    const name = card.dataset.card;
    const collapsed = isCollapsed(name);
    card.classList.toggle('collapsed', collapsed);
    card.querySelector(`[data-collapse="${name}"]`)?.setAttribute('aria-expanded', String(!collapsed));
    const panel = document.getElementById(`${name}-panel`);
    if (panel) panel.hidden = collapsed;
  }
}

// ---------------------------------------------------------------------------
// Polling

function renderAll() {
  if (!S.state) return;
  renderHeader();
  renderAlerts();
  renderRun();
  renderWorkflowSection();
  renderAgents();
  renderReviews();
  renderApproval();
  renderRevisions();
  renderUsage();
  renderArtifacts();
  renderActivity();
  // Keep an open document in step with the board: re-fetch when its file
  // changed, without moving the reader's scroll position.
  if (S.drawer) {
    const a = artById(S.drawer.id);
    const sig = a ? `${a.status}|${a.hash}|${a.versions?.length}` : 'gone';
    if (S.drawer.sig && S.drawer.sig !== sig) renderDrawer();
    S.drawer.sig = sig;
  }
}

function setLive() {
  const el = $('#live-status');
  const text = S.failing ? 'Reconnecting…' : S.lastOk ? `Live · checked ${ago(new Date(S.lastOk).toISOString())}` : 'Connecting…';
  if (el.textContent !== text) el.textContent = text;
  el.dataset.state = S.failing ? 'bad' : 'ok';
}

async function pollState() {
  try {
    const res = await fetch(`/api/state${qs()}`, { cache: 'no-cache' });
    const text = await res.text();
    if (!res.ok) throw new Error(JSON.parse(text).error ?? `HTTP ${res.status}`);
    S.lastOk = Date.now();
    const wasFailing = S.failing;
    S.failing = false;
    if (text !== S.stateText) {
      S.stateText = text;
      S.state = JSON.parse(text);
      renderAll();
    } else if (wasFailing) renderAlerts();
  } catch (e) {
    S.failing = true;
    if (S.state) renderAlerts();
    else $('#alerts').innerHTML = `<div class="alert alert-bad" role="alert"><strong>Cannot load the board.</strong> ${esc(e.message)}</div>`;
  }
  setLive();
}

async function pollUsage() {
  try {
    const res = await fetch(`/api/usage${qs()}`, { cache: 'no-cache' });
    const text = await res.text();
    if (!res.ok) throw new Error(JSON.parse(text).error ?? `HTTP ${res.status}`);
    if (text !== S.usageText) {
      S.usageText = text;
      S.usage = JSON.parse(text);
      S.usageError = S.usage.error ?? null;
      if (S.state) {
        renderUsage();
        renderAgents();
      }
    }
  } catch (e) {
    S.usageError = e.message;
  }
}

function loop(fn, ms) {
  const tick = async () => {
    if (!document.hidden) await fn();
    setTimeout(tick, typeof ms === 'function' ? ms() : ms);
  };
  tick();
}

applyCollapse();
$('#tz').textContent = timeZone();
loop(pollState, () => S.state?.config?.pollMs ?? 2000);
loop(pollUsage, () => S.state?.config?.usagePollMs ?? 5000);
setInterval(setLive, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) pollState();
});
