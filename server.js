import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import { collectTasks } from './public/tasks.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_BYTES = 256 * 1024;
const HISTORY_LIMIT = 50;
const parser = new MarkdownIt({ html: false });
const WELCOME = `# A little less to do.

A shared place for the things you want to get done. Make it yours.

## Start here
- [x] Give your checklist a home
- [ ] Check something off
- [ ] Open the editor and make this page yours
- [ ] Share the link with your people

## Make room for the good stuff
- [ ] Ship the thing you've been thinking about
- [ ] Go outside for a bit
- [ ] Celebrate the small wins

---

**One page. Everyone on the same page.**\nAnyone with this link can edit. Changes save automatically and appear live for everyone.
`;

const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['public/app.js', 'text/javascript; charset=utf-8']],
  ['/tasks.js', ['public/tasks.js', 'text/javascript; charset=utf-8']],
  ['/power.js', ['public/power.js', 'text/javascript; charset=utf-8']],
  ['/power.css', ['public/power.css', 'text/css; charset=utf-8']],
  ['/styles.css', ['public/styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['public/favicon.svg', 'image/svg+xml']],
  ['/vendor/markdown-it.js', ['node_modules/markdown-it/dist/markdown-it.min.js', 'text/javascript; charset=utf-8']],
]);

export function createApp({ dataDir = process.env.DATA_DIR || resolve(ROOT, 'data'), now = () => new Date().toISOString() } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(resolve(dataDir, 'checkerboxer.sqlite'));
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS document (id INTEGER PRIMARY KEY CHECK(id = 1), markdown TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS history (revision INTEGER PRIMARY KEY, markdown TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS victories (signature TEXT PRIMARY KEY, xp INTEGER NOT NULL, completed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO document VALUES (1, ?, 1, ?)').run(WELCOME, now());
  db.exec('INSERT OR IGNORE INTO history SELECT revision, markdown, updated_at FROM document');
  const signature = text => createHash('sha256').update(text.replace(/^\[[ xX]\]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
  const completedTasks = markdown => collectTasks(parser.parse(markdown, {}), markdown).filter(t => t.checked);
  // Existing checked tasks are the starting point, not free XP on restart.
  if (!db.prepare("SELECT 1 FROM settings WHERE key = 'game-initialized'").get()) {
    for (const task of completedTasks(db.prepare('SELECT markdown FROM document WHERE id = 1').get().markdown)) {
      db.prepare('INSERT OR IGNORE INTO victories VALUES (?, 0, ?)').run(signature(task.inline.content), now());
    }
    db.prepare("INSERT INTO settings VALUES ('game-initialized', 'yes')").run();
  }
  const getGame = () => {
    const row = db.prepare('SELECT coalesce(sum(xp), 0) AS xp, count(CASE WHEN xp > 0 THEN 1 END) AS completed FROM victories').get();
    const level = Math.floor(Math.sqrt(row.xp / 100)) + 1;
    return { xp: row.xp, completed: row.completed, level, floor: 100 * (level - 1) ** 2, next: 100 * level ** 2 };
  };
  const getDocument = () => {
    const row = db.prepare('SELECT markdown, revision, updated_at FROM document WHERE id = 1').get();
    return { markdown: row.markdown, revision: row.revision, updatedAt: row.updated_at, game: getGame() };
  };
  const clients = new Set();
  const buckets = new Map();
  const files = new Map([...staticFiles].map(([url, [path, type]]) => [url, { body: readFileSync(resolve(ROOT, path)), type }]));
  const sendEvent = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (type, data) => {
    for (const client of clients) {
      if (client.writableLength > 1024 * 1024) client.destroy();
      else sendEvent(client, type, data);
    }
  };
  const presence = () => broadcast('presence', { count: clients.size });
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': heartbeat\n\n');
    const time = Date.now();
    for (const [key, bucket] of buckets) if (time - bucket.start > 60000) buckets.delete(key);
  }, 15000);
  heartbeat.unref();

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const error = (status, message) => Object.assign(new Error(message), { status });
  const readBody = async (req) => {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) throw error(415, 'Send application/json.');
    if (Number(req.headers['content-length']) > MAX_BYTES + 16384) throw error(413, 'This page is too large (256 KB maximum).');
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BYTES + 16384) throw error(413, 'This page is too large (256 KB maximum).');
      chunks.push(chunk);
    }
    try {
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value;
    } catch { throw error(400, 'Invalid JSON body.'); }
  };
  const save = (markdown, revision) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = getDocument();
      if (revision !== current.revision) {
        db.exec('ROLLBACK');
        return { conflict: current };
      }
      if (markdown === current.markdown) {
        db.exec('COMMIT');
        return { document: current };
      }
      const updatedAt = now();
      const next = current.revision + 1;
      db.prepare('UPDATE document SET markdown = ?, revision = ?, updated_at = ? WHERE id = 1').run(markdown, next, updatedAt);
      db.prepare('INSERT INTO history VALUES (?, ?, ?)').run(next, markdown, updatedAt);
      db.prepare('DELETE FROM history WHERE revision <= ?').run(next - HISTORY_LIMIT);
      for (const task of completedTasks(markdown)) {
        db.prepare('INSERT OR IGNORE INTO victories VALUES (?, ?, ?)').run(signature(task.inline.content), /(?:^|\s)!high(?:\s|$)/i.test(task.inline.content) ? 150 : 100, updatedAt);
      }
      db.exec('COMMIT');
      const document = { markdown, revision: next, updatedAt, game: getGame() };
      broadcast('document', document);
      return { document };
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const method = req.method;
      if (method === 'GET' && path === '/healthz') {
        db.prepare('SELECT 1').get();
        return json(res, 200, { ok: true });
      }
      if (method === 'GET' && path === '/api/document') return json(res, 200, getDocument());
      if (method === 'GET' && path === '/api/history') {
        const rows = db.prepare('SELECT revision, updated_at AS updatedAt, substr(markdown, 1, 120) AS preview FROM history ORDER BY revision DESC').all();
        return json(res, 200, { history: rows });
      }
      if (method === 'GET' && /^\/api\/history\/\d+$/.test(path)) {
        const row = db.prepare('SELECT markdown, revision, updated_at AS updatedAt FROM history WHERE revision = ?').get(Number(path.split('/').pop()));
        return json(res, row ? 200 : 404, row || { error: 'That revision is no longer available.' });
      }
      if (method === 'GET' && path === '/api/events') {
        if (clients.size >= 200) return json(res, 503, { error: 'Too many live connections. Try again shortly.' });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2500\n\n');
        clients.add(res);
        sendEvent(res, 'document', getDocument());
        presence();
        res.on('close', () => { clients.delete(res); presence(); });
        return;
      }
      if ((path === '/api/document' && method === 'PUT') || (path === '/api/tasks' && method === 'PATCH')) {
        // No cookies or identity: this is intentionally a public, collaborative page.
        // Still reject browser cross-site writes to prevent drive-by changes.
        if (req.headers['sec-fetch-site'] === 'cross-site') throw error(403, 'Cross-site writes are not allowed.');
        if (req.headers.origin) {
          const expected = process.env.PUBLIC_ORIGIN || `http://${req.headers.host}`;
          let sameHost = false;
          try { sameHost = new URL(req.headers.origin).host === new URL(expected).host; } catch { /* deny */ }
          if (!sameHost) throw error(403, 'Cross-site writes are not allowed.');
        }
        const key = req.socket.remoteAddress;
        let bucket = buckets.get(key);
        if (!bucket || Date.now() - bucket.start > 60000) { bucket = { start: Date.now(), count: 0 }; buckets.set(key, bucket); }
        if (++bucket.count > 240) { res.setHeader('Retry-After', '60'); throw error(429, 'Too many changes. Please wait a minute.'); }
        const body = await readBody(req);
        if (!Number.isSafeInteger(body.revision) || body.revision < 1) throw error(400, 'A valid base revision is required.');
        let markdown = body.markdown;
        if (path === '/api/tasks') {
          if (!Number.isSafeInteger(body.line) || body.line < 0 || typeof body.checked !== 'boolean') throw error(400, 'A task line and checked state are required.');
          const current = getDocument();
          if (current.revision !== body.revision) return json(res, 409, { error: 'The page changed. Your draft is safe.', document: current });
          const task = collectTasks(parser.parse(current.markdown, {}), current.markdown).find(task => task.line === body.line);
          if (!task) throw error(400, 'That line is not a Markdown checkbox.');
          const lines = current.markdown.split('\n');
          lines[task.line] = lines[task.line].slice(0, task.marker) + (body.checked ? 'x' : ' ') + lines[task.line].slice(task.marker + 1);
          markdown = lines.join('\n');
        }
        if (typeof markdown !== 'string') throw error(400, 'Markdown must be a string.');
        if (Buffer.byteLength(markdown) > MAX_BYTES) throw error(413, 'This page is too large (256 KB maximum).');
        const result = save(markdown, body.revision);
        return result.conflict
          ? json(res, 409, { error: 'The page changed. Your draft is safe.', document: result.conflict })
          : json(res, 200, result.document);
      }
      if (path.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      const file = files.get(path);
      if (file && (method === 'GET' || method === 'HEAD')) {
        res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': file.body.length, 'Cache-Control': 'no-cache' });
        return res.end(method === 'HEAD' ? undefined : file.body);
      }
      json(res, 404, { error: 'Not found.' });
    } catch (err) {
      if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Could not save your change. Please try again.' });
      else res.end();
      if (!err.status) console.error(err);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.on('close', () => { clearInterval(heartbeat); db.close(); });
  const close = () => new Promise((resolveClose, reject) => {
    for (const client of clients) client.end();
    server.close(err => err ? reject(err) : resolveClose());
    server.closeIdleConnections();
  });
  return { server, close };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const port = Number(process.env.PORT || 3000);
  app.server.listen(port, '0.0.0.0', () => console.log(`Checkerboxer listening on 0.0.0.0:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    app.close().then(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
