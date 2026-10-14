import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import MarkdownIt from 'markdown-it';
import { collectTasks } from '../public/tasks.js';

// Execute the actual browser renderer against a minimal DOM shell. This catches
// renderer integration regressions (e.g. markdown-it bypasses rules.inline).
function render(markdown) {
  const elements = new Map();
  const element = () => ({
    value: '', textContent: '', innerHTML: '', hidden: false, dataset: {},
    classList: { toggle() {}, contains() { return false; } }, addEventListener() {}, setAttribute() {},
    replaceChildren() {}, append() {}, querySelectorAll() { return []; }, querySelector() { return null; },
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll() { return []; }, addEventListener() {},
    createElement: element, createTextNode: text => text,
  };
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    .replace("import { collectTasks } from './tasks.js';", '')
    .replace("import { createPower } from './power.js';", "const createPower = () => ({ refresh() {}, status() {} });")
    .replace(/load\(\);\s*$/, 'accept({ markdown: fixture, revision: 1, updatedAt: "2026-01-01T00:00:00Z" });');
  vm.runInNewContext(source, {
    document, window: { markdownit: MarkdownIt, addEventListener() {} },
    localStorage: { getItem() { return null; }, removeItem() {}, setItem() {} },
    collectTasks, fixture: markdown, console, setTimeout, clearTimeout,
  });
  return { html: elements.get('preview').innerHTML, done: elements.get('done-count').textContent, total: elements.get('total-count').textContent };
}

test('real browser renderer emits interactive checkboxes, labels and completion count', () => {
  const result = render('# Plans\n\n- [ ] **First** step\n- [x] Finished\n  - [ ] Nested\n\n- [ ] Loose item\n\n  extra paragraph\n\n> - [X] Quoted\n');
  assert.equal((result.html.match(/type="checkbox"/g) || []).length, 5);
  assert.match(result.html, /aria-label="First\s+step"/);
  assert.match(result.html, /data-line="2"/);
  assert.match(result.html, /<label for="task-2" class="task-label"><strong>First<\/strong> step<\/label>/);
  assert.equal((result.html.match(/ checked /g) || []).length, 2);
  assert.equal(result.done, 2);
  assert.equal(result.total, 5);
});

test('rendering untrusted Markdown cannot inject markup, checkbox labels, or remote images', () => {
  const result = render('- [ ] "><img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![spy](https://evil.example/pixel)\n\n```md\n- [ ] Not a task\n```');
  assert.equal((result.html.match(/type="checkbox"/g) || []).length, 1);
  assert.doesNotMatch(result.html, /<script|<img|href="javascript:/);
  assert.match(result.html, /&lt;script&gt;/);
  assert.match(result.html, /aria-label="&quot;&gt;&lt;img/);
  assert.match(result.html, /\[Image: spy\]/);
});

test('empty documents get a useful empty state', () => {
  const result = render('');
  assert.match(result.html, /A fresh page/);
  assert.equal(result.total, 0);
});
