#!/usr/bin/env python3
"""P5 GENERATION eval — the ladder payoff, GGUF-free.

Does the tuned E4B actually GENERATE better fragments than base E4B (not just lower NLL), at E4B
speed? Runs on the held-out eval-p5-gen cards. For base-E4B and tuned-E4B we generate the fragment
via FastModel and score it. For the 12B we DON'T re-serve it — its fragments already exist on disk
(the teacher output the corpus was built from) and its per-card wall time is in the card meta — so we
score the stored fragment and read the recorded ms. Same non-circular rubric as the ladder
(fragment_score.mjs): schema validity + field coverage + within-0-4 bounds. Speed + tokens measured.

    python gen_eval_p5.py --mode base  --out out_p5/gen-base.json
    python gen_eval_p5.py --mode tuned --adapter ../qlora/out_p5/adapter --out out_p5/gen-tuned.json
    # 12B teacher baseline (stored fragments + recorded timing) is written by either run to gen-teacher.json
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
import format as fmt  # noqa: E402  same prompt construction (stream L folds system into user)

WDIR = Path(r"D:/benny-home/benny/workspaces/sessions_v1/longview/windows")
CDIR = Path(r"D:/benny-home/benny/workspaces/sessions_v1/longview/cards")
GEN_SAMPLE = REPO / "scripts/train/dataset/longview_distill/eval-p5-gen.json"
EVAL_ROWS = REPO / "scripts/train/dataset/longview_distill/longview_distill.eval.jsonl"
BASE_MODEL = os.environ.get("P5_BASE", "unsloth/gemma-4-E4B-it-unsloth-bnb-4bit")

ARRAY_FIELDS = ["decisions", "outcomes", "failures", "capabilities", "applications", "artifacts",
                "concepts", "skills_observed", "operator_traits", "open_threads", "proposed_next", "evidence"]
ALL_FIELDS = ["project"] + ARRAY_FIELDS


def parse_fragment(text):
    for cand in (text, text[text.find("{"): text.rfind("}") + 1] if "{" in text and "}" in text else ""):
        try:
            return json.loads(cand)
        except Exception:
            continue
    return None


def score_fragment(frag):
    if not isinstance(frag, dict):
        return dict(valid_json=0, keys_present=0, within_bounds=0, coverage=0, quality=0.0)
    present = sum(1 for k in ALL_FIELDS if k in frag) / len(ALL_FIELDS)
    bound_ok = 1 if isinstance(frag.get("project", ""), str) else 0
    bound_tot = 1
    for k in ARRAY_FIELDS:
        bound_tot += 1
        v = frag.get(k)
        if isinstance(v, list) and len(v) <= 4 and all(isinstance(s, str) for s in v):
            bound_ok += 1
    within = bound_ok / bound_tot
    covered = sum(1 for k in ARRAY_FIELDS
                  if isinstance(frag.get(k), list) and any(isinstance(s, str) and s.strip() for s in frag[k]))
    coverage = covered / len(ARRAY_FIELDS)
    quality = (1 + present + within + coverage) / 4
    return dict(valid_json=1, keys_present=round(present, 4), within_bounds=round(within, 4),
                coverage=round(coverage, 4), quality=round(quality, 4))


def load_eval_windows():
    """window text + stored 12B fragment for each eval-p5-gen (sid, window) from the eval rows."""
    gen_sids = set(json.load(open(GEN_SAMPLE, encoding="utf-8"))["sids"])
    items = []
    with open(EVAL_ROWS, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            r = json.loads(line)
            if r["source"] in gen_sids:
                items.append(r)
    return items, gen_sids


def teacher_baseline(items, gen_sids):
    """12B: score its stored fragments; read recorded per-card wall from meta.json."""
    per = []
    for r in items:
        frag = json.loads(r["response"])  # the stored 12B fragment
        per.append(dict(id=r["id"], score=score_fragment(frag)))
    # per-card recorded wall (12B): meta.json ms / n_windows
    walls = []
    for sid in gen_sids:
        m = json.loads((CDIR / f"{sid}.meta.json").read_text(encoding="utf-8"))
        nw = len(json.load(open(WDIR / sid / "manifest.json", encoding="utf-8")).get("windows", [])) or 1
        walls.append(m.get("ms", 0) / 1000.0 / nw)  # sec/window
    n = len(per)
    mean = lambda key: round(sum(p["score"][key] for p in per) / n, 4)
    return dict(model="google/gemma-4-12b (stored teacher)", windows=n,
                quality_score=mean("quality"), coverage=mean("coverage"), valid_json=mean("valid_json"),
                mean_sec_per_window=round(sum(walls) / len(walls), 2))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["base", "tuned"], required=True)
    ap.add_argument("--adapter", default="")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    items, gen_sids = load_eval_windows()
    print(f"[gen] eval-p5-gen: {len(gen_sids)} sids, {len(items)} windows")

    # 12B teacher baseline (model-independent; write once)
    teacher = teacher_baseline(items, gen_sids)
    (Path(args.out).parent / "gen-teacher.json").write_text(json.dumps(teacher, indent=2), encoding="utf-8")

    from unsloth import FastModel
    load_name = args.adapter if args.mode == "tuned" else BASE_MODEL
    model, processor = FastModel.from_pretrained(model_name=load_name, max_seq_length=5120,
                                                 load_in_4bit=True, dtype=torch.bfloat16, full_finetuning=False)
    FastModel.for_inference(model)
    tokenizer = getattr(processor, "tokenizer", processor)

    per = []
    for r in items:
        user, _ = fmt.build_messages(r)  # stream L folded prompt (system + slice)
        ids = tokenizer.apply_chat_template([{"role": "user", "content": user}],
                                            add_generation_prompt=True, return_tensors="pt").to("cuda")
        t0 = time.time()
        with torch.no_grad():
            out = model.generate(input_ids=ids, max_new_tokens=512, do_sample=False,
                                 temperature=None, top_p=None, top_k=None)
        dt = time.time() - t0
        gen = tokenizer.decode(out[0][ids.shape[1]:], skip_special_tokens=True)
        frag = parse_fragment(gen)
        per.append(dict(id=r["id"], sec=round(dt, 3), new_tokens=int(out.shape[1] - ids.shape[1]),
                        score=score_fragment(frag)))
        print(f"[gen]  {r['id']}: {dt:.1f}s q={per[-1]['score']['quality']} cov={per[-1]['score']['coverage']}")

    n = len(per)
    mean = lambda key: round(sum(p["score"][key] for p in per) / n, 4)
    result = dict(model=("tuned" if args.mode == "tuned" else "base") + " google/gemma-4-e4b",
                  mode=args.mode, adapter=args.adapter or None, windows=n,
                  quality_score=mean("quality"), coverage=mean("coverage"),
                  valid_json=mean("valid_json"), keys_present=mean("keys_present"),
                  within_bounds=mean("within_bounds"),
                  mean_sec_per_window=round(sum(p["sec"] for p in per) / n, 2),
                  total_sec=round(sum(p["sec"] for p in per), 1))
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[gen] {args.mode}: q={result['quality_score']} cov={result['coverage']} "
          f"{result['mean_sec_per_window']}s/win -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
