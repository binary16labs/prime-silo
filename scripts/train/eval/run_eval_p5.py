#!/usr/bin/env python3
"""P5 NLL eval — held-out base-vs-tuned on the LONGVIEW distillation task (gemma-4-E4B).

The GGUF-free primary signal: token-weighted mean NLL over the held-out eval rows
(longview_distill.eval.jsonl — cards EXCLUDED from training), computed with the SAME
format.encode_nll the trainer used, so the base-vs-tuned delta is the fine-tune's own
contribution (not prompt drift). Lower agg_nll = the student better predicts the 12B teacher's
fragments on cards it never saw. Mirrors the house-method T3 instrument.

Run in the upgraded copy venv (D:\gemma4-venv), from a vcvars shell is NOT required (no Triton for a
pure forward), but harmless:
    python scripts/train/eval/run_eval_p5.py --mode base  --out out_p5/base.json
    python scripts/train/eval/run_eval_p5.py --mode tuned --adapter ../qlora/out_p5/adapter --out out_p5/tuned.json
"""
import argparse
import json
import os
import sys
from pathlib import Path

os.environ.setdefault("HF_HOME", r"D:/t3-merge/hf")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch

HERE = Path(__file__).resolve().parent
QLORA = HERE.parent / "qlora"
sys.path.insert(0, str(QLORA))  # reuse format.encode_nll (the SAME module training used)
import format as fmt  # noqa: E402

EVAL_FILE = HERE.parent / "dataset" / "longview_distill" / "longview_distill.eval.jsonl"
BASE_MODEL = os.environ.get("P5_BASE", "unsloth/gemma-4-E4B-it-unsloth-bnb-4bit")
MAX_SEQ = int(os.environ.get("P5_MAX_SEQ", "4096"))  # eval can afford longer than train (no backward)


def load_rows(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["base", "tuned"], required=True)
    ap.add_argument("--adapter", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--eval-file", default=str(EVAL_FILE))
    args = ap.parse_args()
    if args.mode == "tuned" and not args.adapter:
        raise SystemExit("--mode tuned needs --adapter")

    from unsloth import FastModel

    load_name = args.adapter if args.mode == "tuned" else BASE_MODEL  # adapter dir carries its base ref
    model, processor = FastModel.from_pretrained(
        model_name=load_name, max_seq_length=MAX_SEQ, load_in_4bit=True,
        dtype=torch.bfloat16, full_finetuning=False,
    )
    FastModel.for_inference(model)
    tokenizer = getattr(processor, "tokenizer", processor)

    rows = load_rows(args.eval_file)
    total_nll, total_tok, n_rows = 0.0, 0, 0
    with torch.no_grad():
        for r in rows:
            input_ids, labels = fmt.encode_nll(r, tokenizer, MAX_SEQ)
            n_comp = sum(1 for x in labels if x != fmt.IGNORE)
            if n_comp == 0:
                continue
            ii = torch.tensor([input_ids], device="cuda")
            ll = torch.tensor([labels], device="cuda")
            loss = float(model(input_ids=ii, labels=ll).loss)  # mean CE over completion tokens
            total_nll += loss * n_comp
            total_tok += n_comp
            n_rows += 1

    agg_nll = total_nll / total_tok if total_tok else None
    result = {
        "mode": args.mode, "base_model": BASE_MODEL,
        "adapter": args.adapter or None, "eval_file": args.eval_file,
        "rows_scored": n_rows, "completion_tokens": total_tok,
        "agg_nll": round(agg_nll, 6) if agg_nll is not None else None,
        "rag": "disabled", "max_seq": MAX_SEQ,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[eval-p5] {args.mode}: agg_nll={result['agg_nll']} over {n_rows} rows "
          f"({total_tok} completion tokens) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
