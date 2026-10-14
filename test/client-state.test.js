import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import MarkdownIt from 'markdown-it';
import { collectTasks } from '../public/tasks.js';

function client(initial = '- [ ] One\n') {
  const elements = new Map();
  const stored = new Map();
  const timers = new Map();
  const requests = [];
  let timer = 0;
  function element() {
    const handlers = {};
    return {
      value: '', textContent: '', innerHTML: '', hidden: true, disabled: false, dataset: {}, checked: false,
      classList: { toggle() {}, contains() { return false; } },
      addEventListener(name, handler) { handlers[name] = handler; },
      setAttribute() {}, replaceChildren() {}, append() {}, focus() {},
      querySelectorAll() { return []; }, querySelector() { return null; },
      showModal() {}, close() {}, handlers,
    };
  }
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    querySelectorAll() { return []; }, addEventListener() {},
    createElement: element, createTextNode: text => text,
  };
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8')
    .replace("import { collectTasks } from './tasks.js';", '')
    .replace("import { createPower } from './power.js';", "const createPower = () => ({ refresh() {}, status() {} });")
    .replace(/load\(\);\s*$/, '');
  const context = vm.createContext({
    document, window: { markdownit: MarkdownIt, addEventListener() {} }, collectTasks, console,
    localStorage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
    setTimeout: fn => { const id = ++timer; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    AbortSignal,
    fetch(path, options) { return new Promise((resolve, reject) => requests.push({ path, options, resolve, reject })); },
  });
  vm.runInContext(source, context);
  const run = source => vm.runInContext(source, context);
  run(`accept({ markdown: ${JSON.stringify(initial)}, revision: 1, updatedAt: '2026-01-01' }); connected = true;`);
  return {
    run, requests, elements, stored, timers,
    state: () => JSON.parse(run('JSON.stringify({ draft, base, pendingRemote, staged, saving, taskPending })')),
    response(index, document, status = 200) {
      requests[index].resolve({ ok: status < 400, status, async json() { return document; } });
    },
  };
}

test('typing during a save preserves new input and schedules the next save', async () => {
  const c = client();
  c.run("updateDraft('- [ ] First edit')");
  const pending = c.run('saveDraft()');
  c.run("updateDraft('- [ ] Second edit')");
  c.run("receive({ markdown: '- [ ] First edit', revision: 2 })");
  c.response(0, { markdown: '- [ ] First edit', revision: 2 });
  await pending;
  assert.equal(c.state().draft, '- [ ] Second edit');
  assert.equal(c.state().base.revision, 2);
  assert.equal(c.state().pendingRemote, null);
  assert.ok(c.timers.size);
  const next = c.run('saveDraft()');
  assert.deepEqual(JSON.parse(c.requests[1].options.body), { markdown: '- [ ] Second edit', revision: 2 });
  c.response(1, { markdown: '- [ ] Second edit', revision: 3 });
  await next;
  assert.equal(c.stored.size, 0);
});

test('concurrent live updates keep the local draft and block autosave until resolved', async () => {
  const c = client();
  c.run("updateDraft('- [ ] Mine')");
  c.run("receive({ markdown: '- [x] Theirs', revision: 2 })");
  await c.run('saveDraft()');
  assert.equal(c.requests.length, 0);
  assert.equal(c.state().draft, '- [ ] Mine');
  assert.equal(c.elements.get('conflict').hidden, false);
  assert.equal(JSON.parse([...c.stored.values()][0]).markdown, '- [ ] Mine');
  c.elements.get('keep-draft').handlers.click();
  assert.equal(c.requests.length, 1);
  assert.equal(JSON.parse(c.requests[0].options.body).revision, 2);
  c.response(0, { markdown: '- [ ] Mine', revision: 3 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state().base.revision, 3);
});

test('newer buffered live updates win after a successful save without losing later local edits', async () => {
  const c = client();
  c.run("updateDraft('My first')");
  const pending = c.run('saveDraft()');
  c.run("updateDraft('My second'); receive({ markdown: 'Other person', revision: 3 })");
  c.response(0, { markdown: 'My first', revision: 2 });
  await pending;
  assert.equal(c.state().base.revision, 2);
  assert.equal(c.state().pendingRemote.revision, 3);
  assert.equal(c.state().draft, 'My second');
  assert.equal(c.elements.get('conflict').hidden, false);
});

test('failed writes keep a recovery draft and do not loop retries', async () => {
  const c = client();
  c.run("updateDraft('Offline change')");
  const pending = c.run('saveDraft()');
  c.requests[0].reject(new Error('Offline'));
  await pending;
  assert.equal(c.state().saving, false);
  assert.equal(c.state().draft, 'Offline change');
  assert.equal(c.elements.get('error-banner').hidden, false);
  assert.equal(JSON.parse([...c.stored.values()][0]).markdown, 'Offline change');
  assert.equal(c.timers.size, 0);
});

test('history drafts stay staged through typing and passive save attempts', async () => {
  const c = client();
  c.run("selectedVersion = { markdown: 'Old version', revision: 1 }");
  c.elements.get('restore').handlers.click();
  c.run("updateDraft('Reviewed old version')");
  await c.run('saveDraft()');
  assert.equal(c.state().staged, true);
  assert.equal(c.requests.length, 0);
  assert.equal(c.elements.get('staged-banner').hidden, false);
  assert.equal(JSON.parse([...c.stored.values()][0]).staged, true);
  c.elements.get('publish-staged').handlers.click();
  assert.equal(c.requests.length, 1);
  c.response(0, { markdown: 'Reviewed old version', revision: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.state().staged, false);
  assert.equal(c.state().base.revision, 2);
});

test('quick add inserts a real task even with trailing fenced code', () => {
  for (const initial of ['# Notes\n\n```md\n- [ ] Not a task\n', '- [ ] Existing\n\n```md\ncode\n```\n', '> - [ ] Quoted\n', '1. [ ] Ordered\n']) {
    const c = client(initial);
    c.elements.get('new-task').value = 'A new thing';
    c.elements.get('quick-add').handlers.submit({ preventDefault() {} });
    const draft = c.state().draft;
    const tasks = collectTasks(new MarkdownIt().parse(draft, {}), draft);
    assert.ok(tasks.some(t => t.inline.content === '[ ] A new thing'), draft);
    assert.equal(c.elements.get('new-task').value, '');
    assert.ok(draft.includes(initial.includes('Existing') ? 'Existing' : initial.includes('Quoted') ? 'Quoted' : initial.includes('Ordered') ? 'Ordered' : 'Not a task'));
  }
});
