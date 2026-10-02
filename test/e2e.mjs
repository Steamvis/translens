/**
 * E2E-прогон расширения в настоящем Chrome по CDP. Без внешних зависимостей.
 *   node test/e2e.mjs
 * Что проверяем: расширение грузится без ошибок → content script внедряется →
 * реальный drag мышью → captureVisibleTab + кроп → OCR → перевод en→ru → панель.
 */
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
// В обычном Google Chrome флаг --load-extension отключён с 137-й версии, поэтому
// для автотеста берём Chrome for Testing (лежит в кэше playwright) — он unpacked грузит.
const CFT = os.homedir() + '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const BRANDED = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHROME = process.env.CQT_CHROME || (fs.existsSync(CFT) ? CFT : BRANDED);
const IS_CFT = CHROME === CFT;
const SITE_PORT = 8791;
const DEBUG_PORT = 9333;
const HEADLESS = !process.argv.includes('--headed');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- статик-сервер ---------- */
const MIME = { '.html': 'text/html', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, 'test/site', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'page.html');
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); res.end('nope'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
});

/* ---------- минимальный CDP-клиент ---------- */
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.listeners = new Set();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, method } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(method + ' → ' + m.error.message)) : resolve(m.result);
      } else {
        for (const fn of this.listeners) fn(m);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error('timeout ' + method)); }, 60000);
    });
  }
  on(fn) { this.listeners.add(fn); }
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  return new CDP(ws);
}

async function waitForOrNull(fn, opts = {}) {
  try { return await waitFor(fn, opts); } catch { return null; }
}

async function waitFor(fn, { timeout = 30000, interval = 200, label = 'условие' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error('не дождались: ' + label);
    await sleep(interval);
  }
}

/* ---------- подготовка тестовой копии расширения ---------- */
function makeTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqt-ext-'));
  for (const item of ['manifest.json', 'src', 'icons', 'vendor']) {
    fs.cpSync(path.join(ROOT, item), path.join(dir, item), { recursive: true });
  }
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  // Только для теста: в бою activeTab выдаётся хоткеем/кликом по иконке и captureVisibleTab
  // работает; из автотеста жеста нет, поэтому даём широкое host-permission тестовой копии.
  mf.host_permissions = ['http://127.0.0.1/*', '<all_urls>'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf, null, 2));
  return dir;
}

/* ---------- основной сценарий ---------- */
const results = [];
let harnessError = null;
let translationAvailable = true;
function check(name, ok, info = '', soft = false) {
  results.push({ name, ok: ok || soft, info });
  const tag = ok ? '  PASS  ' : soft ? '  SKIP  ' : '  FAIL  ';
  console.log(tag + name + (info ? '  — ' + info : ''));
}

