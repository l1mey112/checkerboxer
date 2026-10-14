import { collectTasks } from './tasks.js';
import { createPower } from './power.js';

const $ = id => document.getElementById(id);
const editor = $('editor');
const preview = $('preview');
const storageKey = 'checkerboxer:draft:v1';
const md = window.markdownit({ html: false, linkify: true, breaks: false, typographer: false });
// Remote images would leak a visitor's IP to whoever wrote the Markdown.
md.renderer.rules.image = (tokens, idx) => `<span class="image-placeholder">[Image: ${md.utils.escapeHtml(tokens[idx].content || 'image')}]</span>`;

let base = null;
let draft = '';
let pendingRemote = null;
let saving = false;
let taskPending = false;
let connected = false;
let saveTimer;
let toastTimer;
let view = 'read';
let selectedVersion = null;
let recovery = null;
let storageWarningShown = false;
let staged = false;
let renderTimer;
let undoTask = null;
let power;
const powerState = () => ({ draft, base, busy: saving || taskPending, conflict: conflicting() });
try { recovery = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch { /* Private mode or a damaged local draft. */ }
const dirty = () => base && draft !== base.markdown;
const conflicting = () => Boolean(pendingRemote && pendingRemote.revision > base?.revision);

function toast(message, action) {
  $('toast').textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.addEventListener('click', action.run, { once: true });
    $('toast').append(button);
  }
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, action ? 7000 : 3500);
}
function backup() {
  try {
    if (dirty()) localStorage.setItem(storageKey, JSON.stringify({ markdown: draft, revision: base.revision, baseMarkdown: base.markdown, staged }));
    else localStorage.removeItem(storageKey);
  } catch {
    if (!storageWarningShown) { toast('Browser draft backup is unavailable. Keep this tab open until saved.'); storageWarningShown = true; }
  }
}
function showError(message) { $('error-message').textContent = message; $('error-banner').hidden = false; }
function clearError() { $('error-banner').hidden = true; }
function status() {
  const text = !base ? 'Loading page' : conflicting() ? 'Your draft needs a review' : saving || taskPending ? 'Saving changes…' : staged ? 'Reviewing a draft · not published' : dirty() ? (connected ? 'Unsaved changes' : storageWarningShown ? 'Unsaved · keep this tab open' : 'Draft saved in this browser') : connected ? 'All changes saved' : 'Saved · reconnecting';
  $('save-status').replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'status-dot';
  $('save-status').append(dot, document.createTextNode(text));
  $('revision').textContent = base ? `REV ${base.revision} · ONE PAGE, TOGETHER` : 'ONE PAGE, TOGETHER';
  $('conflict').hidden = !conflicting();
  $('staged-banner').hidden = !staged || conflicting();
  $('presence').classList.toggle('offline', !connected);
  if (!connected) $('presence-text').textContent = 'Reconnecting';
  $('add-task').disabled = !base || taskPending;
  $('new-task').disabled = !base || taskPending;
  $('restore').disabled = !selectedVersion || saving || taskPending;
  for (const checkbox of preview.querySelectorAll('.task-checkbox')) checkbox.disabled = saving || taskPending || conflicting();
  power?.status(powerState());
}
function render() {
  if (!base) return;
  const focusedLine = document.activeElement?.classList?.contains('task-checkbox') ? document.activeElement.dataset.line : null;
  const tokens = md.parse(draft, {});
  const tasks = collectTasks(tokens, draft);
  for (const task of tasks) {
    task.item.attrJoin('class', `task-item${task.checked ? ' is-done' : ''}`);
    const index = tokens.indexOf(task.inline);
    tokens[index - 1].hidden = true;
    if (tokens[index + 1]?.type === 'paragraph_close') tokens[index + 1].hidden = true;
    task.inline.children = md.parseInline(task.inline.content.replace(/^\[[ xX]\]\s?/, ''), {})[0].children;
    const label = task.inline.children.filter(t => t.type === 'text' || t.type === 'code_inline').map(t => t.content).join(' ').replace(/\s+/g, ' ').trim() || 'Untitled task';
    const opening = new task.inline.constructor('html_inline', '', 0);
    opening.content = `<input id="task-${task.line}" type="checkbox" class="task-checkbox" data-line="${task.line}" aria-label="${md.utils.escapeHtml(label)}" ${task.checked ? 'checked' : ''} ${saving || taskPending || conflicting() ? 'disabled' : ''}><label for="task-${task.line}" class="task-label">`;
    const closing = new task.inline.constructor('html_inline', '', 0);
    closing.content = '</label>';
    task.inline.children.unshift(opening);
    task.inline.children.push(closing);
  }
  preview.innerHTML = draft.trim() ? md.renderer.render(tokens, md.options, { busy: saving || taskPending || conflicting() }) : '<h1>A fresh page.</h1><p>Every good plan starts somewhere. Add your first to-do below, or open Markdown and make this space yours.</p>';
  preview.setAttribute('aria-busy', 'false');
  const done = tasks.filter(t => t.checked).length;
  const total = tasks.length;
  const remaining = total - done;
  $('done-count').textContent = done;
  $('total-count').textContent = total;
  $('progress').max = total || 1;
  $('progress').value = done;
  $('percent').textContent = `${total ? Math.round(done / total * 100) : 0}%`;
  $('remaining').textContent = total ? remaining ? `${remaining} little ${remaining === 1 ? 'thing' : 'things'} to go` : 'You did the things!' : 'A fresh start';
  $('progress-caption').textContent = total && done === total ? 'all done. Take a breath.' : 'boxes checked. Keep going.';
  $('all-done').hidden = !(total && done === total && $('hide-completed').checked);
  const heading = tokens.findIndex(t => t.type === 'heading_open' && t.tag === 'h1');
  document.title = heading >= 0 ? `${tokens[heading + 1].content.slice(0, 80)} — Checkerboxer` : 'Checkerboxer — one shared checklist';
  status();
  if (focusedLine !== null) preview.querySelector(`[data-line="${focusedLine}"]`)?.focus({ preventScroll: true });
  power?.refresh(powerState());
}
function accept(document) {
  clearTimeout(renderTimer);
  staged = false;
  base = document;
  draft = document.markdown;
  editor.value = draft;
  editor.disabled = false;
  pendingRemote = null;
  backup();
  clearError();
  render();
}
function receive(document) {
  if (!base) return;
  if (document.revision <= base.revision) return;
  if (pendingRemote && document.revision < pendingRemote.revision) return;
  if (saving || taskPending) { pendingRemote = document; return; }
  if ((dirty() || staged) && draft !== document.markdown) {
    pendingRemote = document;
    clearTimeout(saveTimer);
    status();
  } else accept(document);
}
function scheduleSave() {
  backup();
  clearTimeout(saveTimer);
  status();
  if (!conflicting() && !staged) saveTimer = setTimeout(saveDraft, 650);
}
async function api(path, options) {
  const response = await fetch(path, { cache: 'no-store', signal: AbortSignal.timeout(15000), ...options });
  let data;
  try { data = await response.json(); } catch { throw new Error('The server is unavailable. Your draft stays in this browser.'); }
  if (!response.ok) {
    const err = new Error(data.error || 'Something went wrong. Please try again.');
    err.status = response.status;
    err.document = data.document;
    throw err;
  }
  return data;
}
async function saveDraft() {
  clearTimeout(saveTimer);
  if (!dirty() || saving || taskPending || conflicting() || staged) return;
  const sent = draft;
  saving = true;
  status();
  try {
    const document = await api('/api/document', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ markdown: sent, revision: base.revision }) });
    base = document;
    if (pendingRemote?.revision <= base.revision) pendingRemote = null;
    backup();
    clearError();
  } catch (err) {
    if (err.status === 409) pendingRemote = err.document;
    else showError(err.message || 'You’re offline. Your draft stays in this browser; retry when connected.');
  } finally {
    saving = false;
    if (pendingRemote && pendingRemote.revision > base.revision) receive(pendingRemote);
    status();
    if (dirty() && !conflicting() && $('error-banner').hidden) scheduleSave();
  }
}
function updateDraft(value, deferRender = false) {
  draft = value;
  if (editor.value !== value) editor.value = value;
  clearTimeout(renderTimer);
  if (deferRender) renderTimer = setTimeout(render, 120);
  else render();
  scheduleSave();
}
function setView(next) {
  view = next;
  $('document-body').dataset.view = view;
  $('editor-pane').hidden = !['edit', 'split'].includes(view);
  $('preview-pane').hidden = !['read', 'split'].includes(view);
  $('board-pane').hidden = view !== 'board';
  $('focus-pane').hidden = view !== 'focus';
  $('task-tools').hidden = view === 'edit';
  document.body.dataset.view = view;
  for (const button of document.querySelectorAll('[data-view]')) {
    if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.view === view));
  }
}

