// The workflow diagram as inline SVG, coloured from the board. Two layouts:
// wide (left to right, two rows) and narrow (top to bottom) for phones.
// Nodes that open a document carry data-open-artifact and are focusable.

import { esc } from './util.mjs';

const MODEL = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };

function nodeStates(board, config) {
  const st = board.stages;
  const a = board.agents;
  const art = (rel) => board.artifacts.find((x) => x.kind === 'run-file' && x.path === rel);
  const ready = (x) => x && (x.status === 'READY' || x.status === 'UPDATED');
  const agentTone = (role, stage) => {
    const s = a[role]?.status;
    if (s === 'RUNNING') return 'run';
    if (s === 'FAILED' || s === 'BLOCKED' || st[stage] === 'BLOCKED') return 'bad';
    if (st[stage] === 'DONE' || s === 'DONE') return 'ok';
    return 'idle';
  };
  const stageTone = (s) => ({ ACTIVE: 'run', DONE: 'ok', CHANGES: 'warn', WAITING: 'warn', BLOCKED: 'bad' })[s] ?? 'idle';
  const pass = board.reviews.at(-1);
  const model = (role) => MODEL[config.agents[role]?.model] ?? config.agents[role]?.model ?? '';
  const n = {};
  n.request = { title: 'Feature request', sub: board.feature ? 'Received' : 'Waiting for /factory', tone: board.runId ? 'ok' : 'idle', open: art('request.md') };
  n.worktree = { title: 'Isolated worktree', sub: board.worktree ? `Created from ${String(board.startCommit ?? '').slice(0, 7)}` : 'Not created', tone: stageTone(st.worktree) };
  n.spec = { title: 'Spec Writer', sub: `${model('spec-writer')} · ${a['spec-writer']?.status === 'RUNNING' ? 'writing' : st.spec === 'DONE' ? 'done' : st.spec === 'BLOCKED' ? 'blocked' : 'pending'}`, tone: agentTone('spec-writer', 'spec') };
  const spec = art('spec.md');
  const plan = art('plan.md');
  // Older runs had no plan.md: once the spec stage is done, an absent plan
  // (as opposed to a FAILED one) does not hold the documents back.
  const docsReady = ready(spec) && (ready(plan) || (!plan && st.spec === 'DONE'));
  const docsFailed = spec?.status === 'FAILED' || plan?.status === 'FAILED';
  const docsWriting = spec?.status === 'WRITING' || plan?.status === 'WRITING' || a['spec-writer']?.status === 'RUNNING';
  n.docs = {
    title: plan || !spec ? 'spec.md + plan.md' : 'spec.md',
    sub: docsReady ? 'Ready to read' : docsFailed ? 'Missing' : docsWriting ? 'Writing' : 'Pending',
    tone: docsReady ? 'ok' : docsFailed ? 'bad' : docsWriting ? 'run' : 'idle',
    open: ready(spec) ? spec : null,
  };
  const builderRound = board.rounds.length - (st.build === 'ACTIVE' ? 0 : 1);
  n.builder = {
    title: 'Builder',
    sub: `${model('builder')} · ${st.build === 'ACTIVE' ? (board.rounds.length ? `revision ${board.revision.pending === 'human' ? 'by you' : board.revision.round}` : 'building') : board.rounds.length ? board.rounds.at(-1).label.toLowerCase() : 'pending'}`,
    tone: st.build === 'ACTIVE' ? 'run' : stageTone(st.build),
    open: ready(art('build.md')) ? art('build.md') : null,
    round: builderRound,
  };
  for (const [role, cfg] of Object.entries(config.agents)) {
    if (cfg.stage !== 'review') continue;
    const r = pass?.results?.[cfg.area];
    const report = r?.artifactId ? board.artifacts.find((x) => x.id === r.artifactId) : null;
    n[role] = {
      title: cfg.label,
      sub: `${model(role)} · ${r ? (r.status === 'RUNNING' ? 'reviewing' : r.status === 'PENDING' ? 'pending' : r.status) : 'pending'}`,
      tone: r ? ({ RUNNING: 'run', PASS: 'ok', CHANGES: 'warn' })[r.status] ?? 'idle' : 'idle',
      open: ready(report) ? report : null,
    };
  }
  n.wait = { title: 'Wait for all four', sub: pass ? `pass ${pass.pass}${st.review === 'DONE' ? ' · all PASS' : st.review === 'CHANGES' ? ' · changes' : st.review === 'BLOCKED' ? ' · still CHANGES' : ''}` : 'no reviews yet', tone: stageTone(st.review) };
  const ap = art('approval.md');
  // The approver's own decision, even after a human approved over it.
  const decided = a.approver?.sessions?.at(-1)?.result;
  const apDecision = a.approver?.status === 'RUNNING' ? null : ['APPROVE', 'ESCALATE'].includes(decided) ? decided : null;
  n.approver = { title: 'Approver', sub: `${model('approver')} · ${a.approver?.status === 'RUNNING' ? 'checking' : apDecision ?? 'pending'}`, tone: a.approver?.status === 'RUNNING' ? 'run' : apDecision === 'APPROVE' ? 'ok' : apDecision === 'ESCALATE' ? 'warn' : a.approver?.status === 'FAILED' ? 'bad' : 'idle', open: ready(ap) ? ap : null };
  const mergeDoc = art('merge.md');
  n.apply = { title: 'Apply changes — unstaged', sub: st.merge === 'DONE' ? 'Merged back' : st.merge === 'BLOCKED' ? 'Blocked' : board.status === 'APPROVED' ? 'Ready to apply' : 'Pending', tone: stageTone(st.merge === 'PENDING' && board.status === 'APPROVED' ? 'ACTIVE' : st.merge), open: ready(mergeDoc) ? mergeDoc : null };
  const esc_ = art('escalation.md');
  const humanApproved = board.approval.by === 'human' && board.approval.decision === 'APPROVE';
  n.human = { title: 'Ask human', sub: board.status === 'WAITING_FOR_HUMAN' ? 'Waiting for you' : esc_ ? 'Answered' : 'Only on ESCALATE', tone: board.status === 'WAITING_FOR_HUMAN' ? 'warn' : esc_ ? 'ok' : 'idle', open: ready(esc_) ? esc_ : null };
  n.approve = { title: '/factory approve', sub: humanApproved ? 'Approved by you' : board.status === 'WAITING_FOR_HUMAN' ? 'Available now' : '—', tone: humanApproved ? 'ok' : board.status === 'WAITING_FOR_HUMAN' ? 'warn' : 'idle' };
  return n;
}

