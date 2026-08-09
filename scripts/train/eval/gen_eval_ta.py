#!/usr/bin/env python3
"""EP-A tool-use GENERATION eval — does the tuned model pick the right NEXT tool call?

Held-out behavioural-cloning test (sessions EXCLUDED from training): for each eval row we give the
model the transcript-so-far and generate the next tool call, then score it against the call the
corpus ACTUALLY made (the reference trajectory). Non-circular — the reference is real successful
agent behaviour, not a teacher we distilled. Scores, per row:
    valid_json  — emitted a parseable {"name","input"} object
    name_match  — generated tool name == reference tool name (the core signal)
    arg_recall  — fraction of the reference input keys present in the generated call
    quality     — mean(valid_json, name_match, arg_recall)
Keeps BOTH dialects (Claude Code + Antigravity); scored against whichever the session used.

    python gen_eval_ta.py --mode base  --out out_ta/gen-base.json
    python gen_eval_ta.py --mode tuned --adapter ../qlora/out_ta/adapter --out out_ta/gen-tuned.json
    # optional --limit N to sample the first N held-out rows (default: all)
"""
import argparse
import json
import os
import sys
import time
from pathlib import Path

os.environ.setdefault("HF_HOME", r"D:/t3-merge/hf")
os.environ.setdefault("HF_HUB_OFFLINE", "1")

import torch

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE.parent / "qlora"))
import format as fmt  # noqa: E402  same stream-T prompt construction the trainer used

EVAL_ROWS = REPO / "scripts/train/dataset/agent_distill/agent_traces.eval.jsonl"
BASE_MODEL = os.environ.get("P5_BASE", "unsloth/gemma-4-E4B-it-unsloth-bnb-4bit")


def parse_call(text):
    """Extract the first {"name",...} object the model emitted."""
    for cand in (text, text[text.find("{"): text.rfind("}") + 1] if "{" in text and "}" in text else ""):
        try:
            o = json.loads(cand)
            if isinstance(o, dict) and "name" in o:
                return o
        except Exception:
            continue
    return None


def score_call(gen, ref):
    """gen/ref are {"name","input"} dicts; ref is the reference (corpus) call."""
    if not isinstance(gen, dict) or "name" not in gen:
        return dict(valid_json=0, name_match=0, arg_recall=0.0, quality=0.0)
    name_match = 1 if gen.get("name") == ref.get("name") else 0
    ref_in = ref.get("input") if isinstance(ref.get("input"), dict) else {}
    gen_in = gen.get("input") if isinstance(gen.get("input"), dict) else {}
    if not ref_in:
        arg_recall = 1.0 if not gen_in else 1.0  # nothing to recall
    else:
        hit = sum(1 for k in ref_in if k in gen_in)
        arg_recall = hit / len(ref_in)
    # arg_recall only counts when the tool is right (wrong tool -> args are meaningless)
    arg_recall = arg_recall if name_match else 0.0
    quality = (1 + name_match + arg_recall) / 3
    return dict(valid_json=1, name_match=name_match, arg_recall=round(arg_recall, 4),
                quality=round(quality, 4))


def load_rows(limit):
    rows = []
    with open(EVAL_ROWS, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows[:limit] if limit else rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["base", "tuned"], required=True)
    ap.add_argument("--adapter", default="")
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    if args.mode == "tuned" and not args.adapter:
        raise SystemExit("--mode tuned needs --adapter")

    rows = load_rows(args.limit)
    print(f"[ta-gen] {len(rows)} held-out rows")

    from unsloth import FastModel
    load_name = args.adapter if args.mode == "tuned" else BASE_MODEL
    model, processor = FastModel.from_pretrained(model_name=load_name, max_seq_length=4096,
                                                 load_in_4bit=True, dtype=torch.bfloat16,
                                                 full_finetuning=False)
    FastModel.for_inference(model)
    tokenizer = getattr(processor, "tokenizer", processor)

    per = []
    for r in rows:
        user, _ = fmt.build_messages(r)  # stream-T folded prompt
        ids = tokenizer.apply_chat_template([{"role": "user", "content": user}],
                                            add_generation_prompt=True, return_tensors="pt").to("cuda")
        # left-truncate the prompt to fit, mirroring encode_nll (keep the recent context)
        if ids.shape[1] > 4096 - 160:
            ids = ids[:, -(4096 - 160):]
        t0 = time.time()
        with torch.no_grad():
            out = model.generate(input_ids=ids, max_new_tokens=160, do_sample=False,
                                 temperature=None, top_p=None, top_k=None)
        dt = time.time() - t0
        gen = tokenizer.decode(out[0][ids.shape[1]:], skip_special_tokens=True)
        ref = None
        try:
            ref = json.loads(r["response"])
        except Exception:
            continue
        per.append(dict(id=r["id"], sec=round(dt, 3), ref_tool=ref.get("name"),
                        score=score_call(parse_call(gen), ref)))

    n = len(per)
    mean = lambda k: round(sum(p["score"][k] for p in per) / n, 4) if n else 0.0
    result = dict(model=("tuned" if args.mode == "tuned" else "base") + " gemma-4-e4b (tool-use)",
                  mode=args.mode, adapter=args.adapter or None, rows=n,
                  valid_json=mean("valid_json"), name_match=mean("name_match"),
                  arg_recall=mean("arg_recall"), quality=mean("quality"),
                  mean_sec=round(sum(p["sec"] for p in per) / n, 2) if n else 0.0)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[ta-gen] {args.mode}: name_match={result['name_match']} arg_recall={result['arg_recall']} "
          f"quality={result['quality']} -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
