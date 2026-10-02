/**
 * TransLens — service worker.
 * Задачи: активация (хоткей/иконка/контекстное меню), захват вкладки,
 * OCR через offscreen-документ, перевод во встроенном переводчике Chrome.
 */

const OFFSCREEN_URL = 'src/offscreen.html';
const DEFAULTS = {
  sourceLanguage: 'en',
  targetLanguage: 'ru',
  ocrLang: 'eng',
  psm: '6',
  dim: true,
  upscale: 'auto',
  awsFix: true,
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'cqt-translate-region',
      title: 'Перевести область',
      contexts: ['page', 'selection', 'image', 'video'],
    });
  });
});

chrome.action.onClicked.addListener((tab) => startSelection(tab));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'cqt-translate-region' && tab) startSelection(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'start-selection') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) startSelection(tab);
});

async function startSelection(tab) {
  if (!tab || tab.id == null) return;
  const url = tab.url || '';
  if (!/^(https?|file):/.test(url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
  } catch (e) {
    console.warn('[TransLens] не удалось внедрить content script:', e);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'capture-ocr') {
    captureAndOcr(msg, sender).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'page-translator') {
    runInPage(sender, msg).then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e && e.message || e) }));
    return true;
  }
});

async function captureAndOcr(msg, sender) {
  const tab = sender.tab;
  if (!tab || tab.id == null) return { ok: false, error: 'нет вкладки-источника' };
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (e) {
    return { ok: false, error: 'Не удалось снять вкладку: ' + String(e && e.message || e) + ' (закрой DevTools на этой вкладке и попробуй снова)' };
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: 'offscreen-ocr',
    dataUrl,
    rect: msg.rect,
    viewport: msg.viewport,
    lang: msg.lang || DEFAULTS.ocrLang,
    psm: msg.psm || DEFAULTS.psm,
    upscale: msg.upscale || DEFAULTS.upscale,
    awsFix: msg.awsFix !== false,
  });
  return res || { ok: false, error: 'offscreen не ответил' };
}

let offscreenCreating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url],
  });
  if (contexts.length) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['WORKERS'],
        justification: 'Локальный OCR (tesseract wasm worker) выделенной области',
      })
      .finally(() => { offscreenCreating = null; });
  }
  await offscreenCreating;
}

async function runInPage(sender, msg) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return { ok: false, reason: 'нет вкладки' };
  const args = [msg.action, {
    sourceLanguage: msg.sourceLanguage || DEFAULTS.sourceLanguage,
    targetLanguage: msg.targetLanguage || DEFAULTS.targetLanguage,
    text: msg.text || '',
  }];
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: pageTranslator,
      args,
    });
    return (res && res.result) || { ok: false, reason: 'пустой результат' };
  } catch (e) {
    return { ok: false, reason: String(e && e.message || e) };
  }
}

/**
 * Выполняется в MAIN world страницы (там живёт Translator API и есть user activation
 * от реального жеста мыши). Держим промис создания переводчика на window, чтобы
 * скачивание языкового пакета стартовало прямо внутри жеста, а не после OCR.
 */
function pageTranslator(action, opts) {
  const T = globalThis.Translator;
  const state = (globalThis.__cqtTranslator = globalThis.__cqtTranslator || {
    key: null, promise: null, progress: 0, error: null,
  });
  const key = opts.sourceLanguage + '>' + opts.targetLanguage;
  if (state.key !== key) {
    state.key = key;
    state.promise = null;
    state.progress = 0;
    state.error = null;
  }
  if (!T) return Promise.resolve({ ok: false, reason: 'no-api' });

  const create = () => {
    if (state.promise) return state.promise;
    state.promise = T.create({
      sourceLanguage: opts.sourceLanguage,
      targetLanguage: opts.targetLanguage,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => { state.progress = e.loaded; });
      },
    }).catch((e) => {
      state.error = e && e.name ? e.name + ': ' + e.message : String(e);
      state.promise = null;
      throw e;
    });
    return state.promise;
  };

  if (action === 'warm') {
    if (!state.promise) { create().catch(() => {}); }
    return Promise.resolve({ ok: true, warmed: true, progress: state.progress });
  }
  if (action === 'progress') {
    return Promise.resolve({ ok: true, progress: state.progress, error: state.error });
  }
  return create()
    .then((t) => t.translate(opts.text))
    .then((text) => ({ ok: true, text, progress: state.progress }))
    .catch((e) => ({
      ok: false,
      reason: state.error || String(e && e.message || e),
      noGesture: !!(e && e.name === 'NotAllowedError'),
      progress: state.progress,
    }));
}