editor.addEventListener('input', () => updateDraft(editor.value, true));
for (const button of document.querySelectorAll('button[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
$('hide-completed').addEventListener('change', event => { preview.classList.toggle('hide-done', event.target.checked); render(); });
preview.addEventListener('change', async event => {
  const checkbox = event.target.closest('.task-checkbox');
  if (!checkbox || !base) return;
  const line = Number(checkbox.dataset.line);
  const checked = checkbox.checked;
  if (saving || taskPending || conflicting()) return render();
  if (dirty()) {
    const task = collectTasks(md.parse(draft, {}), draft).find(t => t.line === line);
    if (!task) return render();
    const lines = draft.split('\n');
    lines[line] = lines[line].slice(0, task.marker) + (checked ? 'x' : ' ') + lines[line].slice(task.marker + 1);
    updateDraft(lines.join('\n'));
    return;
  }
  taskPending = true;
  editor.disabled = true;
  status();
  try {
    const document = await api('/api/tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line, checked, revision: base.revision }) });
    const remote = pendingRemote;
    accept(document);
    if (remote?.revision > document.revision) pendingRemote = remote;
    undoTask = { line, checked: !checked, revision: document.revision };
    toast(checked ? 'One less thing. Nice.' : 'Back on the list.', { label: 'Undo', run: undoLastTask });
  } catch (err) {
    if (err.status === 409) { accept(err.document); toast('The page changed. Please check that box again.'); }
    else showError('Could not save that checkbox. Reconnect and try again.');
    render();
  } finally {
    taskPending = false;
    editor.disabled = false;
    if (pendingRemote) receive(pendingRemote);
    status();
  }
});
async function undoLastTask() {
  const task = undoTask;
  if (!task || task.revision !== base?.revision || dirty() || saving || taskPending || conflicting()) return toast('The page has moved on. Toggle the checkbox to change it.');
  taskPending = true;
  editor.disabled = true;
  status();
  try {
    const document = await api('/api/tasks', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(task) });
    const remote = pendingRemote;
    accept(document);
    if (remote?.revision > document.revision) pendingRemote = remote;
    undoTask = null;
    toast('Undone.');
  } catch (err) {
    if (err.document) accept(err.document);
    toast('The page changed. Toggle the checkbox to change it.');
  } finally {
    taskPending = false;
    editor.disabled = false;
    if (pendingRemote) receive(pendingRemote);
    status();
  }
}
$('quick-add').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('new-task').value.trim().replace(/[\r\n]+/g, ' ');
  if (!text || !base || taskPending) return;
  // Insert after the last parsed task, not into a trailing code fence or quote.
  const tasks = collectTasks(md.parse(draft, {}), draft);
  const last = tasks.at(-1);
  const lines = draft.split('\n');
  const marker = last && lines[last.line].match(/^(\s*(?:>\s*)*)([-+*]|\d+[.)])\s+/);
  const prefix = marker ? `${marker[1]}${/^\d/.test(marker[2]) ? `${parseInt(marker[2]) + 1}${marker[2].slice(-1)}` : marker[2]} ` : '- ';
  const line = `${prefix}[ ] ${text}`;
  if (last) lines.splice(last.item.map[1], 0, line);
  else lines.unshift(line, '');
  updateDraft(lines.join('\n'));
  $('new-task').value = '';
  $('new-task').focus();
});

