"""Параллельный корпус en-ru из документации Yandex Cloud (CC BY 4.0).

Источник: https://github.com/yandex-cloud/docs, каталоги en/<service> и ru/<service>.
Пары берутся из файлов с одинаковой структурой блоков (заголовки, абзацы, пункты списков).
Сплит train/valid/test по файлам, чтобы страница не попала одновременно в обучение и тест.

    python build_dataset.py --src /path/to/yandex-cloud-docs --out data
"""
import argparse
import hashlib
import json
import random
import re
from pathlib import Path

SERVICES = ["storage", "compute", "vpc", "iam", "managed-postgresql", "functions", "kms"]

VAR = re.compile(r"\{\{\s*([\w.-]+)\s*\}\}")
LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
ANCHOR = re.compile(r"\s*\{#[^}]*\}")
TAG = re.compile(r"\{%.*?%\}")
HTML = re.compile(r"<[^>]+>")
CYR = re.compile(r"[а-яё]", re.I)


def load_presets(path):
    out, section = {}, None
    for line in path.read_text(encoding="utf-8").splitlines():
        if re.match(r"^\S.*:\s*$", line):
            section = line[:-1].strip()
            continue
        m = re.match(r"^  ([\w.-]+):\s*(.*)$", line)
        if m and section == "default":
            out[m.group(1)] = m.group(2).strip().strip("'\"")
    return out


def frontmatter(text):
    meta = {}
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            for line in text[3:end].splitlines():
                m = re.match(r"^(title|description):\s*(.+)$", line)
                if m:
                    meta[m.group(1)] = m.group(2).strip().strip("'\"")
            text = text[end + 4:]
    return meta, text


def blocks(text):
    text = re.sub(r"```.*?```", "\n", text, flags=re.S)
    out = []
    for raw in re.split(r"\n\s*\n", text):
        lines = [ln for ln in raw.splitlines() if ln.strip() and not TAG.fullmatch(ln.strip())]
        if not lines:
            continue
        first = lines[0].lstrip()
        if first.startswith("|") or first.startswith("!["):
            kind = "skip"
        elif first.startswith("#"):
            kind = "h" + str(len(first) - len(first.lstrip("#")))
        elif re.match(r"^([-*]|\d+\.)\s", first):
            kind = "li"
        else:
            kind = "p"
        out.append((kind, " ".join(ln.strip() for ln in lines)))
    return out


def clean(s, presets):
    s = VAR.sub(lambda m: presets.get(m.group(1), m.group(0)), s)
    s = TAG.sub("", s)
    s = LINK.sub(r"\1", s)
    s = ANCHOR.sub("", s)
    s = HTML.sub("", s)
    s = re.sub(r"^(#+|[-*]|\d+\.)\s+", "", s)
    s = s.replace("`", "").replace("**", "").replace("__", "")
    s = re.sub(r"(?<!\w)_(.+?)_(?!\w)", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


def good(en, ru):
    if "{{" in en or "{{" in ru:
        return False
    if not (3 <= len(en) <= 400 and 3 <= len(ru) <= 500):
        return False
    if CYR.search(en) or not CYR.search(ru):
        return False
    r = len(ru) / len(en)
    return 0.6 <= r <= 2.5


def pairs_for(en_file, ru_file, pe, pr):
    me, te = frontmatter(en_file.read_text(encoding="utf-8"))
    mr, tr = frontmatter(ru_file.read_text(encoding="utf-8"))
    out = [(me[k], mr[k]) for k in ("title", "description") if k in me and k in mr]
    be, br = blocks(te), blocks(tr)
    if [k for k, _ in be] == [k for k, _ in br]:
        out += [(a, b) for (k, a), (_, b) in zip(be, br) if k != "skip"]
    return [(clean(a, pe), clean(b, pr)) for a, b in out], len(be) == len(br)


def split_of(rel):
    h = int(hashlib.md5(rel.encode()).hexdigest(), 16) % 100
    return "test" if h < 5 else "valid" if h < 10 else "train"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", default="data")
    a = ap.parse_args()
    src, out = Path(a.src), Path(a.out)
    pe, pr = load_presets(src / "en/presets.yaml"), load_presets(src / "ru/presets.yaml")
    seen, data = set(), {"train": [], "valid": [], "test": []}
    files = aligned = 0
    for svc in SERVICES:
        for ef in sorted((src / "en" / svc).rglob("*.md")):
            rel = ef.relative_to(src / "en").as_posix()
            rf = src / "ru" / rel
            if not rf.exists():
                continue
            files += 1
            ps, ok = pairs_for(ef, rf, pe, pr)
            aligned += ok
            for en, ru in ps:
                if good(en, ru) and en not in seen:
                    seen.add(en)
                    data[split_of(rel)].append({"en": en, "ru": ru, "src": rel})
    out.mkdir(parents=True, exist_ok=True)
    random.seed(0)
    for name, rows in data.items():
        random.shuffle(rows)
        with open(out / f"{name}.jsonl", "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"files={files} aligned={aligned} " + " ".join(f"{k}={len(v)}" for k, v in data.items()))


if __name__ == "__main__":
    main()