function node(id, x, y, w, h, n) {
  const open = n.open ? ` data-open-artifact="${esc(n.open.id)}" tabindex="0" role="button" aria-label="${esc(`${n.title}: open ${n.open.name}`)}"` : ` role="img" aria-label="${esc(`${n.title}: ${n.sub}`)}"`;
  return `<g class="wf-node wf-${n.tone}${n.open ? ' wf-link' : ''}" data-node="${id}"${open}>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10"/>
${n.tone === 'run' ? `<circle class="wf-pulse" cx="${x + w - 14}" cy="${y + 14}" r="4"/>` : ''}
<text x="${x + 14}" y="${y + h / 2 - 3}" class="wf-title">${esc(n.title)}</text>
<text x="${x + 14}" y="${y + h / 2 + 14}" class="wf-sub">${esc(n.sub)}${n.open ? ' ›' : ''}</text>
</g>`;
}

const arrow = (d, cls = '') => `<path class="wf-edge ${cls}" d="${d}" marker-end="url(#wf-arrow)"/>`;
const label = (x, y, text, cls = '') => `<text x="${x}" y="${y}" class="wf-label ${cls}" text-anchor="middle">${esc(text)}</text>`;

const DEFS = `<defs><marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="wf-arrowhead"/></marker></defs>`;

function wide(n, board, reviewers) {
  const W = 184;
  const H = 56;
  const r1 = 18;
  const xs = [20, 244, 468, 692];
  const parts = [];
  for (let i = 0; i < 3; i++) parts.push(arrow(`M${xs[i] + W} ${r1 + H / 2}H${xs[i + 1] - 4}`));
  // wrap from the documents down to the builder
  const by = 196;
  const bx = 20;
  parts.push(arrow(`M${xs[3] + W / 2} ${r1 + H}V106H${bx + W / 2}V${by - 4}`));
  const ry = [126, 184, 242, 300];
  const rx = 262;
  const rh = 46;
  const wx = 504;
  const ax = 762;
  const ox = 1030;
  reviewers.forEach((role, i) => {
    const cy = ry[i] + rh / 2;
    parts.push(arrow(`M${bx + W} ${by + 30}C${rx - 30} ${by + 30} ${rx - 30} ${cy} ${rx - 4} ${cy}`));
    parts.push(arrow(`M${rx + W} ${cy}C${wx - 30} ${cy} ${wx - 30} ${by + 30} ${wx - 4} ${by + 30}`));
  });
  parts.push(arrow(`M${wx + W} ${by + 30}H${ax - 4}`), label((wx + W + ax) / 2, by + 22, 'ALL PASS'));
  const loopActive = board.revision.round > 0 || board.stages.review === 'CHANGES';
  parts.push(arrow(`M${wx + W / 2} ${by + 60}V376H${bx + W / 2}V${by + 64}`, loopActive ? 'wf-edge-warn' : ''));
  parts.push(label((wx + W / 2 + bx + W / 2) / 2, 368, `CHANGES · max ${board.revision.max} revisions${board.revision.round ? ` · used ${board.revision.round}` : ''}`, loopActive ? 'wf-label-warn' : ''));
  parts.push(arrow(`M${ax + W} ${by + 22}C${ox - 36} ${by + 22} ${ox - 36} 158 ${ox - 4} 158`), label(ox - 42, 146, 'APPROVE'));
  parts.push(arrow(`M${ax + W} ${by + 38}C${ox - 36} ${by + 38} ${ox - 36} 284 ${ox - 4} 284`), label(ox - 42, 304, 'ESCALATE'));
  parts.push(arrow(`M${ox + W / 2} 312V${344 - 4}`));
  parts.push(arrow(`M${ox + W} 366H${ox + W + 14}V158H${ox + W + 4}`));
  const svg = [
    node('request', xs[0], r1, W, H, n.request), node('worktree', xs[1], r1, W, H, n.worktree), node('spec', xs[2], r1, W, H, n.spec), node('docs', xs[3], r1, W, H, n.docs),
    node('builder', bx, by, W, 60, n.builder),
    ...reviewers.map((role, i) => node(role, rx, ry[i], W, rh, n[role])),
    node('wait', wx, by, W, 60, n.wait), node('approver', ax, by, W, 60, n.approver),
    node('apply', ox, 130, W, 56, n.apply), node('human', ox, 256, W, 56, n.human), node('approve', ox, 344, W, 44, n.approve),
  ];
  return `<svg class="wf wf-wide" viewBox="0 0 1240 400" role="group" aria-label="Factory workflow">${DEFS}${parts.join('')}${svg.join('')}</svg>`;
}

