// Shared helpers for the dashboard UI. Every string that reaches innerHTML
// goes through esc() first.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const nf = new Intl.NumberFormat('en-US');
export const num = (n) => (Number.isFinite(n) ? nf.format(n) : '—');

export function compact(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1000) return String(n);
  if (n < 1e6) return `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}k`;
  if (n < 1e9) return `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M`;
  return `${(n / 1e9).toFixed(2)}B`;
}

export const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(x > 0 && x < 0.01 ? 1 : 0)}%` : '—');

const dtf = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const when = (iso) => (iso ? dtf.format(new Date(iso)) : '—');
export const clock = (iso) => (iso ? tf.format(new Date(iso)) : '—');
export const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function ago(iso, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export const short = (sha) => (sha ? String(sha).slice(0, 7) : '—');

export function hashString(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Status → visual tone used by chips, nodes and dots.
const TONES = {
  RUNNING: 'run', ACTIVE: 'run', WRITING: 'run',
  DONE: 'ok', PASS: 'ok', READY: 'ok', MERGED: 'ok', APPROVE: 'ok', APPROVED: 'ok',
  UPDATED: 'info',
  CHANGES: 'warn', WAITING: 'warn', WAITING_FOR_HUMAN: 'warn', ESCALATE: 'warn',
  BLOCKED: 'bad', FAILED: 'bad', UNAVAILABLE: 'mute', STOPPED: 'mute',
  PENDING: 'idle', IDLE: 'idle',
};
export const tone = (status) => TONES[status] ?? 'idle';

const LABELS = { WAITING_FOR_HUMAN: 'Waiting for you', RUNNING: 'Running', ACTIVE: 'Active', IDLE: 'Idle', PENDING: 'Pending' };
export const statusLabel = (s) => LABELS[s] ?? (s ? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ') : '—');

export const chip = (status, label) => `<span class="chip chip-${tone(status)}">${status === 'RUNNING' || status === 'ACTIVE' || status === 'WRITING' ? '<span class="dot" aria-hidden="true"></span>' : ''}${esc(label ?? statusLabel(status))}</span>`;

export function storageGet(key, fallback) {
  try {
    const v = localStorage.getItem(`factory:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(`factory:${key}`, JSON.stringify(value));
  } catch {}
}
