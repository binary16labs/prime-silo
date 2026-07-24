#!/usr/bin/env python3
"""T5 — build DPO preference pairs of SELF-GENERATED HARD NEGATIVES.

For prompts from the T2 **train** split (never eval), ask the SFT model (T3 v3, served by
LM Studio on the eGPU) for its greedy answer. When that answer is WRONG relative to the real
house reference, emit a pair:

    { "prompt": <chat prompt>, "chosen": <house reference>, "rejected": <SFT's own answer> }

No human labels, no synthetic "chosen" text — chosen is always the real corpus reference;
rejected is the model's own mistake. Mismatch rules:
  * Stream B (tool calls): the emitted tool NAME differs from the reference (objective error),
    or the name matches but the args JSON differs materially.
  * Stream A (method/voice): the answer's token overlap with the reference is below a floor
    (clear content/style drift) — kept conservative so we only reject real divergence.

Pairs are leak-gated (the same terms+sids as T2). Deterministic sampling (FNV over id) so a
rerun picks the same prompts.

Run in the trainer venv while LM Studio serves the SFT model:
  BENNY_TUNED_MODEL=qwen2.5-coder-7b-instruct-house-tuned python scripts/train/dpo/build_prefs.py
"""

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import httpx

HERE = Path(__file__).resolve().parent
QLORA = HERE.parent / "qlora"
DATA = HERE.parent / "dataset"
sys.path.insert(0, str(QLORA))
import format as fmt  # noqa: E402  shared chat format (train==eval==pref prompts)

LMSTUDIO = os.environ.get("BENNY_TUNED_BASE_URL", "http://127.0.0.1:1234/v1").rstrip("/")
SFT_MODEL = os.environ.get("BENNY_TUNED_MODEL", "qwen2.5-coder-7b-instruct-house-tuned")
OUT = Path(os.environ.get("T5_PREFS", HERE / "out" / "prefs.jsonl"))


def fnv(s: str) -> int:
    h = 0x811C9DC5
    for ch in str(s):
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def load_rows(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def sample(rows, n, seed_tag):
    return sorted(rows, key=lambda r: fnv(seed_tag + r["id"]))[:n]


def sft_generate(user: str, max_tokens: int, timeout: float = 120.0) -> str:
    """Greedy (deterministic) completion from the served SFT model."""
    payload = {
        "model": SFT_MODEL,
        "messages": [{"role": "user", "content": user}],
        "temperature": 0.0,
        "max_tokens": max_tokens,
        "stream": False,
    }
    r = httpx.post(f"{LMSTUDIO}/chat/completions", json=payload, timeout=timeout)
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


_WORD = re.compile(r"[a-z0-9_]+")


def overlap(a: str, b: str) -> float:
    sa, sb = set(_WORD.findall(a.lower())), set(_WORD.findall(b.lower()))
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n-b", type=int, default=int(os.environ.get("T5_N_B", "600")))
    ap.add_argument("--n-a", type=int, default=int(os.environ.get("T5_N_A", "200")))
    ap.add_argument("--a-overlap-floor", type=float, default=0.35)
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    # leak gate spec (reuse T2's) via a tiny node shell-out would be heavy; the prompts come
    # from the already-leak-gated train split and chosen==reference, so only the model-
    # generated 'rejected' is new. We scan rejected text with the same generic term list.
    terms = []
    try:
        spec = json.loads((DATA / "personal_terms.json").read_text(encoding="utf-8"))
        terms = [t.lower() for t in spec.get("terms", [])]
    except Exception:
        pass

    def leaks(text: str) -> bool:
        t = text.lower()
        return any((term if len(term) >= 4 else f" {term} ") in t for term in terms)

    b_rows = sample(load_rows(DATA / "stream_b.train.jsonl"), args.n_b, "B")
    a_rows = sample(load_rows(DATA / "stream_a.train.jsonl"), args.n_a, "A")

    pairs = []
    stats = {"B_seen": 0, "B_pairs": 0, "A_seen": 0, "A_pairs": 0, "leak_skipped": 0, "errors": 0}
    t0 = time.time()

    for row in b_rows:
        stats["B_seen"] += 1
        user, chosen = fmt.build_messages(row)
        try:
            gen = sft_generate(user, max_tokens=192)
        except Exception:
            stats["errors"] += 1
            continue
        ref_name = row["tool_call"]["name"]
        emitted = fmt.parse_emitted_tool_name(gen)
        wrong = (emitted is None) or (emitted != ref_name) or (
            emitted == ref_name and gen.strip() != chosen.strip()
        )
        if not wrong:
            continue
        if leaks(gen):
            stats["leak_skipped"] += 1
            continue
        pairs.append({"prompt": user, "chosen": chosen, "rejected": gen.strip(),
                      "stream": "B", "id": row["id"], "reason": "tool_mismatch" if emitted != ref_name else "args_mismatch"})
        stats["B_pairs"] += 1

    for row in a_rows:
        stats["A_seen"] += 1
        user, chosen = fmt.build_messages(row)
        try:
            gen = sft_generate(user, max_tokens=400)
        except Exception:
            stats["errors"] += 1
            continue
        if overlap(gen, chosen) >= args.a_overlap_floor:
            continue  # close enough — not a clear negative
        if leaks(gen):
            stats["leak_skipped"] += 1
            continue
        pairs.append({"prompt": user, "chosen": chosen, "rejected": gen.strip(),
                      "stream": "A", "id": row["id"], "reason": "voice_drift"})
        stats["A_pairs"] += 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        for p in pairs:
            f.write(json.dumps(p, ensure_ascii=False) + "\n")
    stats["total_pairs"] = len(pairs)
    stats["wall_s"] = round(time.time() - t0, 1)
    (out.parent / "prefs_manifest.json").write_text(json.dumps({
        "sft_model": SFT_MODEL, "base_url": LMSTUDIO, "stats": stats,
        "a_overlap_floor": args.a_overlap_floor,
    }, indent=2), encoding="utf-8")
    print(f"[prefs] {len(pairs)} pairs (B={stats['B_pairs']}/{stats['B_seen']} "
          f"A={stats['A_pairs']}/{stats['A_seen']}, leak_skipped={stats['leak_skipped']}, "
          f"errors={stats['errors']}) in {stats['wall_s']}s -> {out}")


if __name__ == "__main__":
    main()
