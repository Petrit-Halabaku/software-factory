// A safe Markdown renderer for factory documents (GitHub-flavoured subset:
// headings, paragraphs, nested and task lists, tables, code spans, fenced
// code with highlighting, blockquotes, links, rules). Raw HTML in the source
// is shown as text: every piece of source text is escaped before any markup
// is added, and links are limited to http(s), mailto and in-page anchors.

import { esc } from './util.mjs';
import { highlight, normalizeLang } from './highlight.mjs';

export function safeUrl(url) {
  const u = String(url).trim();
  if (/^#[\w-]*$/.test(u)) return u;
  if (/^mailto:[^\s<>"]+$/i.test(u)) return u;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

const slugify = (s) => s.toLowerCase().replace(/<[^>]*>/g, '').replace(/&[a-z#0-9]+;/g, '').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');

export function inline(src) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0001`;
  let s = String(src).replace(/[\u0000\u0001]/g, '');
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_, __, code) => keep(`<code>${esc(code.replace(/^ (.*) $/, '$1'))}</code>`));
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt) => keep(`<span class="md-image">[image${alt ? `: ${esc(alt)}` : ''}]</span>`));
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (all, text, url) => {
    const href = safeUrl(url);
    if (!href) return text;
    const ext = !href.startsWith('#');
    return `${keep(`<a href="${esc(href)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : ''}>`)}${text}${keep('</a>')}`;
  });
  s = s.replace(/<(https?:\/\/[^\s>]+)>/g, (all, url) => {
    const href = safeUrl(url);
    return href ? keep(`<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`) : all;
  });
  s = esc(s);
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*(?=\S)([^*]*?\S)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/ {2,}\n|\\\n/g, '<br>');
  for (let guard = 0; /\u0000\d+\u0001/.test(s) && guard < 5; guard++) s = s.replace(/\u0000(\d+)\u0001/g, (_, i) => slots[Number(i)]);
  return s;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '    ').length;
const isBlank = (l) => !l.trim();

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '`') inCode = !inCode;
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function renderCode(code, lang) {
  const l = String(lang || '').toLowerCase();
  if (l === 'mermaid') {
    return `<figure class="md-mermaid"><figcaption>Mermaid diagram (source; diagrams are not rendered here)</figcaption><pre><code>${esc(code)}</code></pre></figure>`;
  }
  const norm = normalizeLang(l);
  return `<pre class="md-code"${l ? ` data-lang="${esc(l)}"` : ''}><code>${norm === 'text' || norm === 'markdown' ? esc(code) : highlight(code, norm)}</code></pre>`;
}

function renderList(lines) {
  const base = indentOf(lines[0]);
  const ordered = /^\s*\d/.test(lines[0]);
  const startNum = ordered ? parseInt(lines[0].trim(), 10) : 1;
  const items = [];
  let cur = null;
  for (const line of lines) {
    const m = LIST.exec(line);
    if (m && indentOf(line) < base + 2) {
      cur = { first: m[3], rest: [], offset: m[1].length + m[2].length + 1 };
      items.push(cur);
    } else if (cur) {
      cur.rest.push(isBlank(line) ? '' : line.slice(Math.min(indentOf(line), cur.offset)));
    }
  }
  const loose = items.some((it) => it.rest.some(isBlank) && it.rest.some((l) => !isBlank(l)));
  const body = items.map((it) => {
    let first = it.first;
    let check = '';
    const task = /^\[([ xX])\]\s+(.*)$/.exec(first);
    if (task) {
      check = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="${task[1] !== ' ' ? 'done' : 'not done'}"> `;
      first = task[2];
    }
    const restLines = it.rest;
    while (restLines.length && isBlank(restLines.at(-1))) restLines.pop();
    const rest = restLines.length ? renderBlocks(restLines) : '';
    const lead = loose ? `<p>${check}${inline(first)}</p>` : `${check}${inline(first)}`;
    return `<li${task ? ' class="task"' : ''}>${lead}${rest}</li>`;
  }).join('');
  return ordered ? `<ol${startNum !== 1 ? ` start="${startNum}"` : ''}>${body}</ol>` : `<ul>${body}</ul>`;
}

export function renderBlocks(lines) {
  const out = [];
  let i = 0;
  const startsBlock = (l, next) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || QUOTE.test(l) || LIST.test(l) || (l.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[1];
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(renderCode(body.join('\n'), m[2]));
      continue;
    }
    if ((m = HEADING.exec(line))) {
      const level = m[1].length;
      const html = inline(m[2]);
      out.push(`<h${level} id="${esc(slugify(html))}">${html}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && (QUOTE.test(lines[i]) || (!isBlank(lines[i]) && body.length && !startsBlock(lines[i], lines[i + 1])))) body.push(lines[i++].replace(QUOTE, ''));
      out.push(`<blockquote>${renderBlocks(body)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : null));
      i += 2;
      const rows = [];
      while (i < lines.length && !isBlank(lines[i]) && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
      const cell = (tag, c, idx) => `<${tag}${align[idx] ? ` class="al-${align[idx]}"` : ''}>${inline(c ?? '')}</${tag}>`;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c, idx) => cell('th', c, idx)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, idx) => cell('td', r[idx], idx)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (LIST.test(line)) {
      const base = indentOf(line);
      const ordered = /^\s*\d/.test(line);
      // a sibling item at the same indent, of the same kind (bullet or number)
      const sibling = (l) => LIST.test(l) && indentOf(l) === base && /^\s*\d/.test(l) === ordered;
      const body = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (isBlank(l)) {
          const next = lines.slice(i + 1).find((x) => !isBlank(x));
          if (next !== undefined && (indentOf(next) > base || sibling(next))) {
            body.push(l);
            i++;
            continue;
          }
          break;
        }
        if (indentOf(l) > base || sibling(l)) {
          body.push(l);
          i++;
        } else if (!startsBlock(l, lines[i + 1]) && !isBlank(lines[i - 1])) {
          body.push(`${' '.repeat(base + 2)}${l.trim()}`);
          i++;
        } else break;
      }
      out.push(renderList(body));
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n'))}</p>`);
  }
  return out.join('\n');
}

export const renderMarkdown = (text) => renderBlocks(String(text ?? '').replace(/\r\n?/g, '\n').split('\n'));
