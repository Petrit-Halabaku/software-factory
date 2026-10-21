#!/usr/bin/env node
// The orchestrator's only interface to the board and to Git.
// Run from the repository root:  node "${CLAUDE_PLUGIN_ROOT}/bin/fac.mjs" <command> [options]
// The repository is the Git top level of the current directory (or
// FACTORY_REPO); its state lives in <repo>/factory/ (or FACTORY_DIR).
// Every command prints one JSON object; failures exit 1 with
// { "error", "code", "details" }.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_FACTORY_DIR, DEFAULT_REPO_DIR, PLUGIN_DIR, factoryPaths, loadConfig } from '../lib/config.mjs';
import { loadBoards, readBoard, STAGES } from '../lib/board.mjs';
import { checkPlugins } from '../lib/plugins.mjs';
import { collectUsage } from '../lib/usage.mjs';
import * as wf from '../lib/workflow.mjs';

const HELP = `fac.mjs — factory orchestrator commands

  init                                       exclusions, factory/ state, house-rules template
  preflight                                  check exclusions and house rules
  plugins                                    check the plugins and skills the agents need
  rules                                      paths of the two rule files every agent reads
  start --title T (--request R | --request-file F) [--session ID] [--model M]
  agent-start <role> [--agent-id ID] [--pass N] [--task TEXT]
  agent-done <role> [--blocked REASON]
  commit-round [--allow-empty]
  review-start
  review-outcome
  revise [--human]
  escalate --by WHO --reason TEXT
  approve [--note TEXT]
  merge-back [--notes-file F] [--allow-moved-head]
  stop [--reason TEXT]
  status [--text]
  usage
  sync
  log TEXT
  dashboard                                  start the local dashboard

Roles: spec-writer builder security ux ui-design code approver`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

const print = (v) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);

