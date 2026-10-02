/**
 * TransLens — content script: оверлей выделения области + панель перевода.
 * Внедряется по хоткею/клику по иконке/меню (activeTab).
 */
(() => {
  const KEY = '__cqtContentScript';
  if (window[KEY] && window[KEY].loaded) {
    try { window[KEY].restart(); } catch (e) { /* ignore */ }
    return;
  }

  const DEFAULT_OPTS = { sourceLanguage: 'en', targetLanguage: 'ru', ocrLang: 'eng', psm: '6', dim: true, upscale: 'auto', awsFix: true };
  const state = {
    overlay: null, box: null, hint: null, chip: null, panel: null,
    start: null, opts: null, localPromise: null, localKey: null, localProgress: 0, busy: false,
  };

  const hasLocalTranslator = () => typeof globalThis.Translator !== 'undefined';

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // Таймаут обязателен: без него любая заминка в воркере/offscreen оставляет пользователя
  // с вечной плашкой «распознаю текст…» и без объяснений.
  const STAGE_RU = {
    idle: 'воркер простаивает',
    capture: 'захват вкладки (captureVisibleTab)',
    offscreen: 'создание offscreen-документа',
    ocr: 'распознавание текста (tesseract)',
  };

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

  function cleanup(keepPanel) {
    if (state.overlay) { state.overlay.remove(); state.overlay = null; }
    if (state.hint) { state.hint.remove(); state.hint = null; }
    if (state.chip) { state.chip.remove(); state.chip = null; }
    if (state.box && !keepPanel) { state.box.remove(); state.box = null; }
    state.start = null;
    state.busy = false;
  }

  function closePanel() {
    if (state.panel) { state.panel.remove(); state.panel = null; }
    if (state.box) { state.box.remove(); state.box = null; }
  }

  function setChip(text) {
    if (!state.chip) {
      state.chip = el('div', 'cqt-chip');
      document.documentElement.appendChild(state.chip);
    }
    state.chip.textContent = text;
  }

  // Плашка прогресса ставится ВНЕ выделенной области: снятие вкладки идёт с включённым DOM,
  // а в кроп попадает только прямоугольник выделения (плюс пара пикселей запаса).
  function placeChipOutside(rect, text) {
    const gap = 16;
    const below = rect.y + rect.h + gap;
    const above = rect.y - 26 - gap;
    let top = null;
    if (below + 22 < window.innerHeight) top = below;
    else if (above > 4) top = above;
    if (top == null) return; // область во весь экран — лучше промолчать, чем испортить снятие
    setChip(text);
    state.chip.style.top = top + 'px';
    state.chip.style.left = Math.min(window.innerWidth - 190, Math.max(4, rect.x)) + 'px';
  }

  function showPanel(rect, srcText, dstText, note, noteKind) {
    closePanel();
    const panel = el('div', 'cqt-panel');
    const head = el('div', 'cqt-head');
    head.appendChild(el('div', 'cqt-title', 'Перевод области'));
    const copyBtn = el('button', 'cqt-btn', 'Копировать');
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(dstText || srcText || '');
        copyBtn.textContent = 'Скопировано';
        setTimeout(() => { copyBtn.textContent = 'Копировать'; }, 1200);
      } catch (e) { copyBtn.textContent = 'Не вышло'; }
    });
    if (srcText) {
      const retryBtn = el('button', 'cqt-btn', 'Обновить перевод');
      retryBtn.addEventListener('click', () => { runTranslation(); });
      head.appendChild(retryBtn);
    }
    const closeBtn = el('button', 'cqt-btn', 'Закрыть');
    closeBtn.addEventListener('click', closePanel);
    head.appendChild(copyBtn);
    head.appendChild(closeBtn);
    panel.appendChild(head);
    if (srcText) panel.appendChild(el('div', 'cqt-src', srcText));
    panel.appendChild(el('div', 'cqt-dst', dstText || '…'));
    if (note) panel.appendChild(el('div', 'cqt-note' + (noteKind ? ' cqt-' + noteKind : ''), note));

    panel.style.visibility = 'hidden';
    document.documentElement.appendChild(panel);
    const ph = panel.getBoundingClientRect().height;
    const pw = panel.getBoundingClientRect().width;
    let top = rect.bottom + 10;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, rect.top - ph - 10);
    let left = rect.left;
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8);
    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
    panel.style.visibility = 'visible';
    state.panel = panel;
    return { panel };
  }

  function updateDst(text, note, noteKind) {
    if (!state.panel) return;
    const dst = state.panel.querySelector('.cqt-dst');
    if (dst) dst.textContent = text;
    const old = state.panel.querySelector('.cqt-note');
    if (note) {
      if (old) { old.textContent = note; old.className = 'cqt-note' + (noteKind ? ' cqt-' + noteKind : ''); }
      else state.panel.appendChild(el('div', 'cqt-note' + (noteKind ? ' cqt-' + noteKind : ''), note));
    } else if (old) old.remove();
  }

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
      '. Дождись и нажми «Обновить перевод» — или скачай пакет заранее: настройки расширения → «Скачать модель».';
  }

  // Единственное место, где текст уходит в перевод: панель сначала показывает оригинал,
  // потом сюда приходит результат (в том числе по кнопке «Обновить перевод»).
  async function runTranslation() {
    const text = state.retryText;
    if (!text) return;
    const o = state.opts;
    const info = state.retryInfo || '';
    const avail = await availabilityOf();

    if (avail === 'unavailable') {
      updateDst('—', 'В этом Chrome нет модели для пары ' + o.sourceLanguage + ' → ' + o.targetLanguage + '.', 'err');
      return;
    }
    if (avail === 'downloadable') {
      updateDst('—', progressNote(), 'warn');
    } else {
      updateDst('перевожу…', info + ' · ' + o.sourceLanguage + ' → ' + o.targetLanguage);
    }

    const tr = await translate(text);
    if (tr && tr.ok && tr.text) {
      updateDst(tr.text, info + ' · ' + o.sourceLanguage + ' → ' + o.targetLanguage + ' · встроенный переводчик Chrome, офлайн');
      return;
    }
    const why = (tr && (tr.reason || tr.error)) || 'неизвестная ошибка';
    if (tr && tr.timeout) { updateDst('—', progressNote(), 'warn'); return; }
    if (tr && tr.noGesture) {
      updateDst('—', 'Chrome требует жест для загрузки модели перевода. Выдели область ещё раз — на этот раз загрузка должна пройти.', 'warn');
      return;
    }
    updateDst(text, 'Перевести не удалось: ' + why, 'err');
  }

  async function translate(text) {
    const o = state.opts;
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
      });
    })();
    // Встроенная модель может ещё качаться: не держим UI две минуты, показываем, что делать.
    const timeout = new Promise((res) => setTimeout(() => res({ ok: false, reason: 'timeout', timeout: true }), 30000));
    return Promise.race([work, timeout]);
  }

  async function finishSelection(rect) {
    state.busy = true;
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    if (state.hint) state.hint.remove();
    state.hint = null;

    // Жест мыши ещё «горячий» — стартуем создание переводчика прямо сейчас.
    warmTranslator();

    // Прячем оверлей: captureVisibleTab снимает страницу вместе с нашим DOM.
    if (state.overlay) state.overlay.style.display = 'none';
    if (state.box) state.box.style.display = 'none';
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 60));
    placeChipOutside(rect, 'распознаю текст…');

    const res = await send({
      type: 'capture-ocr',
      rect, viewport,
      lang: state.opts.ocrLang, psm: state.opts.psm, upscale: state.opts.upscale, awsFix: state.opts.awsFix,
    }, 45000);

    cleanup(true);
    if (state.box) {
      state.box.classList.add('cqt-captured');
      state.box.style.display = '';
      state.box.style.width = rect.w + 'px';
      state.box.style.height = rect.h + 'px';
      state.box.style.left = rect.x + 'px';
      state.box.style.top = rect.y + 'px';
    }

    if (!res || !res.ok) {
      let text = (res && (res.error || res.reason)) || 'не удалось распознать';
      if (res && res.timeout) {
        // Спрашиваем воркер, где он застрял: он отвечает даже во время ожидания.
        const st = await send({ type: 'debug-state' }, 3000);
        const where = (st && st.ok && STAGE_RU[st.stage]) || (st && st.stage) || 'неизвестно';
        text = 'Расширение не ответило: ' + text + '. Застряло на этапе: ' + where +
          (st && st.stuckMs ? ' (' + Math.round(st.stuckMs / 1000) + ' с)' : '') +
          (st && st.error ? '. Ошибка: ' + st.error : '') +
          '. Скажи мне этот текст — по нему видно причину.';
      }
      showPanel(rect, '', '—', text, 'err');
      return;
    }
    if (!res.text) {
      showPanel(rect, '', '—', 'OCR не нашёл текста в этой области. Попробуй захватить пошире или ровнее по строке.', 'warn');
      return;
    }

    if (state.chip) { state.chip.remove(); state.chip = null; }
    const srcText = res.text;
    const meta = res.meta || {};
    state.retryText = srcText;
    state.retryInfo = 'OCR ' + Math.round(res.confidence || 0) + '%' +
      (meta.ms ? ' · ' + meta.ms + ' мс' : '') + (meta.invert ? ' · инверсия' : '');
    showPanel(rect, srcText, 'перевожу…', state.retryInfo + ' · ' + state.opts.sourceLanguage + ' → ' + state.opts.targetLanguage);
    runTranslation();
  }

  function startSelection() {
    closePanel();
    cleanup();
    getOpts().then((o) => {
      const overlay = el('div', 'cqt-overlay' + (o.dim ? ' cqt-dim' : ''));
      document.documentElement.appendChild(overlay);
      state.overlay = overlay;

      const hint = el('div', 'cqt-hint', 'Тяни рамку мышью · Esc — отмена');
      document.documentElement.appendChild(hint);
      state.hint = hint;

      let started = false;

      const onDown = (e) => {
        if (e.button !== 0) { cancel(); return; }
        started = true;
        state.start = { x: e.clientX, y: e.clientY };
        if (!state.box) {
          state.box = el('div', 'cqt-box');
          document.documentElement.appendChild(state.box);
        }
        state.box.style.display = '';
        state.box.classList.remove('cqt-captured');
        state.box.style.left = e.clientX + 'px';
        state.box.style.top = e.clientY + 'px';
        state.box.style.width = '0px';
        state.box.style.height = '0px';
        e.preventDefault();
      };

      const onMove = (e) => {
        if (!started || !state.start) return;
        const x = Math.min(e.clientX, state.start.x);
        const y = Math.min(e.clientY, state.start.y);
        const w = Math.abs(e.clientX - state.start.x);
        const h = Math.abs(e.clientY - state.start.y);
        state.box.style.left = x + 'px';
        state.box.style.top = y + 'px';
        state.box.style.width = w + 'px';
        state.box.style.height = h + 'px';
      };

      const onUp = (e) => {
        if (!started || !state.start) return;
        const x = Math.min(e.clientX, state.start.x);
        const y = Math.min(e.clientY, state.start.y);
        const w = Math.abs(e.clientX - state.start.x);
        const h = Math.abs(e.clientY - state.start.y);
        detach();
        if (w < 6 || h < 6) { cancel(); return; }
        const r = { x, y, w, h, top: y, bottom: y + h, left: x, right: x + w };
        finishSelection(r).catch((e) => {
          cleanup();
          if (state.box) { state.box.remove(); state.box = null; }
          showPanel(r, '', '—', 'Ошибка расширения: ' + String((e && e.message) || e), 'err');
        });
      };

      const onKey = (e) => {
        if (e.key === 'Escape') { detach(); cancel(); }
      };

      function detach() {
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('mouseup', onUp, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('contextmenu', onCtx, true);
        overlay.removeEventListener('mousedown', onDown, true);
      }

      function cancel() {
        cleanup();
        closePanel();
      }

      function onCtx(e) { e.preventDefault(); detach(); cancel(); }

      overlay.addEventListener('mousedown', onDown, true);
      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('mouseup', onUp, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('contextmenu', onCtx, true);
    });
  }

  window[KEY] = { loaded: true, restart: startSelection };
  startSelection();
})();
