/**
 * TransLens — offscreen-документ: кроп выделенной области, предобработка
 * и локальный OCR через tesseract.js (wasm, из вендорной папки).
 */

const VENDOR = {
  workerPath: chrome.runtime.getURL('vendor/tesseract/worker.min.js'),
  corePath: chrome.runtime.getURL('vendor/tesseract-core'),
  langPath: chrome.runtime.getURL('vendor/lang'),
};

let workerPromise = null;
let workerLang = null;

async function getWorker(lang) {
  if (workerPromise && workerLang === lang) return workerPromise;
  workerPromise = (async () => {
    const worker = await Tesseract.createWorker(lang, 1, {
      workerPath: VENDOR.workerPath,
      corePath: VENDOR.corePath,
      langPath: VENDOR.langPath,
      workerBlobURL: false,
      cacheMethod: 'none',
      gzip: true,
      logger: () => {},
    });
    await worker.setParameters({
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    workerLang = lang;
    return worker;
  })().catch((e) => { workerPromise = null; workerLang = null; throw e; });
  return workerPromise;
}

function percentile(hist, total, p) {
  let acc = 0;
  const target = total * p;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

function preprocess(bitmap, rect, viewport, upscale) {
  const scale = Math.min(bitmap.width / viewport.w, bitmap.height / viewport.h) || 1;
  const pad = Math.round(5 * scale);
  const sx = Math.max(0, Math.round(rect.x * scale) - pad);
  const sy = Math.max(0, Math.round(rect.y * scale) - pad);
  const sw = Math.min(bitmap.width - sx, Math.round(rect.w * scale) + pad * 2);
  const sh = Math.min(bitmap.height - sy, Math.round(rect.h * scale) + pad * 2);

  let up = 1;
  if (upscale === 'auto') up = sw < 900 ? 2 : 1;
  else up = Number(upscale) || 1;
  const cap = Math.min(up, 4200 / sw, 4200 / sh);
  up = Math.max(1, Math.min(3, Math.floor(cap * 100) / 100));

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * up));
  canvas.height = Math.max(1, Math.round(sh * up));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
  }
  const total = canvas.width * canvas.height;
  let acc = 0, median = 128;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total / 2) { median = v; break; } }
  const invert = median < 118;
  const lo = percentile(hist, total, 0.02);
  const hi = percentile(hist, total, 0.98);
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / span;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas, invert, scale, up };
}

// Типовые ошибки OCR на шрифтах Cloud Quest: $3 вместо S3 и т.п.
function fixAwsTerms(text) {
  return text
    .replace(/\$\s*3(?![0-9])/g, 'S3')
    .replace(/\bS\s+3(?![0-9])/g, 'S3')
    .replace(/\bAmazonS3\b/g, 'Amazon S3');
}

function tidy(text, awsFix) {
  return (awsFix ? fixAwsTerms(String(text || '')) : String(text || ''))
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n')
    .trim();
}

async function ocr(msg) {
  const t0 = performance.now();
  const blob = await (await fetch(msg.dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const { canvas, invert, scale, up } = preprocess(bitmap, msg.rect, msg.viewport, msg.upscale);
  bitmap.close && bitmap.close();

  const worker = await getWorker(msg.lang || 'eng');
  await worker.setParameters({ tessedit_pageseg_mode: String(msg.psm || '6') });
  const { data } = await worker.recognize(canvas);
  const text = tidy(data.text, msg.awsFix !== false);
  return {
    ok: true,
    text,
    confidence: data.confidence,
    meta: { invert, scale, up, ms: Math.round(performance.now() - t0) },
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'offscreen-ocr') return;
  ocr(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