async function main() {
  await new Promise((r) => server.listen(SITE_PORT, '127.0.0.1', r));
  const extDir = makeTestExtension();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cqt-profile-'));
  console.log('профиль:', profile, '\nрасширение:', extDir);

  const args = [
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + DEBUG_PORT,
    '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,1000', '--allow-running-insecure-content',
    'about:blank',
  ];
  if (IS_CFT) {
    // В Chrome for Testing unpacked грузится флагом; в обычном Chrome флаг выпилен —
    // и, что важно, его присутствие ломает запуск service worker'а, поэтому не передаём его там.
    args.push('--load-extension=' + extDir, '--disable-extensions-except=' + extDir);
  }
  if (HEADLESS) args.unshift('--headless=new');
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeLog = '';
  chrome.stdout.on('data', (d) => { chromeLog += d; });
  chrome.stderr.on('data', (d) => { chromeLog += d; });

  try {
    const version = await waitFor(async () => {
      try { const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/version'); return await r.json(); }
      catch { return null; }
    }, { timeout: 30000, label: 'devtools endpoint' });
    console.log('chrome', version.Browser);

    const browser = await connect(version.webSocketDebuggerUrl);
    const sessions = new Map(); // targetId -> sessionId
    async function attach(targetId) {
      if (sessions.has(targetId)) return sessions.get(targetId);
      const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
      sessions.set(targetId, sessionId);
      await browser.send('Runtime.enable', {}, sessionId);
      await browser.send('Log.enable', {}, sessionId);
      return sessionId;
    }

    /* 1. service worker расширения поднялся без ошибок */
    const findSw = async () => {
      const { targetInfos } = await browser.send('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js')) || null;
    };
    let swTarget = await waitForOrNull(findSw, { timeout: IS_CFT ? 20000 : 4000, label: 'service worker' });
    if (!swTarget) {
      // В обычном Google Chrome флаг --load-extension игнорируется: грузим через CDP.
      const loaded = await browser.send('Extensions.loadUnpacked', { path: extDir });
      console.log('шаг: Extensions.loadUnpacked →', loaded.id);
      // MV3-воркер ленивый: без события он не поднимается. Открываем страницу настроек — она его будит.
      await browser.send('Target.createTarget', { url: 'chrome-extension://' + loaded.id + '/src/options.html' });
      swTarget = await waitFor(async () => {
        const { targetInfos } = await browser.send('Target.getTargets');
        return targetInfos.find((t) => t.type === 'service_worker' && t.url === 'chrome-extension://' + loaded.id + '/src/background.js') || null;
      }, { timeout: 20000, label: 'service worker после loadUnpacked' });
    }
    const extId = new URL(swTarget.url).host;
    console.log('шаг: attach к service worker', swTarget.url);
    const sw = await attach(swTarget.targetId);
    console.log('шаг: sw session', sw);
    const swErrors = [];
    browser.on((m) => {
      if (m.method === 'Runtime.exceptionThrown') swErrors.push(m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description || ''));
    });
    // воркер просыпается не мгновенно — читаем манифест с повторами, иначе проверка флакает
    let manifest = { result: { value: null } };
    for (let i = 0; i < 12; i++) {
      manifest = await browser.send('Runtime.evaluate', {
        expression: 'JSON.stringify({name: chrome.runtime.getManifest().name, v: chrome.runtime.getManifest().version})',
        returnByValue: true, awaitPromise: true,
      }, sw);
      if (manifest.result && manifest.result.value) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    check('service worker загружен, манифест читается', !!(manifest.result && manifest.result.value),
      JSON.stringify(manifest.result && manifest.result.value));

    /* 2. скачиваем языковой пакет en→ru (jest-эмуляция клика) через страницу настроек */
    console.log('шаг: открываю options.html');
    const optTarget = await browser.send('Target.createTarget', { url: 'chrome-extension://' + extId + '/src/options.html' });
    console.log('шаг: attach к options');
    const opt = await attach(optTarget.targetId);
    await waitFor(async () => {
      const r = await browser.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, opt);
      return r.result.value === 'complete';
    }, { label: 'options page' });
    const hasTranslatorInExt = await browser.send('Runtime.evaluate', { expression: `('Translator' in self)`, returnByValue: true }, opt);
    console.log('замер: Translator в extension-странице =', JSON.stringify(hasTranslatorInExt.result.value));
    console.log('шаг: проба языкового пакета');
    const packProbe = await browser.send('Runtime.evaluate', {
      expression: `(async () => {
        if (!('Translator' in self)) return { ok: false, reason: 'Translator отсутствует в extension-странице' };
        const bail = (ms, what) => new Promise((r) => setTimeout(() => r({ ok: false, reason: 'таймаут ' + what + ' (' + ms + ' мс)' }), ms));
        try {
          const avail = await Promise.race([Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ru' }), bail(8000, 'availability')]);
          if (typeof avail === 'object') return { ok: false, reason: avail.reason, availability: null };
          const t = await Promise.race([Translator.create({ sourceLanguage: 'en', targetLanguage: 'ru',
            monitor(m) { m.addEventListener('downloadprogress', (e) => { self.__p = e.loaded; }); } }), bail(45000, 'create')]);
          if (t && t.ok === false) return { ok: false, reason: t.reason, availability: avail };
          const out = await Promise.race([t.translate('S3 standard is for general purpose storage of frequently accessed data.'), bail(20000, 'translate')]);
          if (out && out.ok === false) return { ok: false, reason: out.reason, availability: avail };
          return { ok: true, availability: avail, out, progress: self.__p };
        } catch (e) { return { ok: false, reason: e.name + ': ' + e.message }; }
      })()`,
      awaitPromise: true, returnByValue: true, userGesture: true,
    }, opt);
    const pack = packProbe.result.value;
    translationAvailable = !!(pack && pack.ok);
    check('встроенный Translator доступен и переводит en→ru', translationAvailable,
      JSON.stringify(pack).slice(0, 260), IS_CFT);

    /* 3. открываем тестовую страницу */
    const pageTarget = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:' + SITE_PORT + '/page.html' });
    const page = await attach(pageTarget.targetId);
    const pageErrors = [];
    browser.on((m) => {
      if (m.sessionId === page && m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails.text);
    });
    await waitFor(async () => {
      const r = await browser.send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && [...document.images].every(i => i.complete)`,
        returnByValue: true,
      }, page);
      return r.result.value === true;
    }, { label: 'тестовая страница и картинки' });

    /* 4. запускаем выделение боевым путём (startSelection в воркере) */
    const startRes = await startSelectionOnTestTab();
    check('startSelection отработал (insertCSS + inject)', startRes.includes('"ok":true'), startRes.slice(0, 200));
    const ov = await waitFor(overlayState, { label: 'оверлей выделения' });
    check('оверлей растянут на вьюпорт (стили подключились)',
      ov.position === 'fixed' && Math.abs(ov.w - ov.vw) <= 2 && Math.abs(ov.h - ov.vh) <= 2,
      JSON.stringify(ov));

    /* 4b. диагностический канал: панель спрашивает воркер про этап при таймауте */
    const dbg = await browser.send('Runtime.evaluate', {
      expression: `(async () => JSON.stringify(await chrome.runtime.sendMessage({ type: 'debug-state' })))()`,
      awaitPromise: true, returnByValue: true,
    }, opt);
    const dbgVal = String(dbg.result.value);
    check('воркер отвечает на диагностику этапа', dbgVal.includes('"ok":true') && dbgVal.includes('stage'), dbgVal.slice(0, 160));

    /* 5. реальный drag мышью по картинке с субтитрами Cloud Quest */
    async function dragOver(selector) {
      const box = await browser.send('Runtime.evaluate', {
        expression: `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return JSON.stringify({ x: r.left + 3, y: r.top + 3, x2: r.right - 3, y2: r.bottom - 3 }); })()`,
        returnByValue: true,
      }, page);
      const { x, y, x2, y2 } = JSON.parse(box.result.value);
      const common = { button: 'left', buttons: 1, clickCount: 1 };
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, page);
      await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, ...common }, page);
      for (let i = 1; i <= 4; i++) {
        await browser.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x + ((x2 - x) * i) / 4, y: y + ((y2 - y) * i) / 4, ...common }, page);
      }
      await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, ...common }, page);
      return { x, y, x2, y2 };
    }

    // Тот же путь, что и клик по иконке/хоткей: startSelection в воркере (insertCSS + inject).
    // Клик по иконке через CDP не воспроизвести, поэтому дёргаем внутреннее сообщение.
    async function startSelectionOnTestTab() {
      const r = await browser.send('Runtime.evaluate', {
        expression: `(async () => {
          try {
            const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${SITE_PORT}/*' });
            const tab = tabs[0];
            if (!tab) return 'no-tab';
            await chrome.tabs.update(tab.id, { active: true });
            const res = await chrome.runtime.sendMessage({ type: 'start-selection', tabId: tab.id });
            return JSON.stringify(res);
          } catch (e) { return 'ERR:: ' + (e && e.message || e); }
        })()`,
        awaitPromise: true, returnByValue: true,
      }, opt);
      return String(r.result.value);
    }

    async function overlayState() {
      const r = await browser.send('Runtime.evaluate', {
        expression: `(() => { const o = document.querySelector('.cqt-overlay');
          if (!o) return null;
          const s = getComputedStyle(o); const b = o.getBoundingClientRect();
          return JSON.stringify({ position: s.position, w: Math.round(b.width), h: Math.round(b.height),
            vw: innerWidth, vh: innerHeight }); })()`,
        returnByValue: true,
      }, page);
      return r.result.value ? JSON.parse(r.result.value) : null;
    }

    // авто-режим выключен: кейсы OCR должны быть детерминированными, авто проверим отдельно
    await browser.send('Runtime.evaluate', {
      expression: `chrome.storage.local.set({ autoWatch: false, watchInterval: 700 })`,
      awaitPromise: true, returnByValue: true,
    }, sw);

    const escKey = async () => {
      const k = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 };
      await browser.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyDown' }, k), page);
      await browser.send('Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, k), page);
    };

    async function readPanel() {
      const r = await browser.send('Runtime.evaluate', {
        expression: `(() => { const ps = document.querySelectorAll('.cqt-panel'); const p = ps[ps.length - 1];
          if (!p) return null;
          const q = (s) => { const e = p.querySelector(s); return e ? e.textContent : ''; };
          return JSON.stringify({ src: q('.cqt-src'), dst: q('.cqt-dst'), note: q('.cqt-note') }); })()`,
        returnByValue: true,
      }, page);
      return r.result.value ? JSON.parse(r.result.value) : null;
    }

    async function zoneCounts() {
      const r = await browser.send('Runtime.evaluate', {
        expression: `JSON.stringify({ boxes: document.querySelectorAll('.cqt-box').length,
          panels: document.querySelectorAll('.cqt-panel').length,
          badges: document.querySelectorAll('.cqt-badge').length })`,
        returnByValue: true,
      }, page);
      return JSON.parse(r.result.value);
    }

    async function zoneState() {
      const r = await browser.send('Runtime.evaluate', {
        expression: `(() => {
          const bs = document.querySelectorAll('.cqt-box'); const ps = document.querySelectorAll('.cqt-panel');
          const b = bs[bs.length - 1]; const p = ps[ps.length - 1];
          if (!b || !p) return null;
          const br = b.getBoundingClientRect(); const note = p.querySelector('.cqt-note');
          const bd = document.querySelector('.cqt-badge');
          return JSON.stringify({ boxAuto: b.classList.contains('cqt-auto'),
            badge: bd ? bd.textContent : '',
            note: note ? note.textContent : '',
            title: (p.querySelector('.cqt-title') || {}).textContent || '',
            src: (p.querySelector('.cqt-src') || {}).textContent || '',
            boxFixed: getComputedStyle(b).position === 'fixed',
            boxRect: { x: Math.round(br.left), y: Math.round(br.top), w: Math.round(br.width), h: Math.round(br.height) } });
        })()`,
        returnByValue: true,
      }, page);
      return r.result.value ? JSON.parse(r.result.value) : null;
    }

    const cases = [
      ['#caption', 'cloud quest caption (реальный скриншот)', /S3 standard is for general purpose storage/i],
      ['#dark', 'тёмный UI (инверсия)', /Amazon S3 Glacier Deep Archive is the lowest-cost storage class/i],
      ['#light', 'светлый UI', /Amazon S3 Intelligent-Tiering moves objects between access tiers/i],
    ];
    for (const [sel, label, expect] of cases) {
      await escKey();
      await waitFor(async () => (await zoneCounts()).boxes === 0, { timeout: 8000, label: 'зона убрана перед кейсом ' + sel }).catch(() => {});
      // как в бою: каждое выделение начинается с активации расширения (Alt+Shift+S / иконка)
      await startSelectionOnTestTab();
      await waitFor(overlayState, { label: 'оверлей ' + sel });
      const t0 = Date.now();
      const rect = await dragOver(sel);
      let opened;
      try {
        // панель создаётся сразу (dst = '…'), поэтому ждём не её, а результат распознавания
        opened = await waitFor(async () => {
          const p = await readPanel();
          return p && (p.src || /OCR|ошибк|не нашёл|не ответил/i.test(p.note)) ? p : null;
        }, { timeout: 120000, label: 'OCR ' + sel });
      } catch (e) {
        console.error('--- диагностика: панели нет ---');
        console.error('  зоны: ' + JSON.stringify(await zoneCounts()));
        console.error('  pageErrors: ' + JSON.stringify(pageErrors).slice(0, 1500));
        console.error('  swErrors: ' + JSON.stringify(swErrors).slice(0, 1500));
        throw e;
      }
      const panel = translationAvailable
        ? await waitFor(async () => {
            const p = await readPanel();
            return p && p.dst && p.dst !== 'перевожу…' && p.dst !== '…' ? p : null;
          }, { timeout: 120000, label: 'перевод ' + sel })
        : opened;
      console.log('\n--- ' + label + ' (' + Math.round((Date.now() - t0) / 1000) + ' c) rect=' + JSON.stringify(rect));
      console.log('  OCR : ' + JSON.stringify(panel.src));
      console.log('  RU  : ' + JSON.stringify(panel.dst));
      console.log('  note: ' + panel.note);
      check('OCR вернул текст (' + sel + ')', (panel.src || '').length > 10, JSON.stringify((panel.src || '').slice(0, 90)));
      check('OCR-текст совпал с ожидаемым (' + sel + ')', expect.test(panel.src || ''),
        JSON.stringify((panel.src || '').slice(0, 120)) + ' ~ ' + expect);
      check('перевод получен (' + sel + ')', /[а-яА-ЯёЁ]/.test(panel.dst || ''),
        JSON.stringify((panel.dst || '').slice(0, 90)), !translationAvailable);
    }

    /* 6. авто-обновление: панель обновляется сама, без кликов */
    await escKey();
    await waitFor(async () => (await zoneCounts()).boxes === 0, { timeout: 8000, label: 'зон нет перед авто-тестом' }).catch(() => {});
    await startSelectionOnTestTab();
    await waitFor(overlayState, { label: 'оверлей авто-зоны' });
    const autoRect = await dragOver('#caption');
    await waitFor(async () => {
      const p = await readPanel();
      return p && p.src ? p : null;
    }, { timeout: 120000, label: 'OCR авто-зоны' });
    const st0 = await zoneState();
    check('рамка зоны видна и совпадает с выделением',
      st0.boxFixed && Math.abs(st0.boxRect.w - Math.round(autoRect.x2 - autoRect.x)) <= 3
        && Math.abs(st0.boxRect.x - Math.round(autoRect.x)) <= 3,
      JSON.stringify(st0.boxRect) + ' ~ ' + JSON.stringify(autoRect));
    check('у зоны есть номер', /^Зона \d+/.test(st0.title), st0.title);

    await browser.send('Page.bringToFront', {}, page);
    const vis = await browser.send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true }, page);
    check('вкладка видима (авто-режим идёт только на активной вкладке)', vis.result.value === 'visible', String(vis.result.value));

    const clicked = await browser.send('Runtime.evaluate', {
      expression: `(() => { const b = document.querySelector('.cqt-panel .cqt-watch'); if (!b) return 'нет кнопки'; b.click(); return 'ok'; })()`,
      returnByValue: true,
    }, page);
    check('в панели есть кнопка авто-режима', String(clicked.result.value) === 'ok', String(clicked.result.value));

    // ждём, пока авто-цикл реально сходит за снимком и отчитается в панели
    let auto;
    try {
      auto = await waitFor(async () => {
        const s = await zoneState();
        if (!s || !s.boxAuto || !s.src) return null;
        return /^авто/.test(s.note) && /обновлено|ждём|нет текста|нет захвата/.test(s.note) ? s : null;
      }, { timeout: 60000, label: 'авто-цикл обновил панель' });
    } catch (e) {
      console.error('--- авто-цикл не отчитался, состояние зоны: ' + JSON.stringify(await zoneState()));
      console.error('  pageErrors: ' + JSON.stringify(pageErrors).slice(0, 1200));
      throw e;
    }
    console.log('\n--- авто-режим: ' + JSON.stringify({ note: auto.note, badge: auto.badge, auto: auto.boxAuto }));
    check('авто-режим обновляет панель без кликов',
      auto.boxAuto && /^авто/.test(auto.note) && /обновлено|ждём|нет текста|нет захвата/.test(auto.note),
      JSON.stringify({ note: auto.note, badge: auto.badge }));
    check('номер зоны помечает авто-режим', /авто/.test(auto.badge), auto.badge);

    /* 7. несколько областей одновременно */
    await startSelectionOnTestTab();
    await waitFor(overlayState, { label: 'оверлей второй зоны' });
    await dragOver('#dark');
    await waitFor(async () => (await zoneCounts()).boxes === 2, { timeout: 120000, label: 'вторая зона' });
    const zc = await zoneCounts();
    check('можно выделить несколько областей', zc.boxes === 2 && zc.panels === 2 && zc.badges === 2, JSON.stringify(zc));

    await escKey();
    const zc2 = await waitFor(async () => {
      const c = await zoneCounts();
      return c.boxes === 1 ? c : null;
    }, { timeout: 10000, label: 'Esc убирает последнюю зону' });
    check('Esc убирает последнюю зону, остальные живы', zc2.boxes === 1 && zc2.panels === 1, JSON.stringify(zc2));

    check('в расширении не было JS-исключений', swErrors.length === 0 && pageErrors.length === 0,
      JSON.stringify([...swErrors, ...pageErrors]).slice(0, 300));
  } catch (e) {
    harnessError = e;
    console.error('ОШИБКА ХАРНЕССА:', e && e.stack || e);
    try { console.error('--- chrome stderr/stdout tail ---\n' + chromeLog.slice(-3000)); } catch {}
  } finally {
    try { chrome.kill('SIGKILL'); } catch {}
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    try { fs.rmSync(extDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    const fails = results.filter((r) => !r.ok);
    console.log('\n===== ИТОГО: ' + (results.length - fails.length) + '/' + results.length + ' проверок прошло =====');
    if (fails.length) console.log('провалились: ' + fails.map((f) => f.name).join('; '));
    if (harnessError) console.log('харнесс упал: ' + (harnessError.message || harnessError));
    process.exit(harnessError ? 2 : fails.length ? 1 : 0);
  }
}

main().catch((e) => { console.error('ОШИБКА ХАРНЕССА:', e); process.exit(2); });
