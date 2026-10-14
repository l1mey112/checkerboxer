import { collectTasks } from './tasks.js';

export function createPower({ md, getState, setView, edit, toggle, toast, openHistory, openHelp, download }) {
  const $ = id => document.getElementById(id);
  const esc = text => md.utils.escapeHtml(String(text));
  const today = () => new Date().toLocaleDateString('en-CA');
  let taskList = [];
  let sections = [];
  let focusLine = null;
  let latest = null;
  let commandIndex = 0;
  let commandActions = [];
  let timerSeconds = 25 * 60;
  let timerDuration = timerSeconds;
  let timerEnd = null;
  let combo = 0;
  let lastCompletion = 0;
  let effects = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  let sound = false;
  let audio;
  let lastGame = null;
  let burstTimer;
  let bannerTimer;
  let frame;
  let particles = [];
  const canvas = $('fx-canvas');
  const ctx = canvas.getContext('2d');
  const ranks = ['ROOKIE', 'BOX BREAKER', 'MOMENTUM', 'UNSTOPPABLE', 'CHECKBOX LEGEND', 'FINAL BOSS'];
  try { document.documentElement.dataset.theme = localStorage.getItem('checkerboxer:theme') || 'light'; } catch { /* optional preference */ }

  function parse(markdown) {
    const tokens = md.parse(markdown, {});
    sections = tokens.flatMap((token, i) => token.type === 'heading_open' && token.tag !== 'h1' ? [{ title: tokens[i + 1].content, line: token.map[0], end: markdown.split('\n').length }] : []);
    sections.forEach((section, i) => { section.end = sections[i + 1]?.line ?? markdown.split('\n').length; });
    const tasks = collectTasks(tokens, markdown);
    return tasks.map(task => {
      const source = task.inline.content.replace(/^\[[ xX]\]\s*/, '');
      const section = [...sections].reverse().find(s => s.line < task.line);
      const date = source.match(/(?:^|\s)@(\d{4}-\d{2}-\d{2})(?=\s|$)/)?.[1];
      const due = date && !Number.isNaN(Date.parse(date)) ? date : null;
      const tags = [...source.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map(m => m[1]);
      const priority = /(?:^|\s)!high(?=\s|$)/i.test(source);
      const title = source.replace(/(?:^|\s)(?:!high|#[\p{L}\p{N}_-]+|@\d{4}-\d{2}-\d{2})(?=\s|$)/giu, ' ').trim() || source;
      return { line: task.line, checked: task.checked, source, title, section: section?.title || 'The list', sectionLine: section?.line ?? -1, due, tags, priority };
    });
  }
  function matches(task) {
    const query = $('task-search').value.toLowerCase().trim();
    const filter = $('task-filter').value;
    return (!query || `${task.source} ${task.section}`.toLowerCase().includes(query)) &&
      (filter === 'all' || filter === 'open' && !task.checked || filter === 'done' && task.checked || filter === 'priority' && task.priority && !task.checked || filter === 'due' && task.due && task.due <= today() && !task.checked);
  }
  function badges(task) {
    return `${task.priority ? '<span class="task-badge priority-badge">↗ HIGH</span>' : ''}${task.due ? `<span class="task-badge ${task.due < today() && !task.checked ? 'overdue-badge' : ''}">◷ ${task.due === today() ? 'Today' : esc(task.due)}</span>` : ''}${task.tags.map(tag => `<span class="task-badge tag-badge">#${esc(tag)}</span>`).join('')}`;
  }
  function applyFilter() {
    let count = 0;
    for (const task of taskList) {
      const element = document.querySelector(`#preview [data-line="${task.line}"]`)?.closest('.task-item');
      if (!element) continue;
      const visible = matches(task) || taskList.some(child => child.line > task.line && element.contains(document.querySelector(`#preview [data-line="${child.line}"]`)) && matches(child));
      element.hidden = !visible;
      if (matches(task)) count++;
      element.classList.toggle('priority-task', task.priority);
    }
    const filtering = Boolean($('task-search').value || $('task-filter').value !== 'all');
    $('match-count').textContent = filtering ? `${count} found` : '';
    $('no-matches').hidden = !filtering || count > 0;
    $('preview').classList.toggle('is-filtering', filtering);
    renderBoard();
    renderFocus();
  }
  function taskCard(task) {
    return `<article class="board-task ${task.checked ? 'board-task-done' : ''}" draggable="${!latest.busy && !latest.conflict}" data-drag-line="${task.line}"><div class="board-task-head"><input id="board-task-${task.line}" type="checkbox" data-toggle-line="${task.line}" ${task.checked ? 'checked' : ''} ${latest.busy || latest.conflict ? 'disabled' : ''} aria-label="${esc(task.title)}"><label for="board-task-${task.line}">${md.renderInline(task.title)}</label></div><div class="task-badges">${badges(task)}</div><div class="board-task-footer"><span>${task.checked ? '✓ Done' : '○ Ready to move'}</span><button data-focus-line="${task.line}" title="Focus on this task" aria-label="Focus on ${esc(task.title)}">◎</button></div></article>`;
  }
  function renderBoard() {
    if (!latest) return;
    const groups = [{ title: 'The list', line: -1 }, ...sections].filter(s => s.line >= 0 || taskList.some(t => t.sectionLine === -1));
    $('board-columns').innerHTML = groups.map((group, index) => {
      const all = taskList.filter(t => t.sectionLine === group.line);
      const filtered = all.filter(matches);
      return `<section class="board-column lane-${index % 4}" data-lane="${group.line}"><header><span class="lane-dot"></span><h3>${esc(group.title)}</h3><span class="lane-count">${all.filter(t => t.checked).length}/${all.length}</span></header><div class="board-card-list">${filtered.map(taskCard).join('') || '<div class="board-empty">Room for your next move.</div>'}</div><button class="board-add" data-add-lane="${group.line}">+ Add a task</button></section>`;
    }).join('') || '<div class="board-empty">Add a heading like <code>## This week</code> in Markdown to create a lane.</div>';
  }
  function renderFocus() {
    const open = taskList.filter(t => !t.checked && matches(t)).sort((a, b) => Number(b.priority) - Number(a.priority) || (a.due || '9999').localeCompare(b.due || '9999') || a.line - b.line);
    const current = open.find(t => t.line === focusLine) || open[0];
    focusLine = current?.line ?? null;
    $('focus-remaining').textContent = `${open.length} ${open.length === 1 ? 'task' : 'tasks'} in your orbit`;
    $('focus-task').innerHTML = current ? `<span class="focus-section">${esc(current.section)}</span><h2>${md.renderInline(current.title)}</h2><div class="task-badges">${badges(current)}</div>` : '<span class="focus-section">CLEAR SKIES</span><h2>Nothing pulling<br>at your attention.</h2><p>Take a breath. Or clear your filters for the next thing.</p>';
    $('focus-complete').disabled = !current || latest?.busy || latest?.conflict;
    $('focus-skip').disabled = open.length < 2;
  }
  function goFocus(line) { focusLine = line; setView('focus'); renderFocus(); }
  $('focus-complete').addEventListener('click', () => { if (focusLine !== null) toggle(focusLine, true); });
  $('focus-skip').addEventListener('click', () => {
    const open = taskList.filter(t => !t.checked && matches(t));
    const index = open.findIndex(t => t.line === focusLine);
    focusLine = open[(index + 1) % open.length]?.line ?? null;
    renderFocus();
  });
  $('board-columns').addEventListener('change', event => {
    if (event.target.matches('[data-toggle-line]')) toggle(Number(event.target.dataset.toggleLine), event.target.checked);
  });
  $('board-columns').addEventListener('click', event => {
    const focus = event.target.closest('[data-focus-line]');
    if (focus) goFocus(Number(focus.dataset.focusLine));
    const add = event.target.closest('[data-add-lane]');
    if (add) {
      const lane = Number(add.dataset.addLane);
      openCommand();
      $('command-input').value = '+ ';
      $('command-input').dataset.lane = lane;
      renderCommands();
    }
  });
  let dragging = null;
  $('board-columns').addEventListener('dragstart', event => {
    const card = event.target.closest('[data-drag-line]');
    if (!card || latest.busy || latest.conflict) return event.preventDefault();
    dragging = Number(card.dataset.dragLine);
    event.dataTransfer.setData('text/plain', String(dragging));
    event.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  $('board-columns').addEventListener('dragover', event => {
    const lane = event.target.closest('[data-lane]');
    if (lane && dragging !== null) { event.preventDefault(); lane.classList.add('drag-over'); }
  });
  $('board-columns').addEventListener('dragleave', event => { if (!event.currentTarget.contains(event.relatedTarget)) document.querySelectorAll('.drag-over').forEach(e => e.classList.remove('drag-over')); });
  $('board-columns').addEventListener('drop', event => {
    event.preventDefault();
    const lane = event.target.closest('[data-lane]');
    if (lane && dragging !== null && !latest.busy && !latest.conflict) moveTask(dragging, Number(lane.dataset.lane));
    dragging = null;
    renderBoard();
  });
  $('board-columns').addEventListener('dragend', () => { dragging = null; renderBoard(); });
  function moveTask(line, lane) {
    const state = getState();
    const tokens = md.parse(state.draft, {});
    const task = collectTasks(tokens, state.draft).find(t => t.line === line);
    if (!task) return;
    const lines = state.draft.split('\n');
    const start = task.item.map[0];
    const end = task.item.map[1];
    const group = sections.find(s => s.line === lane);
    let target = group ? group.end : sections[0]?.line ?? lines.length;
    if (target >= start && target <= end) return;
    const block = lines.splice(start, end - start);
    // Move the item's entire Markdown subtree, preserving nested tasks.
    const indent = block[0].match(/^\s*/)[0].length;
    const normalized = block.map(l => l.slice(0, indent).trim() === '' ? l.slice(indent) : l);
    if (target > start) target -= block.length;
    lines.splice(target, 0, '', ...normalized, '');
    edit(lines.join('\n'));
    toast('Moved. The Markdown moved with it.');
  }
  function addTask(text, lane) {
    const state = getState();
    if (!text.trim() || !state.base || state.busy || state.conflict) return;
    const lines = state.draft.split('\n');
    const group = sections.find(s => s.line === lane);
    const at = group ? group.end : sections[0]?.line ?? 0;
    lines.splice(at, 0, `- [ ] ${text.trim().replace(/[\r\n]/g, ' ')}`, '');
    edit(lines.join('\n'));
    toast('Added to the plan.');
  }

  function updateTimer() {
    const remaining = timerEnd ? Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000)) : timerSeconds;
    $('timer-display').textContent = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
    $('timer-ring').style.strokeDashoffset = String(603.2 * (1 - remaining / timerDuration));
    if (timerEnd && remaining === 0) {
      timerEnd = null;
      timerSeconds = timerDuration;
      $('timer-start').textContent = 'Go again ↗';
      toast('Time. Stretch, breathe, take a proper break.');
      chime(3);
      burst(60);
    }
  }
  $('timer-start').addEventListener('click', () => {
    if (timerEnd) { timerSeconds = Math.max(0, Math.ceil((timerEnd - Date.now()) / 1000)); timerEnd = null; $('timer-start').textContent = 'Resume →'; }
    else { timerEnd = Date.now() + timerSeconds * 1000; $('timer-start').textContent = 'Pause Ⅱ'; }
    updateTimer();
  });
  function resetTimer(minutes) {
    timerEnd = null;
    if (minutes) timerDuration = minutes * 60;
    timerSeconds = timerDuration;
    $('timer-start').textContent = 'Start the clock ↗';
    for (const button of document.querySelectorAll('[data-minutes]')) button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) * 60 === timerDuration));
    updateTimer();
  }
  document.querySelectorAll('[data-minutes]').forEach(button => button.addEventListener('click', () => resetTimer(Number(button.dataset.minutes))));
  $('timer-reset').addEventListener('click', () => resetTimer());
  setInterval(() => { updateTimer(); updateCombo(); }, 250);

  const templates = [
    { name: 'The launch sequence', icon: '↗', tag: 'SHIP SOMETHING', desc: 'From wild idea to a link you can share.', source: '\n## Build the thing\n- [ ] Pick the one problem worth solving !high #product\n- [ ] Make the core interaction feel incredible #design\n- [ ] Get the first version working #build\n\n## Get it out there\n- [ ] Give it a name people remember #brand\n- [ ] Deploy and share the link !high #launch\n- [ ] Ask three people to try it #feedback\n- [ ] Ship the fix they all ask for #build\n' },
    { name: 'Win the weekend', icon: 'ϟ', tag: 'HACKATHON MODE', desc: 'Less slide deck. More holy-shit-it-works.', source: '\n## The big swing\n- [ ] Write the one-sentence pitch !high #pitch\n- [ ] Pick the moment that makes people lean in !high #demo\n- [ ] Cut everything that is not that moment #scope\n\n## Make it real\n- [ ] Ship a working end-to-end flow !high #build\n- [ ] Add one detail nobody expects #delight\n- [ ] Get a live link working #deploy\n\n## Bring it home\n- [ ] Rehearse a 90-second demo #pitch\n- [ ] Capture a backup screen recording #demo\n- [ ] Show what happens when two people use it #live\n- [ ] Submit before the deadline !high #ship\n' },
    { name: 'Clear your head', icon: '◎', tag: 'A BETTER DAY', desc: 'A small plan with space to be human.', source: '\n## The one thing\n- [ ] Do the thing I keep putting off !high #focus\n\n## Keep life moving\n- [ ] Reply to the message #life\n- [ ] Move my body for twenty minutes #health\n- [ ] Make something good to eat #life\n\n## Close the loop\n- [ ] Write down one win #reflect\n- [ ] Set up tomorrow’s first task #plan\n- [ ] Close the laptop #rest\n' },
    { name: 'A crew, a plan', icon: '✳', tag: 'DO IT TOGETHER', desc: 'Shared ownership without the status meeting.', source: '\n## This week\n- [ ] Agree on the outcome !high #team\n- [ ] Assign the first small steps #plan\n- [ ] Share a useful resource #team\n\n## In motion\n- [ ] Unblock someone else #team\n- [ ] Show the work before it is perfect #feedback\n\n## The finish line\n- [ ] Tie up the loose ends #ship\n- [ ] Celebrate the people who made it happen #team\n' },
  ];
  $('template-grid').innerHTML = templates.map((t, i) => `<button class="template-card" data-template="${i}"><span class="template-icon">${t.icon}</span><small>${t.tag}</small><h3>${t.name}</h3><p>${t.desc}</p><span class="template-cta">Add to this page ↗</span></button>`).join('');
  $('templates-open').addEventListener('click', () => $('templates-dialog').showModal());
  $('template-grid').addEventListener('click', event => {
    const button = event.target.closest('[data-template]');
    if (!button) return;
    const state = getState();
    if (!state.base || state.busy || state.conflict) return toast('Finish saving or resolve your draft first.');
    edit(state.draft.trimEnd() + '\n' + templates[Number(button.dataset.template)].source);
    $('templates-dialog').close();
    setView('board');
    toast('Playbook added. Make it yours.');
  });

  function changeTheme() {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('checkerboxer:theme', theme); } catch { /* optional */ }
    $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Switch to day mode' : 'Switch to night mode');
    document.querySelector('meta[name="theme-color"]').content = theme === 'dark' ? '#111610' : '#f5f4f0';
  }
  $('theme-toggle').addEventListener('click', changeTheme);
  function openCommand() {
    $('command-input').value = '';
    delete $('command-input').dataset.lane;
    commandIndex = 0;
    renderCommands();
    $('command-dialog').showModal();
    $('command-input').focus();
  }
  $('command-open').addEventListener('click', openCommand);
  function renderCommands() {
    const query = $('command-input').value.toLowerCase().trim();
    const commands = [
      { title: 'Checklist', detail: 'The original. The essential.', icon: '☑', run: () => setView('read') },
      { title: 'Board view', detail: 'See the whole plan in lanes', icon: '▦', run: () => setView('board') },
      { title: 'Focus mode', detail: 'One task. Nothing else.', icon: '◎', run: () => setView('focus') },
      { title: 'Markdown editor', detail: 'Your page, in plain text', icon: '⌘', run: () => setView('edit') },
      { title: 'Split view', detail: 'Write and see it happen', icon: '▥', run: () => setView('split') },
      { title: 'Switch day / night mode', detail: 'Set the mood', icon: '◐', run: changeTheme },
      { title: 'Add a playbook', detail: 'Skip the blank page', icon: '✧', run: () => $('templates-dialog').showModal() },
      { title: 'Version history', detail: 'A little time travel', icon: '↶', run: openHistory },
      { title: 'Download Markdown', detail: 'Your work is always yours', icon: '↓', run: download },
      { title: 'Keyboard shortcuts & syntax', detail: 'Learn the fast lane', icon: '?', run: openHelp },
    ];
    commandActions = query.startsWith('+') ? [{ title: `Add: ${$('command-input').value.slice(1).trim() || 'type a task'}`, detail: 'Press Enter to add a checkbox', icon: '+', run: () => addTask($('command-input').value.slice(1), Number($('command-input').dataset.lane ?? -1)) }] : [
      ...commands.filter(c => `${c.title} ${c.detail}`.toLowerCase().includes(query)),
      ...taskList.filter(t => !t.checked && query && t.source.toLowerCase().includes(query)).slice(0, 8).map(t => ({ title: t.title, detail: t.section, icon: '○', run: () => goFocus(t.line) })),
    ].slice(0, 12);
    commandIndex = Math.min(commandIndex, Math.max(0, commandActions.length - 1));
    $('command-results').innerHTML = commandActions.map((c, i) => `<button data-command="${i}" class="command-result ${i === commandIndex ? 'selected' : ''}"><span>${c.icon}</span><div><strong>${esc(c.title)}</strong><small>${esc(c.detail)}</small></div><kbd>↵</kbd></button>`).join('') || '<p class="command-empty">No matches. Type <strong>+ your task</strong> to add something new.</p>';
  }
  $('command-input').addEventListener('input', () => { commandIndex = 0; renderCommands(); });
  function runCommand(index) { const action = commandActions[index]; if (action) { $('command-dialog').close(); action.run(); } }
  $('command-results').addEventListener('click', event => { const button = event.target.closest('[data-command]'); if (button) runCommand(Number(button.dataset.command)); });
  $('command-input').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandActions.length) % (commandActions.length || 1);
      renderCommands();
      $('command-results').querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    }
    if (event.key === 'Enter') { event.preventDefault(); runCommand(commandIndex); }
  });
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); $('command-dialog').open ? $('command-dialog').close() : openCommand(); }
    const editing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) || document.querySelector('dialog[open]');
    if (!editing && event.key === '/') { event.preventDefault(); $('task-search').focus(); }
    if (!editing && event.key.toLowerCase() === 'f') { event.preventDefault(); setView('focus'); }
    if (!editing && event.key.toLowerCase() === 'b') { event.preventDefault(); setView('board'); }
  });
  $('task-search').addEventListener('input', applyFilter);
  $('task-filter').addEventListener('change', applyFilter);
  $('clear-filters').addEventListener('click', () => { $('task-search').value = ''; $('task-filter').value = 'all'; applyFilter(); });

  function chime(intensity) {
    if (!sound) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      audio.resume();
      [440, 554.37, 659.25, 880].slice(0, Math.min(4, intensity + 1)).forEach((frequency, index) => {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        oscillator.type = 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, audio.currentTime + index * .075);
        gain.gain.linearRampToValueAtTime(.055, audio.currentTime + index * .075 + .01);
        gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + index * .075 + .35);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.start(audio.currentTime + index * .075);
        oscillator.stop(audio.currentTime + index * .075 + .4);
      });
    } catch { /* silent fallback */ }
  }
  function burst(count, full = false) {
    if (!effects || !ctx) return;
    canvas.width = innerWidth; canvas.height = innerHeight;
    const colors = ['#c8f479', '#fbdf72', '#9ddbff', '#e9a7f5', '#ffffff'];
    for (let i = 0; i < count; i++) particles.push({ x: full ? Math.random() * innerWidth : innerWidth * .65, y: full ? -30 : innerHeight * .45, vx: (Math.random() - .5) * (full ? 7 : 20), vy: full ? Math.random() * 5 + 2 : -Math.random() * 16 - 3, size: Math.random() * 7 + 3, color: colors[i % colors.length], life: 1, rotation: Math.random() * 6, spin: (Math.random() - .5) * .3 });
    particles = particles.slice(-450);
    if (!frame) frame = requestAnimationFrame(draw);
  }
  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    particles = particles.filter(p => p.life > 0 && p.y < canvas.height + 30);
    for (const p of particles) {
      p.x += p.vx; p.y += p.vy; p.vy += .2; p.vx *= .99; p.life -= .009; p.rotation += p.spin;
      ctx.save(); ctx.globalAlpha = Math.min(1, p.life * 2); ctx.fillStyle = p.color; ctx.translate(p.x, p.y); ctx.rotate(p.rotation); ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * .55); ctx.restore();
    }
    frame = particles.length ? requestAnimationFrame(draw) : null;
  }
  function updateCombo() {
    const remaining = Math.max(0, 1 - (Date.now() - lastCompletion) / 30000);
    if (!remaining && combo) { combo = 0; document.body.dataset.combo = '0'; }
    $('combo-fill').style.width = `${remaining * 100}%`;
    $('combo-count').textContent = `×${Math.max(1, combo)}`;
    $('combo-label').textContent = combo >= 8 ? 'ABSOLUTELY UNREAL' : combo >= 5 ? 'YOU ARE ON FIRE' : combo >= 3 ? 'UNSTOPPABLE ENERGY' : combo >= 1 ? 'KEEP THE CHAIN ALIVE' : 'BUILD YOUR MOMENTUM';
  }
  function gameUpdate(game, silent = false) {
    if (!game) return;
    $('game-level').textContent = String(game.level).padStart(2, '0');
    $('game-rank').textContent = ranks[Math.min(ranks.length - 1, game.level - 1)];
    $('game-xp').textContent = `${game.xp.toLocaleString()} XP`;
    $('game-next').textContent = `${(game.next - game.xp).toLocaleString()} to level ${game.level + 1}`;
    $('xp-progress').max = game.next - game.floor;
    $('xp-progress').value = game.xp - game.floor;
    $('rank-icon').textContent = ['✧', 'ϟ', '✳', '♜', '✹', '♛'][Math.min(5, game.level - 1)];
    const gained = lastGame ? game.xp - lastGame.xp : 0;
    if (gained > 0 && !silent) {
      combo = Date.now() - lastCompletion < 30000 ? combo + Math.max(1, game.completed - lastGame.completed) : Math.max(1, game.completed - lastGame.completed);
      lastCompletion = Date.now();
      document.body.dataset.combo = String(Math.min(3, Math.ceil(combo / 3)));
      updateCombo();
      $('xp-burst').innerHTML = `<strong>+${gained} XP</strong><span>${combo >= 5 ? 'YOU’RE DESTROYING IT.' : combo >= 3 ? 'MOMENTUM LOOKS GOOD ON YOU.' : 'ONE LESS THING.'}</span>${combo > 1 ? `<small>${combo}× COMBO</small>` : ''}`;
      $('xp-burst').hidden = false;
      $('xp-burst').classList.remove('pop'); void $('xp-burst').offsetWidth; $('xp-burst').classList.add('pop');
      clearTimeout(burstTimer); burstTimer = setTimeout(() => { $('xp-burst').hidden = true; }, 2200);
      burst(25 + Math.min(combo, 10) * 18);
      chime(Math.min(3, combo));
      const completedAll = taskList.length > 0 && taskList.every(t => t.checked);
      if (game.level > lastGame.level || completedAll) {
        $('level-banner').innerHTML = `<span>${completedAll ? 'MISSION COMPLETE' : 'LEVEL UP'}</span><strong>${completedAll ? 'EVERY. BOX. CHECKED.' : `${String(game.level).padStart(2, '0')} / ${ranks[Math.min(5, game.level - 1)]}`}</strong><small>${completedAll ? 'Take the victory lap. You earned it.' : 'The small things are adding up.'}</small>`;
        $('level-banner').hidden = false;
        clearTimeout(bannerTimer); bannerTimer = setTimeout(() => { $('level-banner').hidden = true; }, 3500);
        burst(180, true);
      }
    }
    lastGame = game;
  }
  $('effects-toggle').setAttribute('aria-pressed', String(effects));
  $('effects-toggle').textContent = effects ? '✦ Effects on' : '✦ Effects off';
  document.body.classList.toggle('effects-off', !effects);
  $('effects-toggle').addEventListener('click', () => {
    effects = !effects;
    document.body.classList.toggle('effects-off', !effects);
    $('effects-toggle').textContent = effects ? '✦ Effects on' : '✦ Effects off';
    $('effects-toggle').setAttribute('aria-pressed', String(effects));
    if (!effects) { particles = []; ctx?.clearRect(0, 0, canvas.width, canvas.height); }
  });
  $('sound-toggle').addEventListener('click', () => { sound = !sound; $('sound-toggle').setAttribute('aria-pressed', String(sound)); $('sound-toggle').textContent = sound ? '♪ Sound on' : '♪ Sound off'; if (sound) chime(1); });
  function activity(message) {
    const row = document.createElement('p');
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    row.innerHTML = `<span class="signal-dot"></span><span>${esc(message)}</span><time>${time}</time>`;
    $('activity-feed').prepend(row);
    while ($('activity-feed').children.length > 4) $('activity-feed').lastElementChild.remove();
  }
  let lastRevision;
  return {
    refresh(state) {
      latest = state;
      taskList = parse(state.draft);
      $('priority-count').textContent = taskList.filter(t => !t.checked && t.priority).length;
      $('due-count').textContent = taskList.filter(t => !t.checked && t.due && t.due <= today()).length;
      applyFilter();
      gameUpdate(state.base?.game);
      if (state.base && state.base.revision !== lastRevision) {
        activity(lastRevision ? `Page saved · revision ${state.base.revision}` : 'Connected. Let’s make moves.');
        lastRevision = state.base.revision;
      }
    },
    status(state) {
      latest = state;
      for (const input of $('board-columns').querySelectorAll('input')) input.disabled = state.busy || state.conflict;
      $('focus-complete').disabled = focusLine === null || state.busy || state.conflict;
      // XP comes only from a committed server revision, never a speculative click.
      gameUpdate(state.base?.game);
    },
  };
}
