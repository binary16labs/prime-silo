#!/usr/bin/env python3
"""T3 gate — KR1.5's primary instrument.

GREEN iff, on the T2 held-out split with RAG disabled:
  1. base and tuned eval reports both exist and are complete            (else: no_eval)
  2. tuned.agg_nll <= base.agg_nll  (tuned >= base on the frozen rubric) (else: tuned_worse)
  3. the merged adapter exported a GGUF that loads structurally          (else: gguf_missing/
     (valid magic/version, architecture present, tensor count > 0)       gguf_load_fail)

The rubric is frozen in scripts/train/eval/rubric.md (committed with the RED gate). This
gate does NOT recompute the metric — it verifies the recorded honest result. Re-running
the eval harness against the same held-out split reproduces the numbers (deterministic:
NLL under greedy/no-sampling forward passes).

Reason codes: no_eval, tuned_worse, gguf_missing, gguf_load_fail.
Exit 0 = GREEN. Non-zero = RED with a printed reason.
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # scripts/
EVAL_OUT = Path(os.environ.get("T3_EVAL_OUT", ROOT / "train" / "eval" / "out"))
MERGE_MANIFEST = Path(
    os.environ.get("T3_MERGE_MANIFEST", ROOT / "train" / "qlora" / "out" / "merge_manifest.json")
)
GGUF_GLOB_DIR = Path(
    os.environ.get("T3_GGUF_DIR", ROOT / "train" / "qlora" / "out" / "gguf")
)
LLAMA_CPP = Path(
    os.environ.get("LLAMA_CPP_DIR", Path.home() / ".unsloth" / "llama.cpp")
)


def red(reason, msg):
    print(f"[t3] reason={reason} — {msg}")
    print("[t3] GATE RED")
    sys.exit(1)


def load_report(name):
    p = EVAL_OUT / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def require_number(rep, key):
    v = rep.get(key)
    if not isinstance(v, (int, float)) or v != v:  # reject None/NaN
        return None
    return float(v)


def resolve_gguf():
    """Path to the merged GGUF: merge manifest first, then a glob fallback."""
    if MERGE_MANIFEST.exists():
        try:
            man = json.loads(MERGE_MANIFEST.read_text(encoding="utf-8"))
            g = man.get("gguf")
            if g and Path(g).exists():
                return Path(g), man
        except json.JSONDecodeError:
            pass
    if GGUF_GLOB_DIR.exists():
        hits = sorted(GGUF_GLOB_DIR.glob("*.gguf"))
        if hits:
            return hits[0], {}
    return None, {}


def structural_load_gguf(path):
    """Load with the bundled gguf-py reader (same lib llama.cpp/convert use). Proves the
    file a target runtime mmaps: valid GGUF magic/version, architecture KV present, and at
    least one tensor. Returns (arch, n_tensors) or raises."""
    gguf_py = LLAMA_CPP / "gguf-py"
    if str(gguf_py) not in sys.path:
        sys.path.insert(0, str(gguf_py))
    import gguf  # bundled with the ROCm llama.cpp checkout

    reader = gguf.GGUFReader(str(path))
    arch_field = reader.fields.get("general.architecture")
    if arch_field is None:
        raise ValueError("general.architecture missing")
    arch = str(bytes(arch_field.parts[arch_field.data[0]]), "utf-8") if arch_field.data else "?"
    n_tensors = len(reader.tensors)
    if n_tensors <= 0:
        raise ValueError("no tensors in GGUF")
    return arch, n_tensors


def main():
    base = load_report("base.json")
    tuned = load_report("tuned.json")
    if base is None or tuned is None:
        missing = [n for n, r in (("base.json", base), ("tuned.json", tuned)) if r is None]
        red("no_eval", f"eval report(s) missing/unreadable in {EVAL_OUT}: {missing}. "
                       f"Run scripts/train/eval/run_eval.py for base and tuned first.")

    base_agg = require_number(base, "agg_nll")
    tuned_agg = require_number(tuned, "agg_nll")
    if base_agg is None or tuned_agg is None:
        red("no_eval", "agg_nll missing/NaN in a report (incomplete eval).")

    # per-category deltas (base - tuned; positive = tuned improved) for transparency
    def cat(rep, k):
        return require_number(rep.get(k, {}) if isinstance(rep.get(k), dict) else {}, "nll")

    a_base, a_tuned = cat(base, "A"), cat(tuned, "A")
    b_base, b_tuned = cat(base, "B"), cat(tuned, "B")

    print(f"[t3] base  agg_nll={base_agg:.4f}  A={a_base}  B={b_base}")
    print(f"[t3] tuned agg_nll={tuned_agg:.4f}  A={a_tuned}  B={b_tuned}")
    print(f"[t3] delta agg_nll (base-tuned) = {base_agg - tuned_agg:+.4f} "
          f"(positive = tuned better)")
    tb = tuned.get("B", {}).get("toolname_match", {})
    bb = base.get("B", {}).get("toolname_match", {})
    print(f"[t3] tool-name match: base={bb.get('rate')} tuned={tb.get('rate')} (secondary)")

    if tuned_agg > base_agg:
        red("tuned_worse",
            f"tuned agg_nll {tuned_agg:.4f} > base {base_agg:.4f} — the fine-tune did NOT "
            f"beat base on the frozen rubric. Honest result: log it, do not tune the rubric.")

    gguf_path, man = resolve_gguf()
    if gguf_path is None:
        red("gguf_missing", f"no merged GGUF found (manifest {MERGE_MANIFEST} or {GGUF_GLOB_DIR}/*.gguf).")
    try:
        arch, n_tensors = structural_load_gguf(gguf_path)
    except Exception as e:  # noqa: BLE001 — any load failure is a RED with the message
        red("gguf_load_fail", f"{gguf_path.name} did not load: {type(e).__name__}: {e}")

    print(f"[t3] gguf: {gguf_path.name} loads — arch={arch}, tensors={n_tensors}"
          + (f", llama-server smoke={man.get('llama_server_load')}" if man.get('llama_server_load') is not None else ""))
    print("[t3] GATE GREEN")
    sys.exit(0)


if __name__ == "__main__":
    main()
