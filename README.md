# TransLens — выделил область на странице → получил перевод

Chrome-расширение (MV3) для чтения англоязычных интерфейсов без переключения языка всего сайта.
Сделано под AWS Cloud Quest, где половина текста живёт внутри видео/канваса.

## Что делает

1. `Alt+Shift+S` (или клик по иконке расширения, или правый клик → «Перевести область»)
2. Тянешь рамку по нужному тексту — удобно ровно по строке субтитра.
3. Расширение снимает вкладку, вырезает область, распознаёт текст (tesseract, локально) и переводит
   встроенным переводчиком Chrome (`Translator API`, en→ru).
4. Панель с оригиналом и переводом, кнопка «Копировать».

Всё офлайн: ни OCR, ни перевод никуда не отправляются, ключи не нужны.

## Установка

1. `chrome://extensions` → включить «Режим разработчика»
2. «Загрузить распакованное расширение» → `/Users/alexey/Projects/translate-extension`
3. Открыть настройки расширения и один раз нажать «Скачать модель en → ru»
   (Chrome требует пользовательский жест для первой загрузки языкового пакета).

## Структура

| Файл | Роль |
|---|---|
| `src/background.js` | service worker: активация, `captureVisibleTab`, offscreen-OCR, перевод в MAIN world страницы |
| `src/content.js` | оверлей выделения + панель перевода |
| `src/content.css` | стили оверлея (через `chrome.scripting.insertCSS`, не зависят от CSP страницы) |
| `src/offscreen.js` | кроп области, предобработка (grayscale, авто-инверсия, растяжение контраста) и OCR |
| `src/options.html/js` | настройки, прогрев языкового пакета |
| `vendor/` | tesseract.js 5.1.1 + wasm-ядро + `eng.traineddata.gz` (tessdata_fast), локально |

## Тесты

```bash
node test/e2e.mjs                 # полный прогон: Chrome for Testing из кэша playwright
CQT_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node test/e2e.mjs
node test/api-check.mjs           # только встроенный переводчик, в обычном Chrome
node test/probe-ocr.mjs           # диагностика path capture → offscreen OCR
```

`test/e2e.mjs` поднимает реальный браузер, грузит расширение, делает настоящий drag мышью по
тестовой странице (`test/site/page.html`, среди фикстур — вырезка субтитров Cloud Quest) и проверяет
OCR и перевод. Тестовая копия расширения получает `<all_urls>` — из автотеста нет пользовательского
жеста, а `captureVisibleTab` без него не выдаётся; в бою `activeTab` приходит от хоткея/клика.

Две грабли Chrome, на которые ушло время:

- в обычном Google Chrome (137+) флаг `--load-extension` **игнорируется**, а его присутствие вдобавок
  не даёт подняться service worker'у расширения. В автотесте расширение грузится через CDP
  `Extensions.loadUnpacked`, а после загрузки надо открыть любую extension-страницу — MV3-воркер ленивый;
- `--disable-extensions-except` в обычном Chrome тоже не поддерживается (в логе: *not allowed*).

## Технические заметки

- `captureVisibleTab` снимает страницу **вместе с инжектированным DOM** — оверлей прячется на время снятия.
- Масштаб кропа считается как `image.width / viewport.width` — корректно при Retina и зуме браузера.
- `Translator.create()` требует transient activation при первой загрузке модели, поэтому прогрев
  вызывается на `mouseup` (жест ещё активен) и живёт в MAIN world страницы (`window.__cqtTranslator`).
- MV3 service worker не умеет `new Worker()` — OCR живёт в offscreen-документе.
