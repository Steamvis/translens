"""Сравнение базовой и дообученной модели на AWS-фразах, которых нет в датасете.

    python samples.py > results/samples.md
"""
import torch
from transformers import MarianMTModel, MarianTokenizer

SENTENCES = [
    "Create an S3 bucket and upload the static website files.",
    "Launch an EC2 instance in a public subnet and attach a security group that allows HTTP traffic.",
    "The Lambda function is triggered when a new object is uploaded to the bucket.",
    "Use IAM roles to grant the instance access to DynamoDB without storing access keys.",
    "Take a snapshot of the EBS volume before you resize the instance.",
    "The weather is nice today, let's go for a walk in the park.",
]
MODELS = {"base": "base/opus-mt-en-ru", "tuned": "out/opus-mt-en-ru-cloud"}


def run(path):
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    tok = MarianTokenizer.from_pretrained(path)
    model = MarianMTModel.from_pretrained(path).to(dev).eval()
    with torch.no_grad():
        out = model.generate(**tok(SENTENCES, return_tensors="pt", padding=True).to(dev), num_beams=4, max_length=256)
    return tok.batch_decode(out, skip_special_tokens=True)


def main():
    res = {k: run(v) for k, v in MODELS.items()}
    print("| EN | base | tuned |\n|---|---|---|")
    for i, s in enumerate(SENTENCES):
        print(f"| {s} | {res['base'][i]} | {res['tuned'][i]} |")


if __name__ == "__main__":
    main()
