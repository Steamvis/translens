"""Оценка модели перевода en->ru.

    python evaluate.py --model Helsinki-NLP/opus-mt-en-ru --name base
    python evaluate.py --model out/opus-mt-en-ru-cloud --name tuned

Метрики:
  cloud  - BLEU/chrF на data/test.jsonl (документация облака, человеческий перевод)
  terms  - доля случаев, где модель использует тот же термин, что и эталон
  news   - BLEU/chrF на WMT20 newstest (обычный текст, проверка забывания)
Результат пишется в results/<name>.json, переводы - в results/<name>.<set>.tsv
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import sacrebleu
import torch
from transformers import MarianMTModel, MarianTokenizer

TERMS = {
    r"\bbuckets?\b": "бакет",
    r"\b(VM|VMs|virtual machines?)\b": "виртуальн",
    r"\bservice accounts?\b": "сервисн",
    r"\bfolders?\b": "каталог",
    r"\bsubnets?\b": "подсет",
    r"\bsecurity groups?\b": "групп безопасности",
    r"\bsnapshots?\b": "снимок|снимк",
    r"\btriggers?\b": "триггер",
    r"\bcloud networks?\b": "облачн",
    r"\bdisks?\b": "диск",
    r"\bobjects?\b": "объект",
    r"\bkeys?\b": "ключ",
}

ROOT = Path(__file__).parent


def device():
    return "mps" if torch.backends.mps.is_available() else "cpu"


def translate(model, tok, texts, bs=32, beams=4):
    out = []
    for i in range(0, len(texts), bs):
        batch = tok(texts[i:i + bs], return_tensors="pt", padding=True, truncation=True, max_length=256).to(model.device)
        with torch.no_grad():
            gen = model.generate(**batch, num_beams=beams, max_length=256)
        out += tok.batch_decode(gen, skip_special_tokens=True)
    return out


def news_set(n):
    src = subprocess.run([sys.executable, "-m", "sacrebleu", "-t", "wmt20", "-l", "en-ru", "--echo", "src"], capture_output=True, text=True, check=True).stdout.splitlines()
    ref = subprocess.run([sys.executable, "-m", "sacrebleu", "-t", "wmt20", "-l", "en-ru", "--echo", "ref"], capture_output=True, text=True, check=True).stdout.splitlines()
    return src[:n], ref[:n]


def term_accuracy(srcs, hyps, refs):
    hit = total = 0
    per = {}
    for s, h, r in zip(srcs, hyps, refs):
        for pat, stem in TERMS.items():
            if re.search(pat, s, re.I) and re.search(stem, r, re.I):
                ok = bool(re.search(stem, h, re.I))
                total += 1
                hit += ok
                p = per.setdefault(stem, [0, 0])
                p[0] += ok
                p[1] += 1
    return {"acc": round(100 * hit / max(total, 1), 1), "n": total, "per_term": {k: f"{a}/{b}" for k, (a, b) in per.items()}}


def score(hyps, refs):
    return {"bleu": round(sacrebleu.corpus_bleu(hyps, [refs]).score, 2), "chrf": round(sacrebleu.corpus_chrf(hyps, [refs]).score, 2)}


def dump(path, srcs, hyps, refs):
    with open(path, "w", encoding="utf-8") as f:
        for s, h, r in zip(srcs, hyps, refs):
            f.write(f"{s}\t{h}\t{r}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--news", type=int, default=500)
    a = ap.parse_args()

    tok = MarianTokenizer.from_pretrained(a.model)
    model = MarianMTModel.from_pretrained(a.model).to(device()).eval()
    res = {"model": a.model}
    out = ROOT / "results"
    out.mkdir(exist_ok=True)

    rows = [json.loads(l) for l in open(ROOT / "data/test.jsonl", encoding="utf-8")]
    srcs, refs = [r["en"] for r in rows], [r["ru"] for r in rows]
    t = time.time()
    hyps = translate(model, tok, srcs)
    res["cloud"] = score(hyps, refs) | {"n": len(srcs), "sec": round(time.time() - t, 1)}
    res["terms"] = term_accuracy(srcs, hyps, refs)
    dump(out / f"{a.name}.cloud.tsv", srcs, hyps, refs)

    if a.news:
        srcs, refs = news_set(a.news)
        hyps = translate(model, tok, srcs)
        res["news"] = score(hyps, refs) | {"n": len(srcs)}
        dump(out / f"{a.name}.news.tsv", srcs, hyps, refs)

    (out / f"{a.name}.json").write_text(json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
