"""BLEU/chrF и точность терминов по TSV (en, hyp, ref) - для результатов ONNX-рантайма.

    python score_tsv.py results/onnx.cloud.tsv
"""
import json
import sys

import sacrebleu

from evaluate import term_accuracy

rows = [l.rstrip("\n").split("\t") for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
srcs, hyps, refs = zip(*rows)
print(json.dumps({
    "n": len(rows),
    "bleu": round(sacrebleu.corpus_bleu(list(hyps), [list(refs)]).score, 2),
    "chrf": round(sacrebleu.corpus_chrf(list(hyps), [list(refs)]).score, 2),
    "terms": term_accuracy(srcs, hyps, refs)["acc"],
}, ensure_ascii=False))
