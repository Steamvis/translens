// Проверка экспортированной модели в рантайме transformers.js (тот же, что в расширении).
// Переводит data/test.jsonl квантованной ONNX-моделью и пишет results/onnx.cloud.tsv,
// BLEU/chrF считает ml/score_tsv.py.
//
//   node ml/evaluate_onnx.mjs [limit]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, pipeline } from '@huggingface/transformers';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
env.localModelPath = process.env.MODELS_DIR || path.join(ROOT, '..', 'models');
env.allowRemoteModels = false;

const limit = Number(process.argv[2]) || Infinity;
const dtype = process.argv[3] || 'q8';
const outName = process.argv[4] || 'onnx';
const rows = fs.readFileSync(path.join(ROOT, 'data/test.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).slice(0, limit);

const t0 = performance.now();
const translator = await pipeline('translation', 'opus-mt-en-ru-cloud', { dtype });
const loadMs = performance.now() - t0;

const out = [];
const t1 = performance.now();
for (const r of rows) {
  const [res] = await translator(r.en, { num_beams: 4, max_length: 256 });
  out.push([r.en, res.translation_text, r.ru].map((s) => s.replace(/\t/g, ' ')).join('\t'));
}
const ms = performance.now() - t1;
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
fs.writeFileSync(path.join(ROOT, `results/${outName}.cloud.tsv`), out.join('\n') + '\n');
console.log(JSON.stringify({ n: rows.length, load_ms: Math.round(loadMs), ms_per_sentence: Math.round(ms / rows.length) }));