function insertText(text, start = editor.selectionStart, end = editor.selectionEnd, selectStart, selectEnd) {
  editor.setRangeText(text, start, end, 'end');
  if (selectStart != null) editor.setSelectionRange(selectStart, selectEnd ?? selectStart);
  updateDraft(editor.value);
  editor.focus();
}
for (const button of document.querySelectorAll('[data-insert]')) button.addEventListener('click', () => {
  if (!base || editor.disabled) return;
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const selected = editor.value.slice(start, end);
  if (button.dataset.insert === 'bold') insertText(`**${selected || 'bold text'}**`, start, end, start + 2, start + 2 + (selected || 'bold text').length);
  if (button.dataset.insert === 'link') insertText(`[${selected || 'link text'}](https://)`, start, end, start + (selected || 'link text').length + 3, start + (selected || 'link text').length + 11);
  if (button.dataset.insert === 'task' || button.dataset.insert === 'heading') {
    const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
    const prefix = button.dataset.insert === 'task' ? '- [ ] ' : '## ';
    insertText(prefix, lineStart, lineStart, start + prefix.length, end + prefix.length);
  }
});
editor.addEventListener('keydown', event => {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
  const before = editor.value.slice(lineStart, start);
  if (event.key === 'Tab') {
    event.preventDefault();
    if (event.shiftKey) {
      const indent = editor.value.slice(lineStart).match(/^ {1,2}/)?.[0].length || 0;
      insertText('', lineStart, lineStart + indent, Math.max(lineStart, start - indent), Math.max(lineStart, end - indent));
    } else insertText('  ', start, end);
  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    const currentLine = editor.value.slice(0, start).split('\n').length - 1;
    const task = collectTasks(md.parse(editor.value, {}), editor.value).find(t => t.line === currentLine);
    if (task) insertText(task.checked ? ' ' : 'x', lineStart + task.marker, lineStart + task.marker + 1, start, end);
  } else if (event.key === 'Enter' && !event.shiftKey && start === end) {
    const match = before.match(/^(\s*)([-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?/);
    if (!match) return;
    event.preventDefault();
    if (!before.slice(match[0].length).trim()) insertText('', lineStart, start);
    else {
      const marker = /^\d/.test(match[2]) ? `${parseInt(match[2]) + 1}${match[2].slice(-1)}` : match[2];
      const prefix = `${match[1]}${marker} ${/\[[ xX]\]/.test(match[0]) ? '[ ] ' : ''}`;
      insertText(`\n${prefix}`);
    }
  }
});
document.addEventListener('keydown', event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveDraft(); }
});
window.addEventListener('beforeunload', event => {
  if (dirty() || saving || taskPending || $('new-task').value.trim()) { backup(); event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) { backup(); saveDraft(); } });
