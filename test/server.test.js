import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import MarkdownIt from 'markdown-it';
import { createApp } from '../server.js';
import { collectTasks } from '../public/tasks.js';

async function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'checkerboxer-test-'));
  let app;
  let origin;
  async function start() {
    app = createApp({ dataDir: dir });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    origin = `http://127.0.0.1:${app.server.address().port}`;
  }
  await start();
  t.after(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    get origin() { return origin; },
    async restart() { await app.close(); await start(); },
    async request(path = '/api/document', method = 'GET', body, headers = {}) {
      const res = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, headers: res.headers, body: await res.json() };
    },
  };
}

test('one persistent document, no-op saves, and revision history', async t => {
  const f = await fixture(t);
  const initial = await f.request();
  assert.equal(initial.status, 200);
  assert.match(initial.body.markdown, /- \[ \]/);
  assert.equal(initial.body.revision, 1);
  const markdown = '# Our page\n\n- [ ] Ship it\n- [x] Start\n';
  const saved = await f.request('/api/document', 'PUT', { markdown, revision: 1 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 2);
  const noop = await f.request('/api/document', 'PUT', { markdown, revision: 2 });
  assert.equal(noop.body.revision, 2);
  await f.restart();
  assert.deepEqual((await f.request()).body, saved.body);
  assert.deepEqual((await f.request('/api/history')).body.history.map(h => h.revision), [2, 1]);
  assert.equal((await f.request('/api/history/1')).body.markdown, initial.body.markdown);
  assert.equal((await f.request('/api/history/900')).status, 404);
});

test('simultaneous edits cannot silently overwrite each other', async t => {
  const f = await fixture(t);
  const writes = await Promise.all(['Alice', 'Bob'].map(markdown => f.request('/api/document', 'PUT', { markdown, revision: 1 })));
  assert.deepEqual(writes.map(w => w.status).sort(), [200, 409]);
  const winner = writes.find(w => w.status === 200).body;
  assert.deepEqual(writes.find(w => w.status === 409).body.document, winner);
  assert.deepEqual((await f.request()).body, winner);
});

test('checkbox writes preserve formatting and reject code blocks / stale lines', async t => {
  const f = await fixture(t);
  const markdown = '# Tasks\r\n\r\n- [ ] **Hello**\r\n  - [X] Nested\r\n\r\n```md\r\n- [ ] Code, not a task\r\n```\r\n\r\n> - [ ] Quoted\r\n';
  await f.request('/api/document', 'PUT', { markdown, revision: 1 });
  const changed = await f.request('/api/tasks', 'PATCH', { line: 2, checked: true, revision: 2 });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.markdown, markdown.replace('- [ ] **Hello**', '- [x] **Hello**'));
  assert.equal((await f.request('/api/tasks', 'PATCH', { line: 6, checked: true, revision: 3 })).status, 400);
  assert.equal((await f.request('/api/tasks', 'PATCH', { line: 2, checked: false, revision: 2 })).status, 409);
  const quoted = await f.request('/api/tasks', 'PATCH', { line: 9, checked: true, revision: 3 });
  assert.equal(quoted.status, 200);
  assert.match(quoted.body.markdown, /> - \[x\] Quoted/);
});

test('task parser handles nested, loose, ordered and quoted lists, excluding plain text and fenced/indented code', () => {
  const markdown = '- [ ] One\n  - [x] Nested\n\n- [X] Loose\n\n1. [ ] Ordered\n\n> - [ ] Quoted\n\n[ ] Plain\n\n```\n- [ ] Fenced\n```\n\n    - [ ] Indented code\n';
  const tasks = collectTasks(new MarkdownIt().parse(markdown, {}), markdown);
  assert.deepEqual(tasks.map(t => ({ line: t.line, checked: t.checked })), [
    { line: 0, checked: false }, { line: 1, checked: true }, { line: 3, checked: true }, { line: 5, checked: false }, { line: 7, checked: false },
  ]);
  for (const task of tasks) assert.match(markdown.split('\n')[task.line][task.marker], /[ xX]/);
});

test('validation, size limits, same-origin policy and security headers', async t => {
  const f = await fixture(t);
  for (const body of [null, [], { revision: 1 }, { markdown: 'bad', revision: 0 }, { markdown: 123, revision: 1 }]) {
    assert.equal((await f.request('/api/document', 'PUT', body)).status, 400);
  }
  assert.equal((await f.request('/api/document', 'PUT', { markdown: 'a'.repeat(256 * 1024 + 1), revision: 1 })).status, 413);
  assert.equal((await f.request('/api/document', 'PUT', { markdown: 'bad', revision: 1 }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.request('/api/document', 'PUT', { markdown: 'bad', revision: 1 }, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  const allowed = await f.request('/api/document', 'PUT', { markdown: '', revision: 1 }, { Origin: f.origin });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.markdown, '');
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  assert.match(allowed.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const raw = await fetch(f.origin + '/api/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
  assert.equal(raw.status, 400);
  const noJson = await fetch(f.origin + '/api/document', { method: 'PUT', body: '{}' });
  assert.equal(noJson.status, 415);
});

test('history retains the newest 50 snapshots', async t => {
  const f = await fixture(t);
  for (let revision = 1; revision <= 55; revision++) assert.equal((await f.request('/api/document', 'PUT', { markdown: `Version ${revision}`, revision })).status, 200);
  const history = (await f.request('/api/history')).body.history;
  assert.equal(history.length, 50);
  assert.equal(history[0].revision, 56);
  assert.equal(history.at(-1).revision, 7);
});

test('live event stream delivers initial document, presence and committed writes', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(f.origin + '/api/events', { signal: controller.signal });
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const reader = response.body.getReader();
  let buffer = '';
  async function until(text) {
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      while (!buffer.includes(text)) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        buffer += new TextDecoder().decode(value);
      }
    } finally { clearTimeout(timeout); }
  }
  await until('event: presence');
  assert.match(buffer, /event: document/);
  assert.match(buffer, /"count":1/);
  await f.request('/api/document', 'PUT', { markdown: '- [ ] Broadcast test', revision: 1 });
  await until('Broadcast test');
  assert.match(buffer, /"revision":2/);
  controller.abort();
});

test('static files, health check and sensitive path isolation', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/healthz')).body, { ok: true });
  for (const path of ['/', '/app.js', '/tasks.js', '/styles.css', '/favicon.svg', '/vendor/markdown-it.js']) {
    const response = await fetch(f.origin + path);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0);
  }
  for (const path of ['/server.js', '/data/checkerboxer.sqlite', '/.env', '/package.json', '/api/missing']) {
    assert.equal((await f.request(path)).status, 404, path);
  }
});
