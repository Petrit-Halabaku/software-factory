// The browser-side renderers are plain modules; test them in Node.

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, safeUrl } from '../dashboard/public/markdown.mjs';
import { highlight, highlightLines } from '../dashboard/public/highlight.mjs';
import { parseDiff, renderDiff } from '../dashboard/public/diff.mjs';

test('markdown: the supported subset renders', () => {
  const html = renderMarkdown([
    '# Title', '', 'Some **bold**, *em*, `code` and ~~gone~~.', '', '- one', '  - nested', '- [x] done', '- [ ] todo', '',
    '1. first', '2. second', '', '| A | B |', '|:--|--:|', '| `x|y` | 2 |', '', '> quoted', '', '---', '',
    '```js', 'const a = "s"; // c', '```', '', '[link](https://example.com) and [anchor](#title)',
  ].join('\n'));
  assert.match(html, /<h1 id="title">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <code>code<\/code> and <del>gone<\/del>/);
  assert.match(html, /<ul><li>one<ul><li>nested<\/li><\/ul><\/li>/);
  assert.match(html, /<input type="checkbox" disabled checked/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<th class="al-left">A<\/th><th class="al-right">B<\/th>/);
  assert.match(html, /<code>x\|y<\/code>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<span class="tok-keyword">const<\/span>/);
  assert.match(html, /<span class="tok-string">&quot;s&quot;<\/span>/);
  assert.match(html, /<a href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer">link<\/a>/);
  assert.match(html, /<a href="#title">anchor<\/a>/);
});

test('markdown: raw HTML and unsafe links never become markup', () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1)) [y](data:text/html,hi) ![i](https://e.com/a.png)\n\n```mermaid\ngraph TD; A-->B\n```');
  assert.equal(/<script|<img|<[a-z][^>]*\son\w+=|href="javascript|href="data/i.test(html), false, html);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /Mermaid diagram \(source/);
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('JaVaScRiPt:alert(1)'), null);
  assert.equal(safeUrl('mailto:a@b.c'), 'mailto:a@b.c');
});

test('highlighting escapes and splits tokens across lines', () => {
  assert.equal(highlight('<div onclick="x">', 'html').includes('<div'), false);
  const lines = highlightLines('/* a\nb */ const x = 1;', 'javascript');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^<span class="tok-comment">\/\* a<\/span>$/);
  assert.match(lines[1], /<span class="tok-comment">b \*\/<\/span>/);
  assert.match(highlight('select * from t where id = 1', 'sql'), /tok-keyword">select/);
  assert.match(highlight('def f(): return None', 'python'), /tok-keyword">def/);
  assert.match(highlight('{"a": 1}', 'json'), /tok-attr">&quot;a&quot;/);
  assert.equal(highlight('constant', 'javascript').includes('tok-keyword'), false, 'no keyword inside a word');
});

test('diffs: added, deleted, renamed and modified files', () => {
  const text = [
    'diff --git a/new.js b/new.js', 'new file mode 100644', '--- /dev/null', '+++ b/new.js', '@@ -0,0 +1,2 @@', '+a', '+b',
    'diff --git a/old.js b/old.js', 'deleted file mode 100644', '--- a/old.js', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
    'diff --git a/c.js b/d.js', 'similarity index 80%', 'rename from c.js', 'rename to d.js', '--- a/c.js', '+++ b/d.js', '@@ -1,2 +1,2 @@', ' keep', '-before', '+after',
  ].join('\n');
  const files = parseDiff(text);
  assert.deepEqual(files.map((f) => f.status), ['added', 'deleted', 'renamed']);
  assert.deepEqual(files[2].hunks[0].rows.map((r) => [r.type, r.old, r.new]), [['ctx', 1, 1], ['del', 2, null], ['add', null, 2]]);
  const html = renderDiff(text, 'javascript');
  assert.match(html, /c\.js → d\.js/);
  assert.match(html, /<tr class="add">/);
  assert.match(html, /<tr class="del">/);
});
