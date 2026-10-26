# Дообучение модели перевода en-ru под облачную терминологию

Базовая модель [Helsinki-NLP/opus-mt-en-ru](https://huggingface.co/Helsinki-NLP/opus-mt-en-ru) (MarianMT, 77M параметров) переводит облачные термины бытовыми словами: bucket - "ведро", instance - "пример", security group - "группа защиты". Модель дообучена (fine-tuning) на параллельном корпусе облачной документации.

## Данные

Источник: документация Yandex Cloud, [github.com/yandex-cloud/docs](https://github.com/yandex-cloud/docs), лицензия CC BY 4.0. Каталоги `en/` и `ru/` содержат один и тот же текст с человеческим переводом.

`build_dataset.py` берёт разделы storage, compute, vpc, iam, managed-postgresql, functions, kms (аналоги S3, EC2, VPC, IAM, RDS, Lambda, KMS), разбирает пары файлов на заголовки, абзацы и пункты списков, оставляет только файлы с одинаковой структурой, убирает код, таблицы и разметку, подставляет переменные из `presets.yaml`. Разбиение train/valid/test по файлам, чтобы одна страница не попала и в обучение, и в тест.

| | пар |
|---|---|
| train | 10361 |
| valid | 777 |
| test | 742 |

## Обучение

`train.py`: цикл на PyTorch, AdamW, lr 3e-5, warmup 6%, batch 16, 3 эпохи, max_len 128, Apple M4 Pro (MPS), 502 секунды.

| эпоха | valid loss |
|---|---|
| до обучения | 1.758 |
| 1 | 0.709 |
| 2 | 0.634 |
| 3 | 0.619 |

Длины батчей выравниваются до кратных 32: на MPS каждая новая форма тензора резервирует свои буферы, без выравнивания память росла до 29 ГБ.

## Результаты

`evaluate.py`, тестовая часть корпуса (742 пары), beam search 4.

| | BLEU | chrF | термины | BLEU новости WMT20 |
|---|---|---|---|---|
| базовая модель | 17.82 | 47.03 | 74.9% | 21.64 |
| дообученная | 50.39 | 71.54 | 96.2% | 18.49 |
| дообученная, ONNX int8 в transformers.js | 48.93 | 70.33 | 90.4% | - |
| дообученная, ONNX fp32 в transformers.js | 48.83 | 70.32 | 89.8% | - |

"Термины" - доля случаев, когда модель использует тот же термин, что и эталонный перевод (бакет, виртуальная машина, каталог, подсеть, сервисный аккаунт, триггер и т.д.). Например, "бакет": 0 из 12 у базовой модели, 12 из 12 у дообученной. Подробно в `results/base.json` и `results/tuned.json`.

Новости WMT20 - контроль на обычном тексте: качество там упало на 3 BLEU (катастрофическое забывание).

Int8 и fp32 в transformers.js дают одинаковый результат, значит потеря относительно PyTorch идёт от токенизатора transformers.js (для Marian он поддержан приблизительно), а не от квантизации.

Фразы в стиле AWS, которых нет в корпусе: `results/samples.md`.

## Запуск

```bash
uv venv -p 3.12 .venv && uv pip install -p .venv -r requirements.txt
git clone --depth 1 --filter=blob:none --sparse https://github.com/yandex-cloud/docs /tmp/ycdocs
(cd /tmp/ycdocs && git sparse-checkout set en/storage ru/storage en/compute ru/compute en/vpc ru/vpc en/iam ru/iam en/managed-postgresql ru/managed-postgresql en/functions ru/functions en/kms ru/kms)

.venv/bin/python build_dataset.py --src /tmp/ycdocs --out data
.venv/bin/python evaluate.py --model Helsinki-NLP/opus-mt-en-ru --name base
.venv/bin/python train.py --epochs 3
.venv/bin/python evaluate.py --model out/opus-mt-en-ru-cloud --name tuned
.venv/bin/python samples.py > results/samples.md
```

Экспорт в ONNX для браузера (отдельное окружение: optimum-onnx требует transformers<4.58):

```bash
uv venv -p 3.12 .venv-export && uv pip install -p .venv-export -r requirements-export.txt
.venv-export/bin/python export_onnx.py      # -> ../models/opus-mt-en-ru-cloud, 110 МБ
node evaluate_onnx.mjs                      # перевод теста в transformers.js
.venv/bin/python score_tsv.py results/onnx.cloud.tsv
```

Веса моделей в репозиторий не входят, собираются командами выше.
