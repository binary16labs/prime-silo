#!/usr/bin/env python3
"""T3 eval harness — the KR1.5 instrument. Deterministic, judge-free, network-free,
RAG disabled. Scores a model (base or LoRA-tuned) on the T2 held-out split:

  primary  : held-out NLL (cross-entropy on the reference completion, prompt masked)
             per category A / B and token-weighted aggregate `agg_nll`
  secondary: Stream B tool-name exact-match under greedy decode

Eager path (transformers + peft + bitsandbytes, torchao stubbed) so it runs without the
Triton/vcvars toolchain — a forward pass and greedy decode need no fused kernels. Batch
size 1 (parallelism-1 infra rule).

Usage:
  python run_eval.py --mode base  --out out/base.json
  python run_eval.py --mode tuned --adapter ../qlora/out/adapter --out out/tuned.json
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

HERE = Path(__file__).resolve().parent
QLORA = HERE.parent / "qlora"
sys.path.insert(0, str(QLORA))

import torchao_stub  # noqa: F401  (installs the inert torchao meta-path stub)
import torch  # noqa: E402
from transformers import AutoModelForCausalLM, AutoTokenizer  # noqa: E402

import format as fmt  # noqa: E402  (scripts/train/qlora/format.py — shared with training)

DEFAULT_BASE = os.environ.get("T3_BASE", "unsloth/Qwen2.5-Coder-7B-Instruct-bnb-4bit")
DATA_DIR = HERE.parent / "dataset"


def load_rows(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def load_model(mode, base, adapter):
    tok_src = adapter if (mode == "tuned" and adapter) else base
    tokenizer = AutoTokenizer.from_pretrained(tok_src)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    model = AutoModelForCausalLM.from_pretrained(
        base,
        device_map={"": 0},
        torch_dtype=torch.float16,
    )
    if mode == "tuned":
        if not adapter:
            raise SystemExit("--adapter is required for --mode tuned")
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter)
    model.eval()
    return model, tokenizer


@torch.no_grad()
def nll_for_rows(model, tokenizer, rows, max_len):
    """Return (nll_sum, token_count) accumulated over rows (prompt tokens masked)."""
    device = model.device
    nll_sum = 0.0
    n_tokens = 0
    for row in rows:
        input_ids, labels = fmt.encode_nll(row, tokenizer, max_len)
        ids = torch.tensor([input_ids], device=device)
        lab = torch.tensor([labels], device=device)
        logits = model(ids).logits
        # standard causal shift: predict token t+1 from position t
        shift_logits = logits[:, :-1, :].float()
        shift_labels = lab[:, 1:]
        loss = torch.nn.functional.cross_entropy(
            shift_logits.reshape(-1, shift_logits.size(-1)),
            shift_labels.reshape(-1),
            ignore_index=fmt.IGNORE,
            reduction="sum",
        )
        cnt = int((shift_labels != fmt.IGNORE).sum().item())
        if cnt > 0:
            nll_sum += float(loss.item())
            n_tokens += cnt
    return nll_sum, n_tokens


@torch.no_grad()
def toolname_match(model, tokenizer, rows, max_new_tokens=64):
    """Greedy-decode the next tool call; fraction whose emitted name == reference name."""
    device = model.device
    hits = 0
    evaluated = 0
    for row in rows:
        ref = fmt.ref_tool_name(row)
        if ref is None:
            continue
        evaluated += 1
        p_ids = fmt.prompt_ids(row, tokenizer)
        ids = torch.tensor([p_ids], device=device)
        out = model.generate(
            ids,
            max_new_tokens=max_new_tokens,
            do_sample=False,
            num_beams=1,
            pad_token_id=tokenizer.pad_token_id,
        )
        gen = out[0][len(p_ids):]
        text = tokenizer.decode(gen, skip_special_tokens=True)
        emitted = fmt.parse_emitted_tool_name(text)
        if emitted is not None and emitted == ref:
            hits += 1
    rate = (hits / evaluated) if evaluated else 0.0
    return rate, hits, evaluated


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["base", "tuned"], required=True)
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--adapter", default=None)
    ap.add_argument("--data-dir", default=str(DATA_DIR))
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-len", type=int, default=2048)
    ap.add_argument("--no-gen-match", action="store_true",
                    help="skip the (slower) greedy tool-name generation metric")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    a_rows = load_rows(data_dir / "stream_a.eval.jsonl")
    b_rows = load_rows(data_dir / "stream_b.eval.jsonl")

    t0 = time.time()
    model, tokenizer = load_model(args.mode, args.base, args.adapter)
    dev = torch.cuda.get_device_properties(0)
    load_s = time.time() - t0

    t1 = time.time()
    a_sum, a_tok = nll_for_rows(model, tokenizer, a_rows, args.max_len)
    b_sum, b_tok = nll_for_rows(model, tokenizer, b_rows, args.max_len)
    a_nll = a_sum / a_tok if a_tok else float("nan")
    b_nll = b_sum / b_tok if b_tok else float("nan")
    agg_nll = (a_sum + b_sum) / (a_tok + b_tok) if (a_tok + b_tok) else float("nan")

    match = {"rate": None, "hits": None, "evaluated": None}
    if not args.no_gen_match:
        rate, hits, ev = toolname_match(model, tokenizer, b_rows)
        match = {"rate": rate, "hits": hits, "evaluated": ev}
    eval_s = time.time() - t1

    report = {
        "mode": args.mode,
        "base": args.base,
        "adapter": args.adapter,
        "max_len": args.max_len,
        "rag": "disabled",
        "device": {"name": dev.name, "arch": dev.gcnArchName,
                   "vram_gib": round(dev.total_memory / 1024**3, 2)},
        "A": {"rows": len(a_rows), "tokens": a_tok, "nll": a_nll},
        "B": {"rows": len(b_rows), "tokens": b_tok, "nll": b_nll,
              "toolname_match": match},
        "agg_nll": agg_nll,
        "aggregate": (-agg_nll if agg_nll == agg_nll else None),  # -NLL; higher is better
        "timing_s": {"load": round(load_s, 1), "eval": round(eval_s, 1)},
    }
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"[eval:{args.mode}] A_nll={a_nll:.4f} B_nll={b_nll:.4f} "
          f"agg_nll={agg_nll:.4f} toolname_match={match['rate']} -> {out_path}")


if __name__ == "__main__":
    main()
