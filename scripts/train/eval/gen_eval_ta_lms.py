#!/usr/bin/env python3
"""EP-A tool-use GENERATION eval via LM Studio (GGUF / llama.cpp) — eGPU-safe.

model.generate on the gfx1200 eGPU hits the same per-shape Triton recompile crash as the NLL path
(see run_eval_ta_nll.py), so the generation signal goes through the SERVED GGUF instead: llama.cpp
has no Triton recompile hazard and the ladder already proved this path reliable. For each held-out
row we send the stream-T prompt to the loaded model and score the tool call it emits against the one
the corpus actually made — valid_json + name_match + arg_recall (args only count when the tool is
right). Both dialects kept.

Uses system python (no torch) + urllib. Endpoint is ALWAYS localhost — never the LAN host.

    python gen_eval_ta_lms.py --model gemma-4-e4b-agent --out out_ta/gen-tuned.json --limit 300
    python gen_eval_ta_lms.py --model <base-e4b-gguf-id> --out out_ta/gen-base.json --limit 300
"""
import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
sys.path.insert(0, str(HERE.parent / "qlora"))
import format as fmt  # noqa: E402  same stream-T folded prompt

EVAL_FILE = REPO / "scripts/train/dataset/agent_distill/agent_traces.eval.jsonl"
ENDPOINT = "http://localhost:1234/v1/chat/completions"  # LOCAL ONLY — never 192.168.x


def parse_call(text):
    for cand in (text, text[text.find("{"): text.rfind("}") + 1] if "{" in text and "}" in text else ""):
        try:
            o = json.loads(cand)
            if isinstance(o, dict) and "name" in o:
                return o
        except Exception:
            continue
    return None


def score_call(gen, ref):
    if not isinstance(gen, dict) or "name" not in gen:
        return dict(valid_json=0, name_match=0, arg_recall=0.0, quality=0.0)
    name_match = 1 if gen.get("name") == ref.get("name") else 0
    ref_in = ref.get("input") if isinstance(ref.get("input"), dict) else {}
    gen_in = gen.get("input") if isinstance(gen.get("input"), dict) else {}
    arg_recall = (sum(1 for k in ref_in if k in gen_in) / len(ref_in)) if ref_in else 1.0
    arg_recall = arg_recall if name_match else 0.0
    quality = (1 + name_match + arg_recall) / 3
    return dict(valid_json=1, name_match=name_match, arg_recall=round(arg_recall, 4),
                quality=round(quality, 4))


PREFILL = '{"name":"'  # seed the tool call so a clone-only model can't "fail to start"


def chat(model, system, user, prefill=False, retries=2):
    # Split system/user roles — how an agent harness actually calls the model. With prefill we seed
    # the assistant turn with {"name":" so the model MUST complete a tool call: this isolates learned
    # tool SELECTION from the clone-only "failure to start" pathology (greedy decoding emits whitespace
    # to max_tokens on ~half the rows). Without prefill = raw deployment robustness.
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    if prefill:
        msgs.append({"role": "assistant", "content": PREFILL})
    body = json.dumps({
        "model": model, "messages": msgs,
        "temperature": 0, "max_tokens": 200, "stream": False,
    }).encode("utf-8")
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(ENDPOINT, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=120) as r:
                d = json.loads(r.read())
                return d["choices"][0]["message"]["content"]
        except Exception as e:
            if attempt == retries:
                return f"__ERR__ {e}"
            time.sleep(2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="LM Studio modelKey (must be loaded)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=300)
    ap.add_argument("--prefill", action="store_true", help="seed assistant with {\"name\":\" to isolate tool selection")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(EVAL_FILE, encoding="utf-8") if l.strip()]
    if args.limit:
        rows = rows[: args.limit]
    print(f"[ta-gen-lms] model={args.model} endpoint={ENDPOINT} rows={len(rows)}")

    per, errors = [], 0
    for i, r in enumerate(rows):
        t0 = time.time()
        out = chat(args.model, r["system"], r["user"], prefill=args.prefill)
        dt = time.time() - t0
        if out.startswith("__ERR__"):
            errors += 1
            continue
        if args.prefill:
            out = PREFILL + out  # re-attach the seed so the JSON parses whole
        try:
            ref = json.loads(r["response"])
        except Exception:
            continue
        per.append(dict(id=r["id"], sec=round(dt, 3), ref_tool=ref.get("name"),
                        score=score_call(parse_call(out), ref)))
        if (i + 1) % 50 == 0:
            nm = sum(p["score"]["name_match"] for p in per) / len(per)
            print(f"[ta-gen-lms] {i+1}/{len(rows)} running name_match={nm:.3f}", flush=True)

    n = len(per)
    mean = lambda k: round(sum(p["score"][k] for p in per) / n, 4) if n else 0.0
    result = dict(model=args.model, rows=n, errors=errors,
                  valid_json=mean("valid_json"), name_match=mean("name_match"),
                  arg_recall=mean("arg_recall"), quality=mean("quality"),
                  mean_sec=round(sum(p["sec"] for p in per) / n, 2) if n else 0.0)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"[ta-gen-lms] {args.model}: name_match={result['name_match']} arg_recall={result['arg_recall']} "
          f"quality={result['quality']} valid_json={result['valid_json']} ({errors} errors) -> {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
