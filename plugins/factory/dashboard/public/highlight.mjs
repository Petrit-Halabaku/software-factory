// A small, dependency-free syntax highlighter. It only ever wraps escaped
// text in <span class="tok-…">, so highlighted code cannot inject markup.

import { esc } from './util.mjs';

const JS_KW = 'await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async as interface type enum implements private protected public readonly declare namespace keyof satisfies';
const PY_KW = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case';
const SQL_KW = 'select from where and or not insert into values update set delete create alter drop table index view function returns return begin end if then else elsif case when as on join left right inner outer full cross using group by order having limit offset distinct union all exists in is null primary key references foreign unique check default constraint trigger before after for each row execute procedure policy enable row level security grant revoke to language plpgsql security definer declare publication add column cascade with returning coalesce';
const SH_KW = 'if then else elif fi for while until do done case esac function in return local export source cd echo exit set unset';

const words = (list) => new RegExp(`\\b(?:${list.split(' ').join('|')})\\b`, 'y');

// Rules are tried in order at each position; the first sticky match wins.
const C_COMMENT = [/\/\/[^\n]*/y, 'comment'];
const BLOCK_COMMENT = [/\/\*[\s\S]*?(?:\*\/|$)/y, 'comment'];
const NUMBER = [/\b(?:0[xX][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b/y, 'number'];

const LANGS = {
  javascript: [
    C_COMMENT, BLOCK_COMMENT,
    [/`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`/y, 'string'],
    [/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y, 'string'],
    [words(JS_KW), 'keyword'],
    [/\b(?:true|false|null|undefined|NaN|Infinity)\b/y, 'literal'],
    NUMBER,
    [/<\/?[A-Za-z][\w.:-]*/y, 'tag'],
    [/\b[A-Za-z_$][\w$]*(?=\s*\()/y, 'fn'],
  ],
  python: [
    [/#[^\n]*/y, 'comment'],
    [/(?:[rbuf]{0,2})(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$))/y, 'string'],
    [/(?:[rbuf]{0,2})(?:'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*")/y, 'string'],
    [words(PY_KW), 'keyword'],
    [/\b(?:True|False|None|self)\b/y, 'literal'],
    [/@[\w.]+/y, 'fn'],
    NUMBER,
    [/\b[A-Za-z_]\w*(?=\s*\()/y, 'fn'],
  ],
  sql: [
    [/--[^\n]*/y, 'comment'], BLOCK_COMMENT,
    [/'(?:''|[^'])*'/y, 'string'],
    [/\$\$|\$[A-Za-z_]*\$/y, 'tag'],
    [new RegExp(`\\b(?:${SQL_KW.split(' ').join('|')})\\b`, 'iy'), 'keyword'],
    [/\b(?:true|false|null)\b/iy, 'literal'],
    NUMBER,
  ],
  css: [
    BLOCK_COMMENT,
    [/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/y, 'string'],
    [/@[\w-]+/y, 'keyword'],
    [/--?[A-Za-z][\w-]*(?=\s*:)/y, 'attr'],
    [/#[\da-fA-F]{3,8}\b/y, 'number'],
    [/-?\d*\.?\d+(?:px|rem|em|%|vh|vw|s|ms|deg|fr)?\b/y, 'number'],
    [/[.#][A-Za-z_][\w-]*/y, 'tag'],
  ],
  yaml: [
    [/#[^\n]*/y, 'comment'],
    [/^[ \t-]*[\w"'.-]+(?=\s*:)/my, 'attr'],
    [/'(?:''|[^'])*'|"(?:\\.|[^"\\\n])*"/y, 'string'],
    [/\b(?:true|false|null|yes|no|on|off)\b/y, 'literal'],
    NUMBER,
  ],
  json: [
    [/"(?:\\.|[^"\\\n])*"(?=\s*:)/y, 'attr'],
    [/"(?:\\.|[^"\\\n])*"/y, 'string'],
    [/\b(?:true|false|null)\b/y, 'literal'],
    [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y, 'number'],
  ],
  shell: [
    [/#[^\n]*/y, 'comment'],
    [/'[^']*'|"(?:\\.|[^"\\])*"/y, 'string'],
    [/\$\{?[A-Za-z_][\w]*\}?/y, 'attr'],
    [words(SH_KW), 'keyword'],
    NUMBER,
  ],
  html: [
    [/<!--[\s\S]*?(?:-->|$)/y, 'comment'],
    [/<\/?[A-Za-z][\w:-]*/y, 'tag'],
    [/\b[A-Za-z_:][\w:.-]*(?==)/y, 'attr'],
    [/"[^"]*"|'[^']*'/y, 'string'],
  ],
  diff: [
    [/^(?:\+\+\+|---)[^\n]*/my, 'meta'],
    [/^@@[^\n]*/my, 'fn'],
    [/^\+[^\n]*/my, 'inserted'],
    [/^-[^\n]*/my, 'deleted'],
    [/^diff --git[^\n]*/my, 'keyword'],
  ],
};
LANGS.jsx = LANGS.javascript;
LANGS.typescript = LANGS.javascript;
LANGS.tsx = LANGS.javascript;

export const LANGUAGE_NAMES = {
  javascript: 'JavaScript', jsx: 'JSX', typescript: 'TypeScript', tsx: 'TSX', python: 'Python', json: 'JSON', yaml: 'YAML',
  sql: 'SQL', css: 'CSS', html: 'HTML (source)', shell: 'Shell', diff: 'Diff', markdown: 'Markdown', text: 'Plain text',
};

const ALIASES = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', py: 'python', yml: 'yaml', sh: 'shell', bash: 'shell', zsh: 'shell', console: 'shell', patch: 'diff', xml: 'html', svg: 'html', postgres: 'sql', psql: 'sql', plpgsql: 'sql', scss: 'css', jsonc: 'json' };
export const normalizeLang = (lang) => {
  const l = String(lang ?? '').toLowerCase();
  return LANGS[l] ? l : ALIASES[l] ?? (l === 'markdown' || l === 'md' ? 'markdown' : 'text');
};

// Tokens as [{ type|null, text }]. Unknown languages produce one plain token.
export function tokenize(code, lang) {
  const rules = LANGS[normalizeLang(lang)];
  if (!rules) return [{ type: null, text: code }];
  const out = [];
  let plain = '';
  let i = 0;
  while (i < code.length) {
    let matched = null;
    for (const [re, type] of rules) {
      re.lastIndex = i;
      const m = re.exec(code);
      if (m && m[0].length) {
        matched = { type, text: m[0] };
        break;
      }
    }
    if (matched) {
      if (plain) out.push({ type: null, text: plain });
      plain = '';
      out.push(matched);
      i += matched.text.length;
    } else {
      // Advance a whole word at a time so keywords never match mid-word.
      const w = /[A-Za-z0-9_$]+|[\s\S]/y;
      w.lastIndex = i;
      const m = w.exec(code);
      plain += m[0];
      i += m[0].length;
    }
  }
  if (plain) out.push({ type: null, text: plain });
  return out;
}

const span = (t) => (t.type ? `<span class="tok-${t.type}">${esc(t.text)}</span>` : esc(t.text));

export const highlight = (code, lang) => tokenize(code, lang).map(span).join('');

// Highlighted HTML per line, with tokens that span lines split correctly.
export function highlightLines(code, lang) {
  const lines = [[]];
  for (const t of tokenize(code, lang)) {
    const parts = t.text.split('\n');
    parts.forEach((p, idx) => {
      if (idx > 0) lines.push([]);
      if (p) lines.at(-1).push(span({ type: t.type, text: p }));
    });
  }
  return lines.map((l) => l.join(''));
}