window.addEventListener('online', () => { if (!conflicting()) saveDraft(); });

$('retry').addEventListener('click', () => { clearError(); if (!base) load(); else if (dirty()) saveDraft(); else api('/api/document').then(receive).catch(err => showError(err.message)); });
$('use-latest').addEventListener('click', () => {
  if (!pendingRemote) return;
  // Keep an explicit local download before discarding the draft.
  download(draft, 'checkerboxer-unsent-draft.md');
  accept(pendingRemote);
  toast('Latest page loaded. Your old draft was downloaded.');
});
$('keep-draft').addEventListener('click', () => {
  if (!pendingRemote || saving) return;
  base = pendingRemote;
  pendingRemote = null;
  staged = false;
  backup();
  status();
  saveDraft();
});
$('compare').addEventListener('click', () => {
  $('compare-local').textContent = draft;
  $('compare-remote').textContent = pendingRemote?.markdown || '';
  $('compare-dialog').showModal();
});
$('help-link').addEventListener('click', event => { event.preventDefault(); $('help-dialog').showModal(); });
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close(); } });

function download(markdown, filename) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').addEventListener('click', () => { if (base) download(draft, 'checkerboxer.md'); });
$('share').addEventListener('click', async () => {
  const url = `${location.origin}/`;
  try { await navigator.clipboard.writeText(url); toast('Link copied. Anyone with it can edit.'); }
  catch { showError(`Copy this link to share your page: ${url}`); }
});
$('history').addEventListener('click', async () => {
  $('history-dialog').showModal();
  $('history-list').textContent = 'Loading saved versions…';
  $('history-detail').hidden = true;
  selectedVersion = null;
  try {
    const { history } = await api('/api/history');
    $('history-list').replaceChildren();
    for (const item of history) {
      const row = document.createElement('button');
      row.className = 'history-row';
      row.setAttribute('aria-pressed', 'false');
      const title = document.createElement('span');
      title.textContent = `Revision ${item.revision} · ${item.preview.replace(/[#\n]/g, ' ').trim()}`;
      const date = document.createElement('time');
      date.dateTime = item.updatedAt;
      date.textContent = new Date(item.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      row.append(title, date);
      row.addEventListener('click', async () => {
        try {
          const version = await api(`/api/history/${item.revision}`);
          selectedVersion = version;
          for (const button of $('history-list').children) button.setAttribute('aria-pressed', String(button === row));
          $('history-source').textContent = version.markdown;
          $('history-detail').hidden = false;
          status();
        } catch (err) { toast(err.message); }
      });
      $('history-list').append(row);
    }
  } catch (err) { $('history-list').textContent = err.message; }
});
$('restore').addEventListener('click', () => {
  if (!selectedVersion || !base || taskPending || saving) return;
  if (dirty()) download(draft, 'checkerboxer-unsent-draft.md');
  // Restores are staged, not silently written to the shared page.
  staged = true;
  draft = selectedVersion.markdown;
  editor.value = draft;
  clearTimeout(saveTimer);
  backup();
  setView('edit');
  render();
  $('history-dialog').close();
  editor.focus();
  toast('Version loaded as a draft. Review it, then choose Publish.');
});
$('publish-staged').addEventListener('click', () => { staged = false; status(); saveDraft(); });
$('discard-staged').addEventListener('click', () => { if (dirty()) download(draft, 'checkerboxer-unsent-draft.md'); accept(pendingRemote || base); });

let events;
function subscribe() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('open', () => { connected = true; status(); });
  events.addEventListener('document', event => {
    receive(JSON.parse(event.data));
    // Reconnection supplies the newest revision before retrying a local save.
    if (dirty() && !conflicting() && !saving) scheduleSave();
  });
  events.addEventListener('presence', event => {
    connected = true;
    const { count } = JSON.parse(event.data);
    $('presence-text').textContent = count === 1 ? 'Just you, for now' : `${count} here together`;
    status();
  });
  events.addEventListener('error', () => { connected = false; status(); });
}
async function load() {
  try {
    const document = await api('/api/document');
    const saved = recovery;
    recovery = null;
    accept(document);
    if (saved && typeof saved.markdown === 'string' && saved.markdown !== document.markdown && saved.markdown !== saved.baseMarkdown && Number.isSafeInteger(saved.revision)) {
      draft = saved.markdown;
      staged = Boolean(saved.staged);
      editor.value = draft;
      if (saved.revision !== document.revision || saved.baseMarkdown !== document.markdown) {
        base = { markdown: typeof saved.baseMarkdown === 'string' ? saved.baseMarkdown : '', revision: Math.min(saved.revision, document.revision - 1), updatedAt: document.updatedAt };
        pendingRemote = document;
      }
      setView('edit');
      backup();
      render();
      toast('Your unsaved draft is back.');
      if (!conflicting()) scheduleSave();
    }
    subscribe();
  } catch { showError('Couldn’t load the shared page. Check your connection and retry.'); status(); }
}
power = createPower({ md, getState: powerState, setView, edit: updateDraft, toast,
  toggle(line, checked) { const checkbox = preview.querySelector(`[data-line="${line}"]`); if (checkbox && !checkbox.disabled) { checkbox.checked = checked; checkbox.dispatchEvent(new Event('change', { bubbles: true })); } },
  openHistory: () => $('history').click(), openHelp: () => $('help-dialog').showModal(), download: () => download(draft, 'checkerboxer.md'),
});
load();
