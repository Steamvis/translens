/**
 * Проверка Translator API в обычном Google Chrome (пакеты языков качает сам Chrome).
 * В Chrome for Testing встроенных моделей обычно нет — там проверяем только механику.
 *   node test/api-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = process.env.CQT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9337;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cqt-api-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--user-data-dir=' + profile, '--remote-debugging-port=' + PORT,
  '--no-first-run', '--no-default-browser-check',
  'data:text/html,<title>api-check</title><h1>Translator API probe</h1>',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
chrome.stdout.on('data', (d) => (log += d));
chrome.stderr.on('data', (d) => (log += d));

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = ++seq;
      const pl = { id, method, params };
      if (sessionId) pl.sessionId = sessionId;
      ws.send(JSON.stringify(pl));
      return new Promise((r) => pending.set(id, r));
    },
  };
}

try {
  let version = null;
  for (let i = 0; i < 40 && !version; i++) {
    try { version = await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json(); } catch { await sleep(300); }
  }
  if (!version) throw new Error('devtools не поднялся');
  console.log('браузер:', version.Browser);
  const browser = connect(version.webSocketDebuggerUrl);
  await browser.ready;
  const { result } = await browser.send('Target.getTargets');
  const page = result.targetInfos.find((t) => t.type === 'page');
  const { result: att } = await browser.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
  const sid = att.sessionId;
  await browser.send('Runtime.enable', {}, sid);
  await sleep(500);

  const probe = await browser.send('Runtime.evaluate', {
    expression: `(async () => {
      const out = { hasApi: 'Translator' in self, probe: null, error: null, progress: null, availability: null };
      if (!out.hasApi) return out;
      const avail = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ru' });
      out.availability = avail;
      try {
        const t = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'ru',
          monitor(m) { m.addEventListener('downloadprogress', (e) => { self.__p = e.loaded; }); } });
        out.probe = await t.translate('S3 standard is for general purpose storage of frequently accessed data.');
        out.progress = self.__p;
      } catch (e) { out.error = e.name + ': ' + e.message; }
      return out;
    })()`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  }, sid);

  const v = probe.result && probe.result.result && probe.result.result.value;
  console.log(JSON.stringify(v, null, 2));
  const ok = !!(v && v.probe);
  console.log(ok ? '\nPASS: встроенный переводчик en→ru работает в этом Chrome' : '\nFAIL: переводчик недоступен');
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('ОШИБКА:', e.message, '\n', log.slice(-1500));
  process.exit(2);
} finally {
  chrome.kill('SIGKILL');
  fs.rmSync(profile, { recursive: true, force: true });
}