function statusSummary(ctx, { usage = true } = {}) {
  const p = factoryPaths(ctx.factoryDir);
  const { board, errors } = readBoard(p.board, ctx.config);
  const art = (id) => board.artifacts.find((a) => a.id === id);
  const runDir = board.runId ? path.join(p.runs, board.runId) : null;
  let tokens = null;
  if (usage && board.runId) {
    try {
      const { report } = collectUsage(ctx, { boards: loadBoards(ctx.factoryDir, ctx.config), runId: board.runId });
      const w = report.windows.run;
      tokens = {
        total: w.totals.total, input: w.totals.input, output: w.totals.output, cacheWrite: w.totals.cacheWrite, cacheRead: w.totals.cacheRead,
        byModel: Object.fromEntries(w.byModel.filter((m) => m.used).map((m) => [m.family, m.total])),
        partial: w.partial, available: report.available,
      };
    } catch (e) {
      tokens = { error: `usage unavailable: ${e.message}` };
    }
  }
  const lastPass = board.reviews.at(-1);
  return {
    runId: board.runId,
    status: board.status,
    feature: board.feature?.title ?? null,
    stage: board.stage,
    completedStages: STAGES.filter((s) => board.stages[s] === 'DONE'),
    stages: board.stages,
    activeAgents: Object.entries(board.agents).filter(([, a]) => a.status === 'RUNNING').map(([role, a]) => ({ role, model: a.model })),
    pendingReviews: lastPass ? Object.entries(lastPass.results).filter(([, r]) => r.status === 'RUNNING' || r.status === 'PENDING').map(([k]) => k) : [],
    lastReviewPass: lastPass ? { pass: lastPass.pass, results: Object.fromEntries(Object.entries(lastPass.results).map(([k, r]) => [k, r.status])) } : null,
    requestedChanges: board.requestedChanges.filter((c) => c.pass === lastPass?.pass).map((c) => `[${c.severity}] ${c.area}: ${c.summary}`),
    revision: `${board.revision.round}/${board.revision.max}${board.revision.human ? ` (+${board.revision.human} human)` : ''}`,
    approval: board.approval.decision ? `${board.approval.decision} by ${board.approval.by}${board.approval.reason ? `: ${board.approval.reason}` : ''}` : null,
    files: runDir ? board.artifacts.filter((a) => a.kind === 'run-file' && ['READY', 'UPDATED'].includes(a.status)).map((a) => path.join(runDir, a.path)) : [],
    changedFiles: board.artifacts.filter((a) => a.kind === 'git-file').map((a) => a.path),
    tokens,
    dashboard: `http://${ctx.config.dashboard.host}:${ctx.config.dashboard.port}/`,
    boardErrors: errors,
    approvalReport: board.approval.artifactId ? art(board.approval.artifactId)?.path ?? null : null,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = args._;
  const ctx = { repoDir: DEFAULT_REPO_DIR, factoryDir: DEFAULT_FACTORY_DIR, config: loadConfig(DEFAULT_FACTORY_DIR, { repoDir: DEFAULT_REPO_DIR }) };
  const rules = { factoryRules: path.join(PLUGIN_DIR, 'rules.md'), houseRules: factoryPaths(ctx.factoryDir).houseRules };
  switch (cmd) {
    case 'init': {
      const r = wf.initRepo(ctx, { templateFile: path.join(PLUGIN_DIR, 'templates', 'house-rules.md') });
      print({ ...r, repoDir: ctx.repoDir, factoryRules: rules.factoryRules });
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'rules':
      return print(rules);
    case 'preflight': {
      const r = wf.preflight(ctx);
      print(r);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'plugins': {
      const r = checkPlugins(ctx);
      print(r);
      process.exitCode = r.ok ? 0 : 1;
      return;
    }
    case 'start': {
      const request = args.requestFile ? readFileSync(args.requestFile, 'utf8') : args.request;
      return print({ ...wf.startRun(ctx, { title: args.title, request, sessionId: args.session ?? process.env.CLAUDE_CODE_SESSION_ID ?? null, model: args.model ?? null }), ...rules });
    }
    case 'agent-start':
      return print(wf.agentStart(ctx, rest[0], { agentId: args.agentId ?? null, pass: args.pass ? Number(args.pass) : null, task: args.task ?? null }));
    case 'agent-done':
      return print(wf.agentDone(ctx, rest[0], { blocked: typeof args.blocked === 'string' ? args.blocked : args.blocked ? 'blocked' : null }));
    case 'commit-round':
      return print(wf.commitRound(ctx, { allowEmpty: Boolean(args.allowEmpty) }));
    case 'review-start':
      return print(wf.reviewStart(ctx));
    case 'review-outcome':
      return print(wf.reviewOutcome(ctx));
    case 'revise':
      return print(wf.revise(ctx, { human: Boolean(args.human) }));
    case 'escalate':
      return print(wf.escalate(ctx, { by: args.by ?? 'orchestrator', reason: args.reason }));
    case 'approve':
      return print(wf.humanApprove(ctx, { note: typeof args.note === 'string' ? args.note : null }));
    case 'merge-back': {
      const notes = args.notesFile ? readFileSync(args.notesFile, 'utf8') : '';
      return print(wf.mergeBack(ctx, { notes, allowMovedHead: Boolean(args.allowMovedHead) }));
    }
    case 'stop':
      return print(wf.stopRun(ctx, { reason: typeof args.reason === 'string' ? args.reason : undefined }));
    case 'status': {
      const s = statusSummary(ctx);
      if (!args.text) return print(s);
      const lines = [
        `Run: ${s.runId ?? 'none'} — ${s.status}${s.feature ? ` — ${s.feature}` : ''}`,
        `Stage: ${s.stage ?? '-'} · done: ${s.completedStages.join(', ') || '-'} · revision ${s.revision}`,
        `Active: ${s.activeAgents.map((a) => `${a.role} (${a.model})`).join(', ') || 'none'} · pending reviews: ${s.pendingReviews.join(', ') || 'none'}`,
        `Approval: ${s.approval ?? 'none'}`,
        `Tokens (this run): ${s.tokens?.available && s.tokens.total != null ? `${s.tokens.total.toLocaleString('en-US')}${Object.keys(s.tokens.byModel).length ? ` (${Object.entries(s.tokens.byModel).map(([k, v]) => `${k} ${v.toLocaleString('en-US')}`).join(', ')})` : ''}${s.tokens.partial ? ', partial' : ''}` : 'unavailable'}`,
        `Dashboard: ${s.dashboard}`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
      return;
    }
    case 'usage': {
      const { board } = readBoard(factoryPaths(ctx.factoryDir).board, ctx.config);
      const { report } = collectUsage(ctx, { boards: loadBoards(ctx.factoryDir, ctx.config), runId: board.runId });
      return print({ available: report.available, sources: report.sources, records: report.records, run: report.windows.run.totals, all: report.windows.all.totals, file: factoryPaths(ctx.factoryDir).usage });
    }
    case 'sync':
      return print(wf.syncArtifacts(ctx));
    case 'log':
      return print(wf.addLog(ctx, rest.join(' ')));
    case 'dashboard': {
      const { startServer } = await import('../dashboard/server.mjs');
      await startServer(ctx, { port: args.port ? Number(args.port) : undefined });
      return;
    }
    default:
      process.stdout.write(`${HELP}\n`);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  print({ error: e.message, code: e.code ?? 'ERROR', details: e.details ?? null });
  process.exitCode = 1;
});
