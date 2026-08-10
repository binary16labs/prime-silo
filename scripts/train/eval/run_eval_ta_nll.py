#!/usr/bin/env python3
"""EP-A tool-use NLL eval — held-out base-vs-tuned, FIXED-SHAPE (eGPU-safe).

Same token-weighted agg-NLL signal as run_eval_p5.py, but every row is padded to a CONSTANT length
(attention_mask=0 + labels=IGNORE on the pad). Why: the gfx1200 eGPU HIP path CRASHES (0xC0000005 in
memcpy_and_sync) when Triton recompiles a kernel per new sequence length — variable-length rows trigger
a recompile each row and one wedges the card. A single fixed shape compiles ONE kernel (first row ~20s,
rest ~0.7s) and runs clean. Verified: 25 rows incl. the row that hung at variable-shape all pass.

Lower agg_nll = the student better predicts the corpus's next tool call on held-out sessions.

    python run_eval_ta_nll.py --mode base  --out out_ta/base.json
    python run_eval_ta_nll.py --mode tuned --adapter ../qlora/out_ta/adapter --out out_ta/tuned.json
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
sys.path.insert(0, str(HERE.parent / "qlora"))
import format as fmt  # noqa: E402  same encode_nll the trainer used (dispatches on stream T)

EVAL_FILE = HERE.parent / "dataset" / "agent_distill" / "agent_traces.eval.jsonl"
BASE_MODEL = os.environ.get("P5_BASE", "unsloth/gemma-4-E4B-it-unsloth-bnb-4bit")
PAD = int(os.environ.get("TA_PAD", "2048"))  # fixed shape; covers ~p90 of rows, tail left-truncated


def load_rows(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["base", "tuned"], required=True)
    ap.add_argument("--adapter", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--eval-file", default=str(EVAL_FILE))
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    if args.mode == "tuned" and not args.adapter:
        raise SystemExit("--mode tuned needs --adapter")

    from unsloth import FastModel
    load_name = args.adapter if args.mode == "tuned" else BASE_MODEL
    model, processor = FastModel.from_pretrained(
        model_name=load_name, max_seq_length=PAD, load_in_4bit=True,
        dtype=torch.bfloat16, full_finetuning=False,
    )
    FastModel.for_inference(model)
    tokenizer = getattr(processor, "tokenizer", processor)
    pad_id = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else 0

    rows = load_rows(args.eval_file)
    if args.limit:
        rows = rows[: args.limit]
    total_nll, total_tok, n_rows, truncated = 0.0, 0, 0, 0
    with torch.no_grad():
        for r in rows:
            ids, labels = fmt.encode_nll(r, tokenizer, PAD)
            if len(ids) >= PAD:
                truncated += 1
            ids, labels = ids[:PAD], labels[:PAD]
            n_comp = sum(1 for x in labels if x != fmt.IGNORE)
            if n_comp == 0:
                continue
            padn = PAD - len(ids)
            ii = torch.tensor([ids + [pad_id] * padn], device="cuda")
            am = torch.tensor([[1] * len(ids) + [0] * padn], device="cuda")
            ll = torch.tensor([labels + [fmt.IGNORE] * padn], device="cuda")
            loss = float(model(input_ids=ii, attention_mask=am, labels=ll).loss)  # mean CE over completion
            total_nll += loss * n_comp
            total_tok += n_comp
            n_rows += 1
            if n_rows % 250 == 0:
                print(f"[ta-nll] {args.mode}: {n_rows}/{len(rows)} rows, running agg={total_nll/total_tok:.4f}", flush=True)

    agg = total_nll / total_tok if total_tok else None
    result = {"mode": args.mode, "base_model": BASE_MODEL, "adapter": args.adapter or None,
              "eval_file": args.eval_file, "pad": PAD, "rows_scored": n_rows,
              "completion_tokens": total_tok, "truncated": truncated,
              "agg_nll": round(agg, 6) if agg is not None else None}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[ta-nll] {args.mode}: agg_nll={result['agg_nll']} over {n_rows} rows "
          f"({total_tok} comp tok, {truncated} truncated) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