function narrow(n, board, reviewers) {
  const x = 20;
  const w = 320;
  const h = 50;
  const parts = [];
  const nodes = [];
  let y = 10;
  const chain = ['request', 'worktree', 'spec', 'docs', 'builder'];
  chain.forEach((id, i) => {
    nodes.push(node(id, x, y, w, h, n[id]));
    if (i < chain.length - 1) parts.push(arrow(`M${x + w / 2} ${y + h}V${y + h + 18}`));
    y += h + 22;
  });
  const by = y - 22 - h;
  const cw = 152;
  reviewers.forEach((role, i) => {
    const cx = x + (i % 2) * (cw + 16);
    const cy = y + Math.floor(i / 2) * 64;
    nodes.push(node(role, cx, cy, cw, 50, { ...n[role], title: n[role].title, sub: n[role].sub.replace(/^(\w+) · /, '$1 · ') }));
  });
  parts.push(arrow(`M${x + w / 2} ${by + h}V${y - 4}`));
  y += 128 + 6;
  parts.push(arrow(`M${x + w / 2} ${y - 10}V${y - 2}`));
  nodes.push(node('wait', x, y, w, h, n.wait));
  const waitY = y;
  y += h + 22;
  parts.push(arrow(`M${x + w / 2} ${waitY + h}V${y - 4}`), label(x + w / 2 + 40, waitY + h + 15, 'ALL PASS'));
  nodes.push(node('approver', x, y, w, h, n.approver));
  const loopActive = board.revision.round > 0 || board.stages.review === 'CHANGES';
  parts.push(arrow(`M${x + w} ${waitY + h / 2}H${x + w + 12}V${by + h / 2}H${x + w + 4}`, loopActive ? 'wf-edge-warn' : ''));
  parts.push(`<text x="${x + w + 8}" y="${(waitY + by) / 2 + 40}" class="wf-label ${loopActive ? 'wf-label-warn' : ''}" transform="rotate(-90 ${x + w + 8} ${(waitY + by) / 2 + 40})">CHANGES · max ${board.revision.max}</text>`);
  const apY = y;
  y += h + 26;
  const half = 152;
  nodes.push(node('apply', x, y, half, h, { ...n.apply, title: 'Apply — unstaged' }));
  nodes.push(node('human', x + half + 16, y, half, h, n.human));
  parts.push(arrow(`M${x + w / 2 - 40} ${apY + h}V${y - 4}`), arrow(`M${x + w / 2 + 40} ${apY + h}V${y - 4}`));
  parts.push(label(x + 40, apY + h + 16, 'APPROVE'), label(x + w - 40, apY + h + 16, 'ESCALATE'));
  const hy = y;
  y += h + 22;
  nodes.push(node('approve', x + half + 16, y, half, 44, n.approve));
  parts.push(arrow(`M${x + half + 16 + half / 2} ${hy + h}V${y - 4}`));
  parts.push(arrow(`M${x + half + 16} ${y + 22}H${x + half / 2}V${hy + h + 4}`));
  y += 44 + 12;
  return `<svg class="wf wf-narrow" viewBox="0 0 360 ${y}" role="group" aria-label="Factory workflow">${DEFS}${parts.join('')}${nodes.join('')}</svg>`;
}

export function renderWorkflow(board, config) {
  const n = nodeStates(board, config);
  const reviewers = Object.entries(config.agents).filter(([, a]) => a.stage === 'review').map(([role]) => role);
  return wide(n, board, reviewers) + narrow(n, board, reviewers);
}
