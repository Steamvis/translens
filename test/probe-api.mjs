/**
 * Быстрая проба Translator API в обычном Chrome: secure context + наличие API + перевод.
 *   node test/probe-api.mjs [--headed]
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHROME = process.env.CQT_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8793;
const DEBUG = 9343;
const HEADLESS = !process.argv.includes('--headed');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/probe.html' || u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>probe</h1>'); return; }
  res.writeHead(404); res.end();
});

try {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cqt-api-'));
  const args = ['--user-data-dir=' + profile, '--remote-debugging-port=' + DEBUG, '--no-first-run', '--no-default-browser-check', 'about:blank'];
  if (HEADLESS) args.unshift('--headless=new');
  const chrome = spawn(CHROME, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let clog = ''; chrome.stdout.on('data', (d) => (clog += d)); chrome.stderr.on('data', (d) => (clog += d));

  try {
    let v = null;
    for (let i = 0; i < 40 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).json(); } catch { await sleep(300); } }
    console.log('браузер:', v.Browser, HEADLESS ? '(headless)' : '(headed)');
    const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener('open', r));
    let id = 0; const pend = new Map();
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const send = (m, p = {}, s) => { const i = ++id; const pl = { id: i, method: m, params: p }; if (s) pl.sessionId = s; ws.send(JSON.stringify(pl)); return new Promise((r) => pend.set(i, r)); };

    for (const url of [`http://127.0.0.1:${PORT}/probe.html`, 'about:blank']) {
      const { result: t } = await send('Target.createTarget', { url });
      const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
      const sid = a.sessionId;
      await send('Runtime.enable', {}, sid);
      await sleep(800);
      const r = await send('Runtime.evaluate', {
        expression: `(async () => {
          const out = { url: location.href, secure: self.isSecureContext, hasApi: 'Translator' in self, modelApi: 'LanguageModel' in self, availability: null, probe: null, error: null };
          if (!out.hasApi) return out;
          try {
            out.availability = await Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ru' });
            const t = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'ru',
              monitor(m) { m.addEventListener('downloadprogress', (e) => { self.__p = e.loaded; }); } });
            out.probe = await t.translate('S3 standard is for general purpose storage of frequently accessed data.');
            out.progress = self.__p;
          } catch (e) { out.error = e.name + ': ' + e.message; }
          return out;
        })()`,
        awaitPromise: true, returnByValue: true, userGesture: true,
      }, sid);
      console.log(JSON.stringify(r.result && r.result.result && r.result.result.value, null, 1));
      await send('Target.closeTarget', { targetId: t.targetId });
    }
  } catch (e) { console.log('ОШИБКА:', e.message); console.log(clog.slice(-800)); }
  finally { chrome.kill('SIGKILL'); }
} finally {
  server.close();
}
process.exit(0);