// Unified diff → a read-only, GitHub-style table (old/new line numbers).

import { esc } from './util.mjs';
import { highlight } from './highlight.mjs';

export function parseDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      f = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, status: 'modified', binary: false, hunks: [], meta: [] };
      files.push(f);
      h = null;
      continue;
    }
    if (!f) continue;
    if (!h) {
      if (line.startsWith('new file mode')) f.status = 'added';
      else if (line.startsWith('deleted file mode')) f.status = 'deleted';
      else if (line.startsWith('rename from ')) {
        f.status = 'renamed';
        f.oldPath = line.slice(12);
      } else if (line.startsWith('rename to ')) f.newPath = line.slice(10);
      else if (line.startsWith('similarity index')) f.meta.push(line);
      else if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) f.binary = true;
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hm) {
      oldNo = Number(hm[1]);
      newNo = Number(hm[2]);
      h = { header: line, rows: [] };
      f.hunks.push(h);
      continue;
    }
    if (!h) continue;
    if (line.startsWith('+')) h.rows.push({ type: 'add', old: null, new: newNo++, text: line.slice(1) });
    else if (line.startsWith('-')) h.rows.push({ type: 'del', old: oldNo++, new: null, text: line.slice(1) });
    else if (line.startsWith(' ')) h.rows.push({ type: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) });
    else if (line.startsWith('\\')) h.rows.push({ type: 'note', old: null, new: null, text: line });
  }
  return files;
}

const STATUS = { added: 'Added', deleted: 'Deleted', renamed: 'Renamed', modified: 'Modified' };

export function renderDiff(text, lang) {
  const files = parseDiff(text);
  if (!files.length) return '<p class="empty">No differences.</p>';
  return files.map((f) => {
    const stats = f.hunks.flatMap((h) => h.rows).reduce((a, r) => ({ add: a.add + (r.type === 'add'), del: a.del + (r.type === 'del') }), { add: 0, del: 0 });
    const name = f.status === 'renamed' ? `${esc(f.oldPath)} → ${esc(f.newPath)}` : esc(f.newPath ?? f.oldPath);
    const head = `<div class="diff-file-head"><span class="chip chip-${f.status === 'added' ? 'ok' : f.status === 'deleted' ? 'bad' : 'info'}">${STATUS[f.status]}</span><span class="mono diff-name">${name}</span><span class="diff-stats"><span class="add">+${stats.add}</span> <span class="del">−${stats.del}</span></span></div>`;
    if (f.binary) return `<section class="diff-file">${head}<p class="empty">Binary file; no text diff.</p></section>`;
    const rows = f.hunks.map((h) =>
      `<tr class="hunk"><td class="ln" colspan="2"></td><td class="code">${esc(h.header)}</td></tr>` +
      h.rows.map((r) => `<tr class="${r.type}"><td class="ln">${r.old ?? ''}</td><td class="ln">${r.new ?? ''}</td><td class="code"><span class="sign" aria-hidden="true">${r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>${r.type === 'note' ? esc(r.text) : highlight(r.text, lang)}</td></tr>`).join('')
    ).join('');
    return `<section class="diff-file">${head}<div class="scroll-x"><table class="diff-table"><tbody>${rows || '<tr><td colspan="3" class="empty">No line changes (mode or rename only).</td></tr>'}</tbody></table></div></section>`;
  }).join('');
}
