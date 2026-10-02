/**
 * TransLens — content script: несколько выделенных зон, авто-обновление перевода, панели.
 * Внедряется по хоткею/клику по иконке/меню (activeTab).
 *
 * Зона = прямоугольник в координатах вьюпорта + видимая рамка с номером + своя панель.
 * Авто-режим периодически снимает вкладку, распознаёт текст и обновляет перевод, пока
 * текст в области меняется (видео/канвас Cloud Quest — основной сценарий).
 */
(() => {
  const KEY = '__cqtContentScript';
  if (window[KEY] && window[KEY].loaded) {
    try { window[KEY].restart(); } catch (e) { /* ignore */ }
    return;
  }

  const DEFAULT_OPTS = {
    sourceLanguage: 'en', targetLanguage: 'ru', ocrLang: 'eng', psm: '6',
    dim: true, upscale: 'auto', awsFix: true, autoWatch: true, watchInterval: 1200,
  };
  // Chrome разрешает не больше двух captureVisibleTab в секунду, а зон может быть несколько —
  // поэтому все захваты идут через одну очередь с зазором.
  const CAPTURE_GAP_MS = 550;
  // В авто-режиме рамка остаётся видимой: кроп берём на 3 px внутрь, чтобы не читать свою же рамку.
  const ZONE_INSET = 3;
  const TR_CACHE_MAX = 200;

  const STAGE_RU = {
    idle: 'воркер простаивает',
    capture: 'захват вкладки (captureVisibleTab)',
    offscreen: 'создание offscreen-документа',
    ocr: 'распознавание текста (tesseract)',
  };

  const state = {
    overlay: null, hint: null, chip: null, zones: [], start: null, opts: null,
    localPromise: null, localProgress: 0, busy: false, seq: 0, move: null,
    keysReady: false, trCache: new Map(),
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hasLocalTranslator = () => typeof globalThis.Translator !== 'undefined';
  const now = () => new Date().toLocaleTimeString('ru-RU');

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Таймаут обязателен: без него любая заминка в воркере/offscreen оставляет пользователя
  // с вечной плашкой «распознаю текст…» и без объяснений.
  function send(msg, timeoutMs) {
    const p = new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) resolve({ ok: false, reason: err.message });
          else resolve(res || { ok: false, reason: 'нет ответа' });
        });
      } catch (e) {
        resolve({ ok: false, reason: String(e && e.message || e) });
      }
    });
    if (!timeoutMs) return p;
    return Promise.race([p, new Promise((res) => setTimeout(
      () => res({ ok: false, timeout: true, reason: 'внутренний таймаут ' + Math.round(timeoutMs / 1000) + ' с' }),
      timeoutMs,
    ))]);
  }

  async function getOpts() {
    if (state.opts) return state.opts;
    const stored = await chrome.storage.local.get(DEFAULT_OPTS);
    state.opts = Object.assign({}, DEFAULT_OPTS, stored);
    return state.opts;
  }

  /* ------------------------------------------------------------------ очередь захватов */

  let capChain = Promise.resolve();
  let lastCapture = 0;

  function captureSlot() {
    const prev = capChain;
    let release;
    capChain = new Promise((r) => { release = r; });
    let done = false;
    const guard = setTimeout(() => { if (!done) { done = true; release(); } }, 20000);
    const rel = () => { if (!done) { done = true; clearTimeout(guard); release(); } };
    return prev.then(async () => {
      const wait = CAPTURE_GAP_MS - (performance.now() - lastCapture);
      if (wait > 0) await sleep(wait);
      lastCapture = performance.now();
      return rel;
    });
  }

  /* ------------------------------------------------------------------ перевод */

  function warmTranslator() {
    const o = state.opts;
    if (!o) return;
    if (hasLocalTranslator()) {
      if (!state.localPromise) {
        state.localPromise = globalThis.Translator.create({
          sourceLanguage: o.sourceLanguage,
          targetLanguage: o.targetLanguage,
          monitor: (m) => {
            m.addEventListener('downloadprogress', (e) => { state.localProgress = e.loaded; });
          },
        }).catch((e) => { state.localPromise = null; throw e; });
      }
    } else {
      send({
        type: 'page-translator', action: 'warm',
        sourceLanguage: o.sourceLanguage, targetLanguage: o.targetLanguage,
      });
    }
  }

  async function availabilityOf() {
    if (!hasLocalTranslator()) return null;
    try {
      return await globalThis.Translator.availability({
        sourceLanguage: state.opts.sourceLanguage,
        targetLanguage: state.opts.targetLanguage,
      });
    } catch (e) { return null; }
  }

  function progressNote() {
    const pct = state.localProgress ? Math.round(state.localProgress * 100) : null;
    return 'Языковой пакет ещё качается' + (pct ? ' (' + pct + '%)' : '') +
      '. Дождись и нажми «Обновить» — или скачай пакет заранее: настройки расширения → «Скачать модель».';
  }

  async function translate(text) {
    const o = state.opts;
    if (state.trCache.has(text)) return { ok: true, text: state.trCache.get(text), cached: true };
    const work = (async () => {
      if (hasLocalTranslator()) {
        if (!state.localPromise) {
          state.localPromise = globalThis.Translator.create({
            sourceLanguage: o.sourceLanguage, targetLanguage: o.targetLanguage,
          }).catch((e) => { state.localPromise = null; throw e; });
        }
        const t = await state.localPromise;
        return { ok: true, text: await t.translate(text) };
      }
      return await send({
        type: 'page-translator', action: 'translate', text,
        sourceLanguage: o.sourceLanguage, targetLanguage: o.targetLanguage,
      }, 25000);
    })();
    // Встроенная модель может ещё качаться: не держим UI две минуты, показываем, что делать.
    const timeout = new Promise((res) => setTimeout(() => res({ ok: false, reason: 'timeout', timeout: true }), 30000));
    const out = await Promise.race([work, timeout]);
    if (out && out.ok && out.text) {
      if (state.trCache.size >= TR_CACHE_MAX) state.trCache.clear();
      state.trCache.set(text, out.text);
    }
    return out;
  }

  async function translateZone(zone) {
    const text = zone.text;
    if (!text) return;
    const o = state.opts;
    const avail = await availabilityOf();
    if (avail === 'unavailable') {
      setDst(zone, '—', 'В этом Chrome нет модели для пары ' + o.sourceLanguage + ' → ' + o.targetLanguage + '.', 'err');
      return;
    }
    if (avail === 'downloadable' && !state.trCache.has(text)) {
      setDst(zone, '—', progressNote(), 'warn');
    } else if (!zone.trans) {
      setDst(zone, 'перевожу…', zone.info + ' · ' + o.sourceLanguage + ' → ' + o.targetLanguage);
    }
    const tr = await translate(text);
    if (tr && tr.ok && tr.text) {
      zone.trans = tr.text;
      setDst(zone, tr.text, zone.noteText());
      return;
    }
    if (tr && tr.timeout) { setDst(zone, '—', progressNote(), 'warn'); return; }
    if (tr && tr.noGesture) {
      setDst(zone, '—', 'Chrome требует жест для загрузки модели перевода. Выдели область ещё раз — на этот раз загрузка должна пройти.', 'warn');
      return;
    }
    const why = (tr && (tr.reason || tr.error)) || 'неизвестная ошибка';
    setDst(zone, text, 'Перевести не удалось: ' + why, 'err');
  }

  /* ------------------------------------------------------------------ зоны */

  function cropRect(zone, inset) {
    const r = zone.rect;
    if (!inset) return { x: r.x, y: r.y, w: r.w, h: r.h };
    return {
      x: r.x + inset, y: r.y + inset,
      w: Math.max(8, r.w - inset * 2), h: Math.max(8, r.h - inset * 2),
    };
  }

  function rectsOverlap(a, b) {
    return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  }

  // Наши панели/бейджи не должны попасть в снятие — иначе OCR прочитает собственный перевод.
  function hideOurDom(rect, target) {
    const box = { left: rect.x, top: rect.y, right: rect.x + rect.w, bottom: rect.y + rect.h };
    const nodes = [];
    for (const z of state.zones) {
      if (z === target) continue;
      if (z.panel) nodes.push(z.panel);
      if (z.badge) nodes.push(z.badge);
    }
    const hidden = [];
    for (const n of nodes) {
      const b = n.getBoundingClientRect();
      if (rectsOverlap(box, b)) { n.style.visibility = 'hidden'; hidden.push(n); }
    }
    return hidden;
  }

  async function paint() {
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      sleep(70),
    ]);
    await sleep(30);
  }

  // mode: 'first' (точный кроп, рамка скрыта) | 'auto' | 'manual'
  async function captureZone(zone, mode) {
    const first = mode === 'first';
    if (first && zone.box) zone.box.style.display = 'none';
    let hidden = [];
    let rel = null;
    try {
      await paint();
      rel = await captureSlot();
      const rect = cropRect(zone, first ? 0 : ZONE_INSET);
      hidden = hideOurDom(cropRect(zone, 0), zone);
      if (hidden.length) await paint();
      return await send({
        type: 'capture-ocr',
        rect, viewport: { w: window.innerWidth, h: window.innerHeight },
        lang: state.opts.ocrLang, psm: state.opts.psm, upscale: state.opts.upscale, awsFix: state.opts.awsFix,
      }, 45000);
    } finally {
      for (const n of hidden) n.style.visibility = '';
      if (rel) rel();
      if (zone.box) zone.box.style.display = '';
    }
  }

  function noteFor(zone) {
    const base = zone.info + ' · ' + state.opts.sourceLanguage + ' → ' + state.opts.targetLanguage;
    if (!zone.watching) return base + ' · встроенный переводчик Chrome, офлайн';
    return 'авто · ' + (zone.autoNote || 'слежу за областью') + ' · ' + base;
  }

  async function runZone(zone, mode) {
    if (zone.busy) return false;
    zone.busy = true;
    try {
      const res = await captureZone(zone, mode);
      if (!res || !res.ok) {
        let text = (res && (res.error || res.reason)) || 'не удалось распознать';
        if (res && res.timeout) {
          const st = await send({ type: 'debug-state' }, 3000);
          const where = (st && st.ok && STAGE_RU[st.stage]) || (st && st.stage) || 'неизвестно';
          text = 'Расширение не ответило: ' + text + '. Застряло на этапе: ' + where +
            (st && st.stuckMs ? ' (' + Math.round(st.stuckMs / 1000) + ' с)' : '') +
            (st && st.error ? '. Ошибка: ' + st.error : '');
        }
        if (mode === 'auto') { zone.fails = (zone.fails || 0) + 1; zone.autoNote = 'нет захвата (' + text.slice(0, 80) + ')'; setDst(zone, zone.trans || '—', noteFor(zone), 'warn'); }
        else setDst(zone, '—', text, 'err');
        return false;
      }
      if (!res.text) {
        if (mode === 'auto') { zone.unchanged++; zone.autoNote = 'в кадре нет текста'; setDst(zone, zone.trans || '—', noteFor(zone), 'warn'); }
        else setDst(zone, '—', 'OCR не нашёл текста в этой области. Попробуй захватить пошире или ровнее по строке.', 'warn');
        return false;
      }

      const meta = res.meta || {};
      const changed = res.text !== zone.text;
      zone.text = res.text;
      zone.fails = 0;
      zone.info = 'OCR ' + Math.round(res.confidence || 0) + '%' + (meta.ms ? ' · ' + meta.ms + ' мс' : '') + (meta.invert ? ' · инверсия' : '');
      if (changed) {
        zone.unchanged = 0;
        zone.autoNote = 'обновлено в ' + now();
        setSrc(zone, res.text);
        pulse(zone);
      } else {
        zone.unchanged++;
        if (zone.autoNote !== 'ждём изменений') zone.autoNote = 'ждём изменений';
      }

      if (mode === 'auto' && !changed && zone.trans) {
        // Текст тот же — перевод не трогаем, только тихо отмечаем, что цикл прошёл.
        setNote(zone, noteFor(zone));
        return true;
      }
      await translateZone(zone);
      return true;
    } finally {
      zone.busy = false;
    }
  }

  /* ------------------------------------------------------------------ авто-режим */

  function startWatch(zone) {
    stopWatch(zone);
    zone.watching = true;
    zone.unchanged = 0;
    zone.autoNote = 'слежу за областью';
    renderZone(zone);
    loop();
    async function loop() {
      if (!zone.watching) return;
      let wait;
      if (state.overlay || state.move) {
        // идёт выделение или перенос зоны: снятие захватило бы затемняющий оверлей
        wait = 500;
      } else if (document.visibilityState !== 'visible') {
        // вкладка в фоне: captureVisibleTab снял бы чужую вкладку — просто ждём
        zone.autoNote = 'вкладка неактивна — пауза';
        setNote(zone, noteFor(zone));
        wait = 700;
      } else {
        const t0 = performance.now();
        await runZone(zone, 'auto').catch(() => {});
        const base = Number(state.opts.watchInterval) || DEFAULT_OPTS.watchInterval;
        // если картинка давно не меняется (видео на паузе) — опрашиваем реже
        const slow = zone.unchanged > 8 ? 3 : 1;
        wait = Math.max(300, base * slow - (performance.now() - t0));
      }
      if (zone.watching) zone.timer = setTimeout(loop, wait);
    }
  }

  function stopWatch(zone) {
    zone.watching = false;
    if (zone.timer) { clearTimeout(zone.timer); zone.timer = null; }
    renderZone(zone);
  }

  /* ------------------------------------------------------------------ DOM зоны */

  function pulse(zone) {
    if (!zone.panel) return;
    zone.panel.classList.remove('cqt-flash');
    void zone.panel.offsetWidth;
    zone.panel.classList.add('cqt-flash');
    setTimeout(() => { if (zone.panel) zone.panel.classList.remove('cqt-flash'); }, 700);
  }

  function renderZone(zone) {
    if (zone.box) {
      zone.box.classList.toggle('cqt-auto', !!zone.watching);
      zone.box.style.display = '';
    }
    if (zone.badge) {
      zone.badge.textContent = zone.watching ? 'Зона ' + zone.n + ' · авто' : 'Зона ' + zone.n;
      zone.badge.classList.toggle('cqt-on', !!zone.watching);
    }
    if (zone.panel) {
      const t = zone.panel.querySelector('.cqt-title');
      if (t) t.textContent = 'Зона ' + zone.n + (zone.watching ? ' · авто' : '');
      const w = zone.panel.querySelector('.cqt-watch');
      if (w) { w.textContent = zone.watching ? 'Пауза' : 'Следить'; w.classList.toggle('cqt-on', !!zone.watching); }
      placePanel(zone);
    }
  }

  function setSrc(zone, text) {
    if (!zone.panel) return;
    const s = zone.panel.querySelector('.cqt-src');
    if (s) s.textContent = text;
  }

  function setDst(zone, text, note, noteKind) {
    if (!zone.panel) return;
    const d = zone.panel.querySelector('.cqt-dst');
    if (d) d.textContent = text;
    setNote(zone, note, noteKind);
  }

  function setNote(zone, note, noteKind) {
    if (!zone.panel) return;
    const old = zone.panel.querySelector('.cqt-note');
    if (!note) { if (old) old.remove(); return; }
    if (old) { old.textContent = note; old.className = 'cqt-note' + (noteKind ? ' cqt-' + noteKind : ''); }
    else zone.panel.appendChild(el('div', 'cqt-note' + (noteKind ? ' cqt-' + noteKind : ''), note));
  }

  // Панель не должна закрывать свою же область и чужие панели: перебираем позиции и берём
  // ту, где меньше всего пересечений.
  function placePanel(zone) {
    const panel = zone.panel;
    if (!panel) return;
    const r = zone.rect;
    const pw = panel.offsetWidth || 320;
    const ph = panel.offsetHeight || 120;
    const gap = 10;
    const others = [];
    for (const z of state.zones) {
      if (z === zone) continue;
      others.push({ left: z.rect.x, top: z.rect.y, right: z.rect.x + z.rect.w, bottom: z.rect.y + z.rect.h });
      if (z.panel) { const b = z.panel.getBoundingClientRect(); others.push(b); }
    }
    const cands = [
      { left: r.x + r.w + gap, top: r.y },
      { left: r.x, top: r.y + r.h + gap },
      { left: r.x, top: r.y - ph - gap },
      { left: r.x - pw - gap, top: r.y },
      { left: r.x, top: r.y },
    ];
    let best = null;
    let bestScore = Infinity;
    for (const c of cands) {
      const left = Math.max(6, Math.min(window.innerWidth - pw - 6, c.left));
      const top = Math.max(6, Math.min(window.innerHeight - ph - 6, c.top));
      const box = { left, top, right: left + pw, bottom: top + ph };
      let score = 0;
      for (const o of others) if (rectsOverlap(box, o)) score += 3;
      // штраф за перекрытие собственной области — она важнее всего
      if (rectsOverlap(box, { left: r.x, top: r.y, right: r.x + r.w, bottom: r.y + r.h })) score += 10;
      if (score < bestScore) { bestScore = score; best = { left, top }; }
      if (score === 0) break;
    }
    panel.style.left = best.left + 'px';
    panel.style.top = best.top + 'px';
  }

  function makePanel(zone) {
    const panel = el('div', 'cqt-panel');
    panel.dataset.cqtZone = zone.id;
    const head = el('div', 'cqt-head');
    head.appendChild(el('div', 'cqt-title', 'Зона ' + zone.n));

    const watchBtn = el('button', 'cqt-btn cqt-watch', 'Следить');
    watchBtn.addEventListener('click', () => {
      if (zone.watching) stopWatch(zone); else startWatch(zone);
    });
    const refreshBtn = el('button', 'cqt-btn', 'Обновить');
    refreshBtn.addEventListener('click', () => { runZone(zone, 'manual'); });
    const copyBtn = el('button', 'cqt-btn', 'Копировать');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(zone.trans || zone.text || '');
        copyBtn.textContent = 'Скопировано';
        setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1200);
      } catch (e) { copyBtn.textContent = 'Не вышло'; }
    });
    const addBtn = el('button', 'cqt-btn cqt-add', '+ область');
    addBtn.title = 'Выделить ещё одну область';
    addBtn.addEventListener('click', () => { startSelection(); });
    const closeBtn = el('button', 'cqt-btn', '×');
    closeBtn.title = 'Убрать эту зону';
    closeBtn.addEventListener('click', () => { removeZone(zone); });

    head.appendChild(watchBtn);
    head.appendChild(refreshBtn);
    head.appendChild(copyBtn);
    head.appendChild(addBtn);
    head.appendChild(closeBtn);
    panel.appendChild(head);

    panel.appendChild(el('div', 'cqt-src', zone.text || ''));
    panel.appendChild(el('div', 'cqt-dst', zone.trans || '…'));
    panel.style.visibility = 'hidden';
    document.documentElement.appendChild(panel);
    zone.panel = panel;
    placePanel(zone);
    panel.style.visibility = 'visible';
    return panel;
  }

  function makeZone(rect) {
    // нумерация начинается заново, когда все зоны убраны
    if (!state.zones.length) state.seq = 0;
    const zone = {
      id: 'z' + (++state.seq), n: state.seq, rect: Object.assign({}, rect),
      text: '', trans: '', info: '', note: '', autoNote: '', watching: false, timer: null,
      unchanged: 0, fails: 0, busy: false, box: null, badge: null, panel: null,
    };
    zone.noteText = () => noteFor(zone);

    const box = el('div', 'cqt-box cqt-captured');
    box.dataset.cqtZone = zone.id;
    const badge = el('div', 'cqt-badge', 'Зона ' + zone.n);
    badge.dataset.cqtZone = zone.id;
    badge.title = 'Потяни, чтобы подвинуть область';
    document.documentElement.appendChild(box);
    document.documentElement.appendChild(badge);
    zone.box = box;
    zone.badge = badge;

    badge.addEventListener('mousedown', (e) => beginMove(zone, e));
    state.zones.push(zone);
    placeFrame(zone);
    return zone;
  }

  function placeFrame(zone) {
    const r = zone.rect;
    const b = zone.box;
    b.style.left = r.x + 'px';
    b.style.top = r.y + 'px';
    b.style.width = r.w + 'px';
    b.style.height = r.h + 'px';
    const bd = zone.badge;
    let top = r.y - 20;
    if (top < 2) top = Math.min(window.innerHeight - 20, r.y + r.h + 2);
    bd.style.top = top + 'px';
    bd.style.left = Math.max(2, Math.min(window.innerWidth - 70, r.x)) + 'px';
  }

  function beginMove(zone, e) {
    e.preventDefault();
    e.stopPropagation();
    stopWatch(zone);
    const start = { x: e.clientX, y: e.clientY, rect: Object.assign({}, zone.rect) };
    state.move = { zone };
    const onMove = (ev) => {
      zone.rect = {
        x: Math.max(0, start.rect.x + (ev.clientX - start.x)),
        y: Math.max(0, start.rect.y + (ev.clientY - start.y)),
        w: start.rect.w, h: start.rect.h,
      };
      placeFrame(zone);
      placePanel(zone);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('mouseup', onUp, true);
      state.move = null;
      runZone(zone, 'manual');
    };
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('mouseup', onUp, true);
  }

  function removeZone(zone) {
    stopWatch(zone);
    if (zone.box) zone.box.remove();
    if (zone.badge) zone.badge.remove();
    if (zone.panel) zone.panel.remove();
    state.zones = state.zones.filter((z) => z !== zone);
  }

  function ensureKeys() {
    if (state.keysReady) return;
    state.keysReady = true;
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (state.start || state.move) return; // идёт выделение или перенос — там свой обработчик
      const last = state.zones[state.zones.length - 1];
      if (last) { e.preventDefault(); removeZone(last); }
    }, true);
  }

  /* ------------------------------------------------------------------ выделение */

  function startSelection() {
    getOpts().then((o) => {
      if (state.overlay) { state.overlay.remove(); state.overlay = null; }
      if (state.hint) { state.hint.remove(); state.hint = null; }

      const overlay = el('div', 'cqt-overlay' + (o.dim ? ' cqt-dim' : ''));
      document.documentElement.appendChild(overlay);
      state.overlay = overlay;

      const hint = el('div', 'cqt-hint',
        state.zones.length ? 'Новая область · зон уже: ' + state.zones.length + ' · Esc — отмена'
          : 'Тяни рамку мышью · Esc — отмена');
      document.documentElement.appendChild(hint);
      state.hint = hint;

      const box = el('div', 'cqt-box');
      document.documentElement.appendChild(box);

      let started = false;

      const onDown = (e) => {
        if (e.button !== 0) { detach(); cancel(); return; }
        started = true;
        state.start = { x: e.clientX, y: e.clientY };
        box.style.display = '';
        box.style.left = e.clientX + 'px';
        box.style.top = e.clientY + 'px';
        box.style.width = '0px';
        box.style.height = '0px';
        e.preventDefault();
      };

      const onMove = (e) => {
        if (!started || !state.start) return;
        const x = Math.min(e.clientX, state.start.x);
        const y = Math.min(e.clientY, state.start.y);
        box.style.left = x + 'px';
        box.style.top = y + 'px';
        box.style.width = Math.abs(e.clientX - state.start.x) + 'px';
        box.style.height = Math.abs(e.clientY - state.start.y) + 'px';
      };

      const onUp = (e) => {
        if (!started || !state.start) return;
        const x = Math.min(e.clientX, state.start.x);
        const y = Math.min(e.clientY, state.start.y);
        const w = Math.abs(e.clientX - state.start.x);
        const h = Math.abs(e.clientY - state.start.y);
        detach();
        box.remove();
        state.start = null; // выделение закончилось: Esc снова убирает последнюю зону
        if (w < 6 || h < 6) { cancel(); return; }
        addZone({ x, y, w, h });
      };

      const onKey = (e) => { if (e.key === 'Escape') { detach(); state.start = null; cancel(); } };
      const onCtx = (e) => { e.preventDefault(); detach(); cancel(); };

      function detach() {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('contextmenu', onCtx, true);
        overlay.removeEventListener('mousedown', onDown, true);
      }

      function cancel() {
        if (state.overlay) { state.overlay.remove(); state.overlay = null; }
        if (state.hint) { state.hint.remove(); state.hint = null; }
        box.remove();
        state.start = null;
      }

      overlay.addEventListener('mousedown', onDown, true);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('contextmenu', onCtx, true);
    });
  }

  // Если панель почему-то не создать, пользователь всё равно должен увидеть причину.
  function fatalPanel(rect, msg) {
    const panel = el('div', 'cqt-panel');
    const head = el('div', 'cqt-head');
    head.appendChild(el('div', 'cqt-title', 'Перевод области'));
    panel.appendChild(head);
    panel.appendChild(el('div', 'cqt-dst', '—'));
    panel.appendChild(el('div', 'cqt-note cqt-err', 'Ошибка расширения: ' + msg));
    document.documentElement.appendChild(panel);
    panel.style.left = Math.max(6, rect.x) + 'px';
    panel.style.top = Math.max(6, rect.y + rect.h + 10) + 'px';
    return panel;
  }

  async function addZone(rect) {
    let zone = null;
    try {
      ensureKeys();
      await getOpts();
      // Жест мыши ещё «горячий» — стартуем создание переводчика прямо сейчас.
      warmTranslator();

      if (state.overlay) { state.overlay.remove(); state.overlay = null; }
      if (state.hint) { state.hint.remove(); state.hint = null; }

      zone = makeZone(rect);
      makePanel(zone); // панель нужна ДО снятия: в неё прилетит результат OCR
      setChip(rect, 'распознаю текст…');
      await runZone(zone, 'first');
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (zone) setDst(zone, '—', 'Ошибка расширения: ' + msg, 'err');
      else fatalPanel(rect, msg);
    }
    clearChip();
    if (!zone) return;
    if (state.opts && state.opts.autoWatch) startWatch(zone);
    else { zone.autoNote = 'авто выключено'; setNote(zone, noteFor(zone)); }
  }

  /* ------------------------------------------------------------------ плашка прогресса */

  function setChip(rect, text) {
    if (!state.chip) {
      state.chip = el('div', 'cqt-chip');
      document.documentElement.appendChild(state.chip);
    }
    // Плашка ставится ВНЕ области: снятие идёт с включённым DOM.
    const gap = 16;
    const below = rect.y + rect.h + gap;
    const above = rect.y - 26 - gap;
    let top = null;
    if (below + 22 < window.innerHeight) top = below;
    else if (above > 4) top = above;
    if (top == null) { clearChip(); return; }
    state.chip.textContent = text;
    state.chip.style.top = top + 'px';
    state.chip.style.left = Math.min(window.innerWidth - 190, Math.max(4, rect.x)) + 'px';
  }

  function clearChip() {
    if (state.chip) { state.chip.remove(); state.chip = null; }
  }

  window[KEY] = { loaded: true, restart: startSelection };
  startSelection();
})();