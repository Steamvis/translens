/**
 * Диагностика: прогоняем путь capture → offscreen OCR напрямую и печатаем, где встаёт.
 *   node test/probe-ocr.mjs
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const CFT = os.homedir() + '/Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const PORT = 8792;
const DEBUG = 9342;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = { '.html': 'text/html', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, 'test/site', decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'page.html');
  fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
});

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map(); let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(p.method + ' → ' + m.error.message)) : p.res(m.result); }
    else for (const f of listeners) f(m);
  });
  const listeners = [];
  const ready = new Promise((r) => ws.addEventListener('open', r));
  return { ready, on: (f) => listeners.push(f),
    send(method, params = {}, sessionId) { const id = ++seq; const pl = { id, method, params }; if (sessionId) pl.sessionId = sessionId; ws.send(JSON.stringify(pl)); return new Promise((res, rej) => pending.set(id, { res, rej, method })); } };
}

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cqt-ext-'));
for (const i of ['manifest.json', 'src', 'icons', 'vendor']) fs.cpSync(path.join(ROOT, i), path.join(extDir, i), { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
mf.host_permissions = ['http://127.0.0.1/*', '<all_urls>'];
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(mf, null, 2));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cqt-prof-'));
const chrome = spawn(CFT, ['--headless=new', '--user-data-dir=' + profile, '--load-extension=' + extDir,
  '--remote-debugging-port=' + DEBUG, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
let clog = ''; chrome.stdout.on('data', (d) => (clog += d)); chrome.stderr.on('data', (d) => (clog += d));

try {
  let v = null;
  for (let i = 0; i < 40 && !v; i++) { try { v = await (await fetch(`http://127.0.0.1:${DEBUG}/json/version`)).json(); } catch { await sleep(300); } }
  const browser = connect(v.webSocketDebuggerUrl);
  await browser.ready;
  const logs = [];
  browser.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') logs.push('console[' + m.params.type + ']: ' + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
    if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Log.entryAdded') logs.push('log[' + m.params.entry.level + ']: ' + m.params.entry.text);
    if (m.method === 'Target.targetCreated') logs.push('target+: ' + m.params.targetInfo.type + ' ' + m.params.targetInfo.url);
  });

  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const { targetInfos } = await browser.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/src/background.js')) || null;
    if (!sw) await sleep(300);
  }
  const { sessionId: swS } = await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  await browser.send('Runtime.enable', {}, swS);
  await browser.send('Log.enable', {}, swS);

  const { targetId: pageId } = await browser.send('Target.createTarget', { url: `http://127.0.0.1:${PORT}/page.html` });
  const { sessionId: pageS } = await browser.send('Target.attachToTarget', { targetId: pageId, flatten: true });
  await browser.send('Runtime.enable', {}, pageS);
  await browser.send('Log.enable', {}, pageS);
  await sleep(2500);

  const r = await browser.send('Runtime.evaluate', {
    expression: `(async () => {
      const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1:${PORT}/*' });
      const tab = tabs[0];
      await chrome.tabs.update(tab.id, { active: true });
      const out = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async (rect, viewport) => {
          try {
            const r = await chrome.runtime.sendMessage({ type: 'capture-ocr', rect, viewport, lang: 'eng', psm: '6', upscale: 'auto' });
            return { ok: true, res: r };
          } catch (e) { return { ok: false, err: String(e && e.message || e) }; }
        },
        args: [{ x: 30, y: 55, w: 760, h: 110 }, { w: 1400, h: 1000 }],
      });
      return JSON.stringify(out[0].result);
    })()`,
    awaitPromise: true, returnByValue: true,
  }, swS);

  console.log('РЕЗУЛЬТАТ capture+OCR:', String(r.result.value).slice(0, 900));
  await sleep(1500);
  const { targetInfos } = await browser.send('Target.getTargets');
  console.log('таргеты:\n' + targetInfos.map((t) => '  ' + t.type + ' :: ' + t.url).join('\n'));
  console.log('логи расширения:\n' + logs.slice(-40).join('\n'));
} catch (e) {
  console.log('ОШИБКА ПРОБЫ:', e.message);
  console.log('chrome:', clog.slice(-1200));
} finally {
  chrome.kill('SIGKILL'); server.close();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  try { fs.rmSync(extDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}
process.exit(0);