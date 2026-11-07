(function () {
  'use strict';

  /* ============================================================
     Tiny DOM helper — builds elements without innerHTML, so German
     quotes/apostrophes in the exam text never need escaping.
     ============================================================ */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const k in props) {
        if (k === 'className') el.className = props[k];
        else if (k === 'html') el.innerHTML = props[k]; // only used for trusted static icons, never exam text
        else if (k.startsWith('on') && typeof props[k] === 'function') el.addEventListener(k.slice(2), props[k]);
        else if (k === 'value') el.value = props[k];
        else if (k === 'checked') el.checked = props[k];
        else if (k === 'disabled') el.disabled = props[k];
        else if (props[k] !== false && props[k] != null) el.setAttribute(k, props[k]);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function mount(el, ...children) { clear(el); children.flat(Infinity).forEach(c => c != null && c !== false && el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)); }

  function fmtClock(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  function fmtPoints(n) {
    const r = Math.round(n * 10) / 10;
    return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace('.', ',');
  }

  /* ============================================================
     State
     ============================================================ */
  const State = {
    examList: [],
    exam: null,          // currently loaded exam JSON
    answers: {},          // itemNumber -> answer key ('a'..'x' / '+' / '-')
    writing: { text: '', score: null, checklist: {} },
    timers: {},            // blockId -> { elapsed, running, lastStart, started }
  };
  const AudioFiles = {}; // sectionId -> ObjectURL (not persisted — File objects can't survive reload)

  function storageKey(examId) { return 'telcb1trainer:' + examId; }
  function loadSavedState(examId) {
    try {
      const raw = localStorage.getItem(storageKey(examId));
      if (raw) return JSON.parse(raw);
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveState() {
    if (!State.exam) return;
    try {
      localStorage.setItem(storageKey(State.exam.id), JSON.stringify({
        answers: State.answers, writing: State.writing, timers: State.timers
      }));
    } catch (e) { /* storage unavailable — continue without persistence */ }
  }
  function hasSavedAttempt(examId) {
    try { return !!localStorage.getItem(storageKey(examId)); } catch (e) { return false; }
  }

  async function fetchJSON(path) {
    const res = await fetch(path);
    if (!res.ok) throw new Error('Konnte ' + path + ' nicht laden.');
    return res.json();
  }

  /* ============================================================
     Timer
     ============================================================ */
  function ensureTimer(blockId) {
    if (!State.timers[blockId]) State.timers[blockId] = { elapsed: 0, running: false, lastStart: 0, started: false };
    return State.timers[blockId];
  }
  function getElapsed(blockId) {
    const t = State.timers[blockId];
    if (!t) return 0;
    return t.elapsed + (t.running ? Date.now() - t.lastStart : 0);
  }
  function startTimer(blockId) {
    const t = ensureTimer(blockId);
    if (t.running) return;
    t.running = true; t.started = true; t.lastStart = Date.now();
    saveState();
  }
  function pauseTimer(blockId) {
    const t = State.timers[blockId];
    if (!t || !t.running) return;
    t.elapsed += Date.now() - t.lastStart;
    t.running = false;
    saveState();
  }
  function pauseAllTimers() { Object.keys(State.timers).forEach(pauseTimer); }
  function isPaused(blockId) {
    const t = State.timers[blockId];
    return !!(t && t.started && !t.running);
  }

  /* ============================================================
     Exam data helpers
     ============================================================ */
  function findBlock(id) { return State.exam.blocks.find(b => b.id === id); }
  function findSection(id) { return State.exam.sections.find(s => s.id === id); }
  function blockOf(sectionId) { return State.exam.blocks.find(b => b.sections.includes(sectionId)); }
  function optionText(options, key) {
    const o = options.find(o => o.key === key);
    return o ? o.text : key;
  }
  function sectionAnsweredCount(section) {
    if (section.type === 'writing') return 0;
    return section.items.filter(it => State.answers[it.number] != null && State.answers[it.number] !== '').length;
  }
  function sectionTotalCount(section) { return section.type === 'writing' ? 0 : section.items.length; }
  function isItemCorrect(item) { return State.answers[item.number] === item.correct; }
  function sectionScore(section) {
    if (section.type === 'writing') return State.writing.score || 0;
    const correct = section.items.filter(isItemCorrect).length;
    return correct * section.pointsPerItem;
  }
  function objectiveTotal() {
    return State.exam.sections.filter(s => s.type !== 'writing').reduce((sum, s) => sum + sectionScore(s), 0);
  }
  function writtenTotal() { return objectiveTotal() + (State.writing.score || 0); }

  /* ============================================================
     Router
     ============================================================ */
  function parseHash() {
    const raw = (location.hash || '#exams').slice(1);
    const parts = raw.split('/').filter(Boolean);
    if (parts[0] === 'exam' && parts[1]) {
      if (parts[2] === 'results') return { type: 'results', examId: parts[1] };
      if (parts[2] && parts[3]) return { type: 'section', examId: parts[1], blockId: parts[2], sectionId: parts[3] };
      return { type: 'block', examId: parts[1] };
    }
    return { type: 'list' };
  }
  window.addEventListener('hashchange', renderApp);

  /* ============================================================
     Root render dispatcher
     ============================================================ */
  const appEl = document.getElementById('app');
  const timerBox = document.getElementById('timerBox');
  const clockLabel = document.getElementById('clockLabel');
  const timerToggle = document.getElementById('timerToggle');
  document.getElementById('brandHome').addEventListener('click', () => { location.hash = '#exams'; });

  let activeBlockId = null; // which block's timer the topbar currently drives

  async function renderApp() {
    const route = parseHash();

    if (route.type === 'list') {
      activeBlockId = null;
      timerBox.hidden = true;
      removePauseOverlay();
      return renderExamList();
    }

    // Ensure the right exam is loaded
    if (!State.exam || State.exam.id !== route.examId) {
      mount(appEl, h('div', { className: 'empty-state' }, 'Lädt Übungstest …'));
      const entry = State.examList.find(e => e.id === route.examId);
      if (!entry) { location.hash = '#exams'; return; }
      const exam = await fetchJSON('exams/' + entry.file);
      State.exam = exam;
      const saved = loadSavedState(exam.id);
      State.answers = (saved && saved.answers) || {};
      State.writing = (saved && saved.writing) || { text: '', score: null, checklist: {} };
      State.timers = (saved && saved.timers) || {};
    }

    if (route.type === 'block') {
      activeBlockId = null;
      timerBox.hidden = true;
      removePauseOverlay();
      return renderBlockOverview();
    }
    if (route.type === 'section') {
      const block = findBlock(route.blockId);
      const section = findSection(route.sectionId);
      if (!block || !section) { location.hash = '#exam/' + route.examId; return; }
      activeBlockId = block.id;
      if (!State.timers[block.id] || !State.timers[block.id].started) startTimer(block.id);
      updateTimerBox();
      return renderSection(block, section);
    }
    if (route.type === 'results') {
      activeBlockId = null;
      timerBox.hidden = true;
      removePauseOverlay();
      return renderResults();
    }
  }

  timerToggle.addEventListener('click', () => {
    if (!activeBlockId) return;
    if (State.timers[activeBlockId] && State.timers[activeBlockId].running) pauseTimer(activeBlockId);
    else startTimer(activeBlockId);
    updateTimerBox();
    renderApp(); // refresh pause overlay + section lock state
  });

  function updateTimerBox() {
    if (!activeBlockId) { timerBox.hidden = true; return; }
    timerBox.hidden = false;
    const t = ensureTimer(activeBlockId);
    timerBox.classList.toggle('running', t.running);
    timerBox.classList.toggle('paused', !t.running);
    clockLabel.textContent = fmtClock(getElapsed(activeBlockId));
    timerToggle.textContent = t.running ? 'Pause' : 'Fortsetzen';
  }
  setInterval(() => {
    if (activeBlockId) updateTimerBox();
  }, 1000);
  // periodic autosave while a timer is running, so an elapsed running
  // interval isn't lost if the tab is closed mid-block
  setInterval(() => {
    if (Object.values(State.timers).some(t => t.running)) saveState();
  }, 5000);

  /* ---------- Pause overlay (blocks interaction while paused) ---------- */
  let overlayEl = null;
  function removePauseOverlay() { if (overlayEl) { overlayEl.remove(); overlayEl = null; } }
  function showPauseOverlayIfNeeded() {
    removePauseOverlay();
    if (!activeBlockId || !isPaused(activeBlockId)) return;
    overlayEl = h('div', { className: 'pause-overlay' },
      h('h2', null, 'Pausiert'),
      h('p', { className: 'subtle' }, 'Der Timer für diesen Teil steht still. Deine Antworten bleiben erhalten.'),
      h('button', { className: 'btn btn-primary', onclick: () => { startTimer(activeBlockId); updateTimerBox(); renderApp(); } }, 'Fortsetzen')
    );
    document.body.appendChild(overlayEl);
  }

  /* ============================================================
     View: Exam list
     ============================================================ */
  function renderExamList() {
    const list = h('div', { className: 'col' },
      h('div', { className: 'eyebrow' }, 'Übungstests'),
      h('h1', { style: 'margin:6px 0 18px;' }, 'Welchen Test möchtest du üben?')
    );
    const cards = State.examList.map(entry => {
      const resumed = hasSavedAttempt(entry.id);
      return h('div', { className: 'card exam-card' },
        h('div', null,
          h('h2', null, entry.title),
          h('div', { className: 'subtle' }, entry.subtitle || '')
        ),
        h('button', {
          className: 'btn btn-primary',
          onclick: () => { location.hash = '#exam/' + entry.id; }
        }, resumed ? 'Fortsetzen' : 'Test starten')
      );
    });
    const wrap = h('div', { style: 'display:flex; flex-direction:column; gap:14px;' }, ...cards);
    if (!State.examList.length) {
      wrap.appendChild(h('div', { className: 'empty-state' }, 'Noch kein Übungstest hinterlegt.'));
    }
    mount(appEl, list, wrap);
  }

  /* ============================================================
     View: Block overview
     ============================================================ */
  function renderBlockOverview() {
    const exam = State.exam;
    const header = h('div', { className: 'section-head' },
      h('div', { className: 'eyebrow' }, exam.subtitle || 'Übungstest'),
      h('h1', null, exam.title),
      h('p', { className: 'subtle' }, 'Bearbeite die drei Prüfungsteile in beliebiger Reihenfolge. Der Timer pro Teil läuft als Stoppuhr – du kannst jederzeit pausieren.')
    );

    const cards = exam.blocks.map(block => {
      const sections = block.sections.map(findSection);
      const answered = sections.reduce((s, sec) => s + sectionAnsweredCount(sec), 0);
      const total = sections.reduce((s, sec) => s + sectionTotalCount(sec), 0);
      const writingSec = sections.find(s => s.type === 'writing');
      const pct = total ? Math.round((answered / total) * 100) : (writingSec ? (State.writing.text.trim() ? 100 : 0) : 0);
      const t = State.timers[block.id];
      const elapsedStr = t ? fmtClock(getElapsed(block.id)) : '00:00';

      return h('div', { className: 'block-card' },
        h('div', { className: 'num' }, block.title.split(' ')[0]),
        h('h3', null, block.title.replace(/^\d(\s\+\s\d)?\s/, '')),
        h('div', { className: 'subtle' }, 'Richtzeit: ' + block.officialTimeMinutes + ' Min.'),
        h('div', { className: 'progress-bar' }, h('span', { style: 'width:' + pct + '%' })),
        h('div', { className: 'subtle' }, writingSec ? (State.writing.text.trim() ? 'Text verfasst' : 'Noch nicht begonnen') : (answered + ' / ' + total + ' beantwortet')),
        h('div', { className: 'row', style: 'margin-top:4px;' },
          h('span', { className: 'subtle' }, '⏱ ' + elapsedStr),
          h('span', { className: 'spacer' })
        ),
        h('button', {
          className: 'btn btn-primary',
          onclick: () => { location.hash = '#exam/' + exam.id + '/' + block.id + '/' + block.sections[0]; }
        }, t && t.started ? 'Weiter' : 'Teil beginnen')
      );
    });

    const resultsBtn = h('button', {
      className: 'btn',
      onclick: () => { location.hash = '#exam/' + exam.id + '/results'; }
    }, 'Ergebnis ansehen');

    const resetRow = buildResetRow(exam.id);

    mount(appEl, header, h('div', { className: 'block-grid' }, ...cards),
      h('div', { className: 'row', style: 'margin-top:22px; justify-content:space-between;' }, resultsBtn, resetRow));
  }

  function buildResetRow(examId) {
    const container = h('div', { className: 'row' });
    const btn = h('button', { className: 'btn btn-sm btn-danger' }, 'Versuch zurücksetzen');
    btn.addEventListener('click', () => {
      clear(container);
      container.appendChild(h('span', { className: 'subtle' }, 'Wirklich alle Antworten löschen?'));
      container.appendChild(h('button', {
        className: 'btn btn-sm btn-danger',
        onclick: () => {
          try { localStorage.removeItem(storageKey(examId)); } catch (e) {}
          State.answers = {}; State.writing = { text: '', score: null, checklist: {} }; State.timers = {};
          // Always land on the overview so a fresh attempt starts from the top.
          const overview = '#exam/' + examId;
          if (location.hash !== overview) location.hash = overview; else renderApp();
        }
      }, 'Ja, zurücksetzen'));
      container.appendChild(h('button', { className: 'btn btn-sm', onclick: () => renderApp() }, 'Abbrechen'));
    });
    container.appendChild(btn);
    return container;
  }

  /* ============================================================
     View: Section (the main exercise screen)
     ============================================================ */
  function renderSection(block, section) {
    const exam = State.exam;
    const tabs = h('div', { className: 'tabs' });
    block.sections.map(findSection).forEach(sec => {
      const btn = h('button', {
        type: 'button',
        className: sec.id === section.id ? 'active' : '',
        onclick: () => { location.hash = '#exam/' + exam.id + '/' + block.id + '/' + sec.id; }
      },
        sec.title.replace(/^(Leseverstehen|Sprachbausteine|Hörverstehen)\s/, ''),
        sec.type !== 'writing' ? h('span', { className: 'count' }, ' ' + sectionAnsweredCount(sec) + '/' + sectionTotalCount(sec)) : null
      );
      tabs.appendChild(btn);
    });

    const head = h('div', { className: 'section-head' },
      h('div', { className: 'eyebrow' }, block.title),
      h('h2', null, section.title),
      section.instructions ? h('div', { className: 'instructions' }, section.instructions) : null
    );

    let body;
    switch (section.type) {
      case 'match': body = renderMatchSection(section); break;
      case 'mc': body = renderMcSection(section); break;
      case 'cloze-mc': body = renderClozeSection(section, 'mc'); break;
      case 'cloze-bank': body = renderClozeSection(section, 'bank'); break;
      case 'truefalse': body = renderTrueFalseSection(block, section); break;
      case 'writing': body = renderWritingSection(section); break;
      default: body = h('div', null, 'Unbekannter Abschnittstyp.');
    }

    // prev/next across the whole exam
    const flatSections = exam.blocks.flatMap(b => b.sections.map(id => ({ blockId: b.id, sectionId: id })));
    const idx = flatSections.findIndex(f => f.sectionId === section.id);
    const prev = idx > 0 ? flatSections[idx - 1] : null;
    const next = idx < flatSections.length - 1 ? flatSections[idx + 1] : null;
    const nav = h('div', { className: 'row', style: 'justify-content:space-between; margin-top:22px;' },
      prev ? h('button', { className: 'btn', onclick: () => { location.hash = '#exam/' + exam.id + '/' + prev.blockId + '/' + prev.sectionId; } }, '← Zurück') : h('span'),
      h('button', { className: 'btn', onclick: () => { location.hash = '#exam/' + exam.id; } }, 'Übersicht'),
      next ? h('button', { className: 'btn btn-primary', onclick: () => { location.hash = '#exam/' + exam.id + '/' + next.blockId + '/' + next.sectionId; } }, 'Weiter →') : h('button', { className: 'btn btn-primary', onclick: () => { location.hash = '#exam/' + exam.id + '/results'; } }, 'Zum Ergebnis →')
    );

    mount(appEl, tabs, head, body, nav);
    showPauseOverlayIfNeeded();
  }

  function updateTabBadges(block) {
    // cheap refresh of the "x/y" counters in the tab row without rebuilding it
    document.querySelectorAll('.tabs button').forEach((btn, i) => {
      const sec = findSection(block.sections[i]);
      if (!sec || sec.type === 'writing') return;
      const countEl = btn.querySelector('.count');
      if (countEl) countEl.textContent = ' ' + sectionAnsweredCount(sec) + '/' + sectionTotalCount(sec);
    });
  }

  /* ---------- match (Lesen 1 & 3) ---------- */
  function renderMatchSection(section) {
    const refList = h('div', { className: 'option-list' },
      ...section.options.map(o => h('div', { className: 'option-ref' }, h('span', { className: 'key' }, o.key), h('span', null, o.text)))
    );
    const refCol = h('div', { className: 'col sticky-col' },
      h('h3', { style: 'font-size:1rem; margin-bottom:10px;' }, section.optionLabel + 'n'),
      refList
    );

    const itemsCol = h('div', { className: 'col' });
    section.items.forEach(item => {
      const dupWarn = h('div', { className: 'dup-warn', hidden: true }, 'Diese Option ist schon vergeben.');
      const select = h('select', { className: 'answer-select' },
        h('option', { value: '' }, '— wählen —'),
        ...section.options.map(o => h('option', { value: o.key }, o.key + ' — ' + o.text.slice(0, 48) + (o.text.length > 48 ? '…' : ''))),
        section.allowX ? h('option', { value: 'x' }, 'x — keine passende ' + section.optionLabel) : null
      );
      select.value = State.answers[item.number] || '';
      select.addEventListener('change', () => {
        State.answers[item.number] = select.value || undefined;
        if (!select.value) delete State.answers[item.number];
        saveState();
        refreshDuplicates(itemsCol, section);
        updateTabBadges(blockOf(section.id));
      });
      const card = h('div', { className: 'item-card' },
        h('div', { className: 'q-head' }, h('span', { className: 'q-num' }, item.number)),
        h('div', { className: 'q-text', style: 'margin-bottom:10px;' }, item.text),
        select, dupWarn
      );
      itemsCol.appendChild(card);
    });
    refreshDuplicates(itemsCol, section);

    return h('div', { className: 'two-col' }, refCol, itemsCol);
  }

  function refreshDuplicates(itemsCol, section) {
    const selects = Array.from(itemsCol.querySelectorAll('select.answer-select'));
    const counts = {};
    selects.forEach(s => { if (s.value && s.value !== 'x') counts[s.value] = (counts[s.value] || 0) + 1; });
    selects.forEach(s => {
      const dup = s.value && s.value !== 'x' && counts[s.value] > 1;
      s.classList.toggle('duplicate', dup);
      const warn = s.parentElement.querySelector('.dup-warn');
      if (warn) warn.hidden = !dup;
    });
  }

  /* ---------- multiple choice (Lesen 2) ---------- */
  function renderMcSection(section) {
    const passage = section.passage;
    const passageCol = h('div', { className: 'col sticky-col card passage' },
      h('h3', { style: 'font-size:1.1rem; margin-bottom:4px;' }, passage.heading),
      h('p', { style: 'font-weight:600; color:var(--muted); font-size:0.88rem;' }, passage.subheading),
      ...passage.paragraphs.map(p => h('p', null, p))
    );
    const itemsCol = h('div', { className: 'col' });
    section.items.forEach(item => {
      const radios = h('div', { className: 'radio-row' });
      item.options.forEach(opt => {
        const input = h('input', { type: 'radio', name: 'q' + item.number, value: opt.key, checked: State.answers[item.number] === opt.key });
        const label = h('label', { className: 'radio-opt' + (State.answers[item.number] === opt.key ? ' selected' : '') }, input, h('span', null, opt.key + ')  ' + opt.text));
        input.addEventListener('change', () => {
          State.answers[item.number] = opt.key;
          saveState();
          radios.querySelectorAll('.radio-opt').forEach(l => l.classList.remove('selected'));
          label.classList.add('selected');
          updateTabBadges(blockOf(section.id));
        });
        radios.appendChild(label);
      });
      itemsCol.appendChild(h('div', { className: 'item-card' },
        h('div', { className: 'q-head' }, h('span', { className: 'q-num' }, item.number)),
        h('div', { className: 'q-text', style: 'margin-bottom:10px;' }, item.question),
        radios
      ));
    });
    return h('div', { className: 'two-col' }, passageCol, itemsCol);
  }

  /* ---------- cloze (Sprachbausteine 1 & 2) ---------- */
  function renderClozeSection(section, mode) {
    const textCol = h('div', { className: 'col sticky-col card' });
    const cloze = h('div', { className: 'cloze-text' });
    cloze.appendChild(document.createTextNode(section.textBefore + ' '));
    const chips = {};
    section.items.forEach(item => {
      const chip = h('span', { className: 'blank-chip empty' }, String(item.number));
      chips[item.number] = chip;
      cloze.appendChild(chip);
      cloze.appendChild(document.createTextNode(' ' + item.textAfter + ' '));
    });
    textCol.appendChild(h('h3', { style: 'font-size:1rem; margin-bottom:10px;' }, 'Text'));
    textCol.appendChild(cloze);
    if (mode === 'bank') {
      textCol.appendChild(h('h3', { style: 'font-size:0.95rem; margin:16px 0 6px;' }, 'Wortliste'));
      const bank = h('div', { className: 'word-bank' });
      section.wordBank.forEach(w => bank.appendChild(h('span', { className: 'word-chip', id: 'wb-' + section.id + '-' + w.key }, w.key + ') ' + w.text)));
      textCol.appendChild(bank);
    }

    function refreshChip(itemNumber) {
      const chip = chips[itemNumber];
      const val = State.answers[itemNumber];
      if (!val) { chip.className = 'blank-chip empty'; chip.textContent = String(itemNumber); return; }
      const opts = mode === 'mc' ? section.items.find(i => i.number === itemNumber).options : section.wordBank;
      chip.className = 'blank-chip';
      chip.textContent = optionText(opts, val);
    }
    function refreshWordBankUsage() {
      if (mode !== 'bank') return;
      const used = {};
      section.items.forEach(i => { const v = State.answers[i.number]; if (v) used[v] = true; });
      section.wordBank.forEach(w => {
        const el = document.getElementById('wb-' + section.id + '-' + w.key);
        if (el) el.classList.toggle('used', !!used[w.key]);
      });
    }

    const itemsCol = h('div', { className: 'col' });
    section.items.forEach(item => {
      let control;
      if (mode === 'mc') {
        const radios = h('div', { className: 'radio-row' });
        item.options.forEach(opt => {
          const input = h('input', { type: 'radio', name: 'c' + item.number, value: opt.key, checked: State.answers[item.number] === opt.key });
          const label = h('label', { className: 'radio-opt' + (State.answers[item.number] === opt.key ? ' selected' : '') }, input, h('span', null, opt.key + ')  ' + opt.text));
          input.addEventListener('change', () => {
            State.answers[item.number] = opt.key;
            saveState();
            radios.querySelectorAll('.radio-opt').forEach(l => l.classList.remove('selected'));
            label.classList.add('selected');
            refreshChip(item.number);
            updateTabBadges(blockOf(section.id));
          });
          radios.appendChild(label);
        });
        control = radios;
      } else {
        const dupWarn = h('div', { className: 'dup-warn', hidden: true }, 'Dieses Wort ist schon vergeben.');
        const select = h('select', { className: 'answer-select' },
          h('option', { value: '' }, '— wählen —'),
          ...section.wordBank.map(w => h('option', { value: w.key }, w.key + ') ' + w.text))
        );
        select.value = State.answers[item.number] || '';
        select.addEventListener('change', () => {
          if (select.value) State.answers[item.number] = select.value; else delete State.answers[item.number];
          saveState();
          refreshChip(item.number);
          refreshWordBankUsage();
          refreshDuplicates(itemsCol, section);
          updateTabBadges(blockOf(section.id));
        });
        control = h('div', null, select, dupWarn);
      }
      itemsCol.appendChild(h('div', { className: 'item-card' },
        h('div', { className: 'q-head' }, h('span', { className: 'q-num' }, item.number)),
        control
      ));
      refreshChip(item.number);
    });
    refreshWordBankUsage();
    if (mode === 'bank') refreshDuplicates(itemsCol, section);

    return h('div', { className: 'two-col' }, textCol, itemsCol);
  }

  /* ---------- listening (Hörverstehen 1–3) ---------- */
  function renderTrueFalseSection(block, section) {
    const col = h('div', { className: 'col', style: 'max-width:640px;' });

    const audioEl = h('audio', { controls: true, preload: 'metadata' });

    // Fixed audio from the exam JSON: section.audio = { src, start, end } (seconds).
    // Falls back to the manual file picker when a section has no audio configured.
    const fixed = section.audio && section.audio.src ? section.audio : null;
    let fileInput = null;
    let fileNote = null;
    if (fixed) {
      const start = fixed.start || 0;
      const end = fixed.end != null ? fixed.end : null;
      audioEl.src = 'exams/' + fixed.src;
      audioEl.addEventListener('loadedmetadata', () => {
        if (audioEl.currentTime < start) audioEl.currentTime = start;
      });
      audioEl.addEventListener('play', () => {
        if (audioEl.currentTime < start || (end != null && audioEl.currentTime >= end)) audioEl.currentTime = start;
      });
      if (end != null) {
        audioEl.addEventListener('timeupdate', () => {
          if (audioEl.currentTime >= end) { audioEl.pause(); audioEl.currentTime = end; }
        });
      }
    } else {
      if (AudioFiles[section.id]) audioEl.src = AudioFiles[section.id];
      fileInput = h('input', { type: 'file', accept: 'audio/*', id: 'audiofile-' + section.id });
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        if (!f) return;
        const url = URL.createObjectURL(f);
        AudioFiles[section.id] = url;
        audioEl.src = url;
        fileNote.textContent = f.name;
      });
      fileNote = h('span', { className: 'subtle' }, AudioFiles[section.id] ? 'Audiodatei geladen' : 'Noch keine Audiodatei ausgewählt');
    }

    let transcriptShown = false;
    const transcriptBox = h('div', { className: 'transcript', hidden: true });
    (section.transcripts || []).forEach(tr => {
      transcriptBox.appendChild(h('p', { style: 'margin:0 0 10px;' }, tr.number ? (tr.number + '  ') : '', tr.text));
    });
    const transcriptBtn = h('button', { className: 'btn btn-sm' }, 'Transkript anzeigen');
    transcriptBtn.addEventListener('click', () => {
      transcriptShown = !transcriptShown;
      transcriptBox.hidden = !transcriptShown;
      transcriptBtn.textContent = transcriptShown ? 'Transkript ausblenden' : 'Transkript anzeigen';
    });

    const audioBox = h('div', { className: 'card audio-box' },
      h('div', { className: 'subtle' }, section.audioLabel || 'Audio'),
      fixed ? null : h('div', { className: 'file-row' },
        h('label', { className: 'btn btn-sm', for: 'audiofile-' + section.id }, 'Audiodatei wählen'),
        fileNote
      ),
      audioEl,
      h('div', { className: 'row' }, transcriptBtn),
      transcriptBox
    );
    if (fileInput) {
      fileInput.style.display = 'none';
      audioBox.insertBefore(fileInput, audioBox.firstChild);
    }

    col.appendChild(audioBox);

    section.items.forEach(item => {
      const trueBtn = h('button', { type: 'button', className: 'pick-true' + (State.answers[item.number] === '+' ? ' selected' : '') }, 'richtig (+)');
      const falseBtn = h('button', { type: 'button', className: 'pick-false' + (State.answers[item.number] === '-' ? ' selected' : '') }, 'falsch (–)');
      const pick = (val, btnOn, btnOff) => {
        State.answers[item.number] = val;
        saveState();
        btnOn.classList.add('selected');
        btnOff.classList.remove('selected');
        updateTabBadges(block);
      };
      trueBtn.addEventListener('click', () => pick('+', trueBtn, falseBtn));
      falseBtn.addEventListener('click', () => pick('-', falseBtn, trueBtn));
      col.appendChild(h('div', { className: 'item-card' },
        h('div', { className: 'q-head' }, h('span', { className: 'q-num' }, item.number)),
        h('div', { className: 'q-text', style: 'margin-bottom:10px;' }, item.text),
        h('div', { className: 'seg' }, trueBtn, falseBtn)
      ));
    });

    return col;
  }

  /* ---------- writing ---------- */
  function renderWritingSection(section) {
    const col = h('div', { className: 'two-col' });

    const promptCol = h('div', { className: 'col sticky-col card' },
      h('h3', { style: 'font-size:1rem; margin-bottom:8px;' }, section.promptTitle || 'E-Mail von Marianne'),
      h('p', { style: 'white-space:pre-wrap;' }, section.prompt),
      h('h3', { style: 'font-size:0.95rem; margin:16px 0 6px;' }, 'Gehe auf alle vier Punkte ein'),
      h('ul', { className: 'leitpunkte' }, ...section.leitpunkte.map((lp, i) => {
        const cb = h('input', { type: 'checkbox', checked: !!State.writing.checklist[i] });
        cb.addEventListener('change', () => { State.writing.checklist[i] = cb.checked; saveState(); });
        return h('li', null, cb, h('span', null, lp));
      }))
    );

    const writeCol = h('div', { className: 'col' });
    const area = h('textarea', { className: 'writing-area', placeholder: 'Schreib deine Antwort hier…' });
    area.value = State.writing.text || '';
    const count = h('span', { className: 'word-count' }, String(wordCount(area.value)) + ' Wörter');
    let saveTimer = null;
    area.addEventListener('input', () => {
      State.writing.text = area.value;
      count.textContent = wordCount(area.value) + ' Wörter';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveState, 400);
    });

    function makeCopyButton(label, getText) {
      const btn = h('button', { className: 'btn btn-sm' }, label);
      btn.addEventListener('click', async () => {
        const ok = await copyText(getText());
        btn.textContent = ok ? 'Kopiert ✓' : 'Kopieren nicht möglich, markiere den Text manuell';
        setTimeout(() => { btn.textContent = label; }, 2200);
      });
      return btn;
    }
    const promptBtn = makeCopyButton('Bewertungs-Prompt kopieren', () => buildGradingPrompt(section, area.value));
    promptBtn.className = 'btn btn-sm btn-primary';
    const copyBtn = makeCopyButton('Nur Text kopieren', () => area.value);

    const scoreInput = h('input', { type: 'number', className: 'score-input', min: 0, max: section.maxPoints, step: 0.5 });
    scoreInput.value = State.writing.score != null ? State.writing.score : '';
    scoreInput.addEventListener('change', () => {
      const v = parseFloat(scoreInput.value);
      State.writing.score = isNaN(v) ? null : Math.max(0, Math.min(section.maxPoints, v));
      scoreInput.value = State.writing.score != null ? State.writing.score : '';
      saveState();
    });

    writeCol.appendChild(h('div', { className: 'row', style: 'justify-content:space-between; margin-bottom:8px;' },
      h('span', { className: 'subtle' }, 'Ziel: ca. ' + (section.targetWords || '100–150') + ' Wörter'), count));
    writeCol.appendChild(area);
    writeCol.appendChild(h('div', { className: 'row', style: 'margin-top:12px;' }, promptBtn, copyBtn));
    writeCol.appendChild(h('div', { className: 'card', style: 'margin-top:16px;' },
      h('div', { className: 'subtle', style: 'margin-bottom:8px;' }, '„Bewertungs-Prompt kopieren“ kopiert Aufgabe, telc-Bewertungskriterien und deinen Text in einem Stück. Füge ihn in einen beliebigen KI-Chat ein, auch ohne Vorwissen. Trag die Punktzahl danach hier ein:'),
      h('div', { className: 'row' },
        h('span', null, 'Schriftlicher Ausdruck:'),
        scoreInput,
        h('span', { className: 'subtle' }, '/ ' + section.maxPoints + ' Punkte')
      )
    ));

    col.appendChild(promptCol);
    col.appendChild(writeCol);
    return col;
  }
  function wordCount(str) { const t = str.trim(); return t ? t.split(/\s+/).length : 0; }

  // Self-contained grading prompt: works in any model with no prior context.
  function buildGradingPrompt(section, text) {
    const examTitle = State.exam ? State.exam.title : 'telc Deutsch B1';
    const leitpunkte = section.leitpunkte.map((lp, i) => (i + 1) + '. ' + lp).join('\n');
    const answer = text.trim() ? text.trim() : '(kein Text geschrieben)';
    return [
      'You are a certified telc examiner. Grade the following "Schriftlicher Ausdruck" from the ' + examTitle + ' (German, CEFR level B1) using the official telc rating scale below. Be strict and realistic, as in the real exam.',
      '',
      '## The task given to the candidate',
      section.instructions,
      '',
      'Email the candidate received:',
      '"""',
      section.prompt,
      '"""',
      '',
      'Leitpunkte (all four must be addressed):',
      leitpunkte,
      '',
      '## Official rating scale',
      'Three criteria, each graded A, B, C or D:',
      '- A = 5 points, B = 3 points, C = 1 point, D = 0 points.',
      '- Total = (sum of the three criteria) x 3, maximum 45 points.',
      '',
      'Kriterium I, Aufgabenbewältigung (task completion):',
      '- A: all four Leitpunkte handled appropriately. B: three handled. C: two handled. D: one or none.',
      '- A Leitpunkt counts as fulfilled if it is addressed sensibly and is understandable, even in a single short sentence, or combined with another Leitpunkt in one sentence.',
      '- If the text misses the topic entirely ("Thema verfehlt"), all three criteria get D. If it fits the topic but not the situation, only Kriterium I gets D.',
      '',
      'Kriterium II, Kommunikative Gestaltung (structure, cohesion, register):',
      '- Assesses text logic, connectors, register and range of vocabulary. Sender, date and subject line are NOT required.',
      '- A is NOT given if: email text-type features are missing (greeting, introduction, closing), the register is wrong or inconsistent, the Leitpunkte stand side by side without connection, or most sentences start with "Ich" or "Wir".',
      '- C or D: serious register errors that make central parts unclear, or missing/nonsensical connections.',
      '',
      'Kriterium III, Formale Richtigkeit (accuracy):',
      '- Comprehensibility comes first. Ending and gender errors weigh less than agreement errors.',
      '- A or B is possible if errors do not hinder quick understanding, depending on number and type of errors.',
      '- If Kriterium III is D, Kriterien I and II can still be A, B or C.',
      '',
      'Pass context: the whole written exam needs 135 of 225 points; this writing task is worth 45.',
      '',
      '## Candidate\'s text (' + wordCount(text) + ' words, target about ' + (section.targetWords || '100-150').replace('–', '-') + ')',
      '"""',
      answer,
      '"""',
      '',
      '## Answer in this format (explanations in English, corrections in German)',
      '1. A table: criterion, grade (A/B/C/D), points, one-line reason.',
      '2. Total: (sum) x 3 = X / 45.',
      '3. Which Leitpunkte were covered and which were missing or weak.',
      '4. A table of errors: what the candidate wrote, the corrected German, and the rule in a few words.',
      '5. The two or three changes that would raise the score most.',
      '6. A corrected model answer that keeps the candidate\'s ideas, at B1 level.'
    ].join('\n');
  }

  async function copyText(str) {
    try { await navigator.clipboard.writeText(str); return true; }
    catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = str; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        return true;
      } catch (e2) { return false; }
    }
  }

  /* ============================================================
     View: Results
     ============================================================ */
  function renderResults() {
    pauseAllTimers();
    const exam = State.exam;
    const obj = objectiveTotal();
    const written = writtenTotal();
    const pass = written >= exam.writtenPassPoints;
    const totalElapsed = exam.blocks.reduce((s, b) => s + getElapsed(b.id), 0);

    const kpis = h('div', { className: 'kpi-row' },
      h('div', { className: 'kpi' },
        h('div', { className: 'label' }, 'Objektive Punkte'),
        h('div', { className: 'value' }, fmtPoints(obj) + ' / ' + exam.objectiveMaxPoints),
        h('div', { className: 'sub' }, 'Lesen + Sprachbausteine + Hören')),
      h('div', { className: 'kpi' },
        h('div', { className: 'label' }, 'Schriftliche Prüfung gesamt'),
        h('div', { className: 'value' }, fmtPoints(written) + ' / ' + exam.writtenMaxPoints),
        h('div', { className: 'sub' },
          h('span', { className: 'badge ' + (pass ? 'pass' : 'fail') }, pass ? 'bestanden' : 'nicht bestanden'),
          ' · Grenze ' + exam.writtenPassPoints)),
      h('div', { className: 'kpi' },
        h('div', { className: 'label' }, 'Bearbeitungszeit gesamt'),
        h('div', { className: 'value' }, fmtClock(totalElapsed)),
        h('div', { className: 'sub' }, 'Summe der drei Teile'))
    );

    const rows = exam.sections.map(sec => {
      const max = sec.maxPoints;
      const score = sectionScore(sec);
      const pct = max ? Math.round((score / max) * 100) : 0;
      return h('tr', null,
        h('td', null, sec.title),
        h('td', { className: 'num' }, fmtPoints(score)),
        h('td', { className: 'num' }, max),
        h('td', { className: 'num' }, sec.type === 'writing' ? (State.writing.score == null ? '—' : pct + '%') : pct + '%')
      );
    });
    rows.push(h('tr', null, h('td', null, 'Gesamt (schriftlich)'), h('td', { className: 'num' }, fmtPoints(written)), h('td', { className: 'num' }, exam.writtenMaxPoints), h('td', { className: 'num' }, Math.round((written / exam.writtenMaxPoints) * 100) + '%')));

    const table = h('table', { className: 'score-table' },
      h('thead', null, h('tr', null, h('th', null, 'Teil'), h('th', { className: 'num' }, 'Punkte'), h('th', { className: 'num' }, 'Max.'), h('th', { className: 'num' }, '%'))),
      h('tbody', null, ...rows)
    );

    // answer review with per-item explanations
    const reviewToggleBtn = h('button', { className: 'btn btn-sm' }, 'Antworten & Erklärungen anzeigen');
    const reviewBox = h('div', { hidden: true, style: 'margin-top:14px;' });
    let reviewShown = false;
    let onlyWrong = false;
    reviewToggleBtn.addEventListener('click', () => {
      reviewShown = !reviewShown;
      reviewBox.hidden = !reviewShown;
      reviewToggleBtn.textContent = reviewShown ? 'Antworten & Erklärungen ausblenden' : 'Antworten & Erklärungen anzeigen';
      if (reviewShown) buildReview(reviewBox);
    });

    function buildReview(container) {
      clear(container);
      const filterBtn = h('button', { className: 'btn btn-sm', type: 'button' }, onlyWrong ? 'Alle Antworten zeigen' : 'Nur Fehler zeigen');
      filterBtn.addEventListener('click', () => { onlyWrong = !onlyWrong; buildReview(container); });
      container.appendChild(filterBtn);
      let shown = 0;
      exam.sections.filter(s => s.type !== 'writing').forEach(sec => {
        const list = onlyWrong ? sec.items.filter(it => !isItemCorrect(it)) : sec.items;
        if (!list.length) return;
        container.appendChild(h('h3', { style: 'font-size:0.95rem; margin:16px 0 8px;' }, sec.title));
        list.forEach(it => {
          shown++;
          const ok = isItemCorrect(it);
          const your = State.answers[it.number];
          const yourLabel = your == null ? '— keine Antwort —' : describeAnswer(sec, it, your);
          const correctLabel = describeAnswer(sec, it, it.correct);
          let explainRow = null;
          if (it.explanation) {
            const label = ok ? 'Warum ist das richtig?' : 'Warum?';
            const expl = h('div', { className: 'explanation', hidden: true }, it.explanation);
            const btn = h('button', { className: 'btn btn-sm', type: 'button' }, label);
            btn.addEventListener('click', () => {
              expl.hidden = !expl.hidden;
              btn.textContent = expl.hidden ? label : 'Erklärung ausblenden';
            });
            explainRow = h('div', { className: 'explain-row' }, btn, expl);
          }
          container.appendChild(h('div', { className: 'review-item ' + (ok ? 'is-ok' : 'is-wrong') },
            h('div', { className: 'rtext' }, it.number, '. ', it.text || it.question || 'Lücke'),
            h('div', { className: 'answers' },
              h('span', { className: ok ? 'correct' : 'you' }, (ok ? '✓ ' : '✗ ') + 'Deine Antwort: ' + yourLabel),
              ok ? null : h('span', { className: 'correct' }, 'Richtig: ' + correctLabel)
            ),
            explainRow
          ));
        });
      });
      if (!shown) container.appendChild(h('div', { className: 'subtle', style: 'margin-top:12px;' }, 'Keine Fehler in den automatisch auswertbaren Teilen — sehr gut!'));
    }

    const header = h('div', { className: 'section-head' },
      h('div', { className: 'eyebrow' }, exam.title),
      h('h1', null, 'Ergebnis')
    );
    const backBtn = h('button', { className: 'btn', onclick: () => { location.hash = '#exam/' + exam.id; } }, '← Zur Übersicht');

    mount(appEl, header, kpis, h('div', { className: 'card' }, table), h('div', { style: 'margin-top:16px;' }, reviewToggleBtn, reviewBox), h('div', { className: 'row', style: 'margin-top:22px; justify-content:space-between;' }, backBtn, buildResetRow(exam.id)));
  }

  function describeAnswer(section, item, key) {
    if (!key) return '—';
    if (section.type === 'truefalse') return key === '+' ? 'richtig (+)' : 'falsch (–)';
    if (section.type === 'match') return key === 'x' ? 'x (keine ' + section.optionLabel + ')' : key + ' — ' + optionText(section.options, key);
    if (section.type === 'mc') return key + ') ' + optionText(item.options, key);
    if (section.type === 'cloze-mc') return key + ') ' + optionText(item.options, key);
    if (section.type === 'cloze-bank') return key + ') ' + optionText(section.wordBank, key);
    return key;
  }

  /* ============================================================
     Boot
     ============================================================ */
  async function init() {
    try {
      const manifest = await fetchJSON('exams/manifest.json');
      State.examList = manifest.exams || [];
    } catch (e) {
      State.examList = [];
    }
    renderApp();
  }
  init();
})();
