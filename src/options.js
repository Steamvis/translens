const LANGS = [
  ['en', 'en — английский'], ['ru', 'ru — русский'], ['de', 'de — немецкий'], ['fr', 'fr — французский'],
  ['es', 'es — испанский'], ['it', 'it — итальянский'], ['pt', 'pt — португальский'], ['pl', 'pl — польский'],
  ['uk', 'uk — украинский'], ['tr', 'tr — турецкий'], ['ja', 'ja — японский'], ['ko', 'ko — корейский'],
  ['zh', 'zh — китайский'], ['hi', 'hi — хинди'], ['ar', 'ar — арабский'], ['nl', 'nl — нидерландский'],
];

const DEFAULTS = {
  sourceLanguage: 'en', targetLanguage: 'ru', ocrLang: 'eng', psm: '6',
  dim: true, upscale: 'auto', awsFix: true, autoWatch: true, watchInterval: 1200,
};

function fill(sel, value) {
  for (const [code, label] of LANGS) {
    const o = document.createElement('option');
    o.value = code;
    o.textContent = label;
    if (code === value) o.selected = true;
    sel.appendChild(o);
  }
}

async function init() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  const cfg = Object.assign({}, DEFAULTS, stored);
  const $ = (id) => document.getElementById(id);
  fill($('source'), cfg.sourceLanguage);
  fill($('target'), cfg.targetLanguage);
  $('ocrLang').value = cfg.ocrLang;
  $('psm').value = String(cfg.psm);
  $('upscale').value = String(cfg.upscale);
  $('dim').checked = !!cfg.dim;
  $('awsFix').checked = cfg.awsFix !== false;
  $('autoWatch').checked = cfg.autoWatch !== false;
  $('watchInterval').value = String(cfg.watchInterval);

  const save = async () => {
    await chrome.storage.local.set({
      sourceLanguage: $('source').value,
      targetLanguage: $('target').value,
      ocrLang: $('ocrLang').value,
      psm: $('psm').value,
      upscale: $('upscale').value,
      dim: $('dim').checked,
      awsFix: $('awsFix').checked,
      autoWatch: $('autoWatch').checked,
      watchInterval: Math.min(5000, Math.max(700, Number($('watchInterval').value) || DEFAULTS.watchInterval)),
    });
    status('Настройки сохранены', 'ok');
  };
  ['source', 'target', 'ocrLang', 'psm', 'upscale'].forEach((id) => $(id).addEventListener('change', save));
  $('dim').addEventListener('change', save);
  $('awsFix').addEventListener('change', save);
  $('autoWatch').addEventListener('change', save);
  $('watchInterval').addEventListener('change', save);

  await checkAvailability();
}

function status(text, cls) {
  const s = document.getElementById('status');
  s.textContent = text;
  s.className = 'status' + (cls ? ' ' + cls : '');
}

async function checkAvailability() {
  const $ = (id) => document.getElementById(id);
  const src = $('source').value || DEFAULTS.sourceLanguage;
  const tgt = $('target').value || DEFAULTS.targetLanguage;
  if (!('Translator' in self)) {
    status('Translator API недоступен в этой сборке Chrome (нужен Chrome 138+ на десктопе).', 'err');
    $('prepare').disabled = true;
    return;
  }
  try {
    const a = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
    const map = { available: ['Готово к работе', 'ok'], downloadable: ['Модель ещё не скачана — нажми кнопку ниже', 'warn'],
                  downloading: ['Модель качается…', 'warn'], unavailable: ['Эта пара языков не поддерживается', 'err'] };
    const [text, cls] = map[a] || [a, ''];
    status(src + ' → ' + tgt + ': ' + text, cls);
  } catch (e) {
    status('Не удалось проверить: ' + (e && e.message || e), 'err');
  }
}

async function prepare() {
  const $ = (id) => document.getElementById(id);
  const src = $('source').value, tgt = $('target').value;
  if (!('Translator' in self)) { status('Translator API недоступен', 'err'); return; }
  const prog = $('prog');
  prog.hidden = false;
  prog.value = 0;
  status('Создаю переводчик…', 'warn');
  try {
    const t = await Translator.create({
      sourceLanguage: src,
      targetLanguage: tgt,
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          prog.value = e.loaded;
          status('Скачиваю модель: ' + Math.round(e.loaded * 100) + '%', 'warn');
        });
      },
    });
    const probe = await t.translate('Transferring data to Amazon S3 completes quickly.');
    status('Готово. Проверка перевода: «' + probe + '»', 'ok');
    prog.hidden = true;
  } catch (e) {
    status('Не вышло: ' + (e && e.name ? e.name + ': ' + e.message : e), 'err');
  }
}

document.getElementById('prepare').addEventListener('click', prepare);
document.getElementById('source').addEventListener('change', checkAvailability);
document.getElementById('target').addEventListener('change', checkAvailability);
init();
