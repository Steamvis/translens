"""Дообучение (fine-tuning) Helsinki-NLP/opus-mt-en-ru на облачной документации.

    python train.py --epochs 3 --out out/opus-mt-en-ru-cloud

Обычный цикл PyTorch: AdamW, линейный warmup/decay, оценка loss на valid после
каждой эпохи, сохраняется лучшая по valid loss эпоха.
"""
import argparse
import json
import math
import os
import random
import time
from pathlib import Path

os.environ.setdefault("PYTORCH_MPS_HIGH_WATERMARK_RATIO", "0.8")
os.environ.setdefault("PYTORCH_MPS_LOW_WATERMARK_RATIO", "0.6")

import torch
from torch.utils.data import DataLoader
from transformers import MarianMTModel, MarianTokenizer, get_linear_schedule_with_warmup

ROOT = Path(__file__).parent
BASE = "Helsinki-NLP/opus-mt-en-ru"


def load(name):
    return [json.loads(l) for l in open(ROOT / "data" / f"{name}.jsonl", encoding="utf-8")]


def collate(tok, max_len):
    def f(rows):
        return tok([r["en"] for r in rows], text_target=[r["ru"] for r in rows], max_length=max_len,
                   truncation=True, padding=True, pad_to_multiple_of=32, return_tensors="pt")
    return f


def mask_pad(batch, pad_id):
    labels = batch["labels"]
    labels[labels == pad_id] = -100
    return batch


def free_mps():
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()


@torch.no_grad()
def valid_loss(model, dl, dev, pad_id):
    free_mps()
    model.eval()
    total = n = 0
    for b in dl:
        b = mask_pad(b, pad_id).to(dev)
        total += model(**b).loss.item() * b["input_ids"].size(0)
        n += b["input_ids"].size(0)
    model.train()
    free_mps()
    return total / n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--bs", type=int, default=16)
    ap.add_argument("--lr", type=float, default=3e-5)
    ap.add_argument("--max-len", type=int, default=128)
    ap.add_argument("--out", default="out/opus-mt-en-ru-cloud")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--base", default=str(ROOT / "base/opus-mt-en-ru") if (ROOT / "base/opus-mt-en-ru").exists() else BASE)
    a = ap.parse_args()

    random.seed(a.seed)
    torch.manual_seed(a.seed)
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = MarianTokenizer.from_pretrained(a.base)
    model = MarianMTModel.from_pretrained(a.base).to(dev)
    model.train()

    train, valid = load("train"), load("valid")
    dl = DataLoader(train, batch_size=a.bs, shuffle=True, collate_fn=collate(tok, a.max_len))
    vdl = DataLoader(valid, batch_size=16, collate_fn=collate(tok, a.max_len))
    steps = a.epochs * len(dl)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    sched = get_linear_schedule_with_warmup(opt, int(0.06 * steps), steps)

    out = ROOT / a.out
    log = {"base": BASE, "args": vars(a), "train_pairs": len(train), "valid_pairs": len(valid), "epochs": []}
    best = valid_loss(model, vdl, dev, tok.pad_token_id)
    log["valid_loss_before"] = round(best, 4)
    print(f"device={dev} train={len(train)} steps={steps} valid_loss_before={best:.4f}", flush=True)

    t0 = time.time()
    for ep in range(1, a.epochs + 1):
        run = 0.0
        for i, b in enumerate(dl, 1):
            b = mask_pad(b, tok.pad_token_id).to(dev)
            loss = model(**b).loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            run += loss.item()
            if i % 50 == 0:
                free_mps()
            if i % 100 == 0:
                print(f"ep{ep} step {i}/{len(dl)} loss={run / 100:.4f} {time.time() - t0:.0f}s", flush=True)
                run = 0.0
        vl = valid_loss(model, vdl, dev, tok.pad_token_id)
        saved = vl < best
        if saved:
            best = vl
            model.save_pretrained(out)
            tok.save_pretrained(out)
        log["epochs"].append({"epoch": ep, "valid_loss": round(vl, 4), "valid_ppl": round(math.exp(vl), 2),
                              "saved": saved, "sec": round(time.time() - t0)})
        print(f"epoch {ep}: valid_loss={vl:.4f} saved={saved}", flush=True)

    out.mkdir(parents=True, exist_ok=True)
    (out / "train_log.json").write_text(json.dumps(log, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
