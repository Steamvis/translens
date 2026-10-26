"""Экспорт дообученной модели в ONNX для transformers.js (запуск в расширении).

    ../ml/.venv-export/bin/python export_onnx.py

Отдельное окружение .venv-export: optimum-onnx требует transformers<4.58.
Результат: ../models/opus-mt-en-ru-cloud/ (config, tokenizer.json, onnx/*_quantized.onnx).
Токенизатор при дообучении не меняется, tokenizer.json берётся у Xenova/opus-mt-en-ru
(та же базовая модель, сконвертированная под transformers.js).
"""
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

from onnxruntime.quantization import QuantType, quantize_dynamic

ROOT = Path(__file__).parent
SRC = ROOT / "out/opus-mt-en-ru-cloud"
TMP = ROOT / "out/onnx-fp32"
DST = ROOT.parent / "models/opus-mt-en-ru-cloud"
XENOVA = "https://huggingface.co/Xenova/opus-mt-en-ru/resolve/main/"


def main():
    subprocess.run([sys.executable, "-m", "optimum.exporters.onnx", "--model", str(SRC),
                    "--task", "text2text-generation-with-past", str(TMP)], check=True)
    (DST / "onnx").mkdir(parents=True, exist_ok=True)
    for name in ("encoder_model", "decoder_model_merged"):
        quantize_dynamic(TMP / f"{name}.onnx", DST / "onnx" / f"{name}_quantized.onnx", weight_type=QuantType.QInt8,
                         extra_options={"EnableSubgraph": True})
    for f in ("config.json", "generation_config.json"):
        shutil.copy(SRC / f, DST / f)
    for f in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"):
        urllib.request.urlretrieve(XENOVA + f, DST / f)
    for p in sorted(DST.rglob("*")):
        if p.is_file():
            print(f"{p.stat().st_size / 1e6:8.1f} MB  {p.relative_to(DST)}")


if __name__ == "__main__":
    main()
