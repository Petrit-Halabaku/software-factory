// Small filesystem helpers shared by the factory CLI, the usage collector and
// the dashboard server. Every state file is written atomically (temp file +
// rename) so a reader never sees half a JSON document.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(file, data) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

export const writeJsonAtomic = (file, value) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// ISO time without milliseconds, the format every board timestamp uses.
export const nowIso = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');
