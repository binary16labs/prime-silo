#!/usr/bin/env python3
"""T5 gate — DPO beats its SFT parent on the frozen instrument, honestly.

GREEN iff:
  1. preference pairs exist and are self-generated hard negatives         (else: no_prefs)
     (chosen==corpus reference, rejected==the SFT model's own answer)
  2. SFT and DPO eval reports exist on the SAME held-out split, RAG off   (else: no_eval)
  3. dpo.agg_nll <= sft.agg_nll  (DPO >= SFT on the rubric aggregate)      (else: dpo_worse)
  4. the merged DPO adapter exported a GGUF that loads                     (else: gguf_missing/
                                                                            gguf_load_fail)

Same instrument as T3 (held-out NLL + tool-name match, frozen rubric). This gate verifies
the recorded honest result — a DPO run that does not beat SFT is a valid logged outcome.

Reason codes: no_prefs, no_eval, dpo_worse, gguf_missing, gguf_load_fail.
Exit 0 = GREEN. Non-zero = RED with a printed reason.
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # scripts/
EVAL_OUT = Path(os.environ.get("T5_EVAL_OUT", ROOT / "train" / "eval" / "out" / "t5"))
PREFS = Path(os.environ.get("T5_PREFS", ROOT / "train" / "dpo" / "out" / "prefs.jsonl"))
PREFS_MANIFEST = Path(os.environ.get("T5_PREFS_MANIFEST", ROOT / "train" / "dpo" / "out" / "prefs_manifest.json"))
MERGE_MANIFEST = Path(os.environ.get("T5_MERGE_MANIFEST", ROOT / "train" / "dpo" / "out" / "merge_manifest.json"))
GGUF_GLOB_DIR = Path(os.environ.get("T5_GGUF_DIR", ROOT / "train" / "dpo" / "out" / "gguf"))
LLAMA_CPP = Path(os.environ.get("LLAMA_CPP_DIR", Path.home() / ".unsloth" / "llama.cpp"))


def red(reason, msg):
    print(f"[t5] reason={reason} — {msg}")
    print("[t5] GATE RED")
    sys.exit(1)


def load_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return None


def num(rep, key):
    v = (rep or {}).get(key)
    return float(v) if isinstance(v, (int, float)) and v == v else None


def main():
    # 1. preference pairs — real self-generated hard negatives
    if not PREFS.exists():
        red("no_prefs", f"preference file missing at {PREFS}")
    pairs = [json.loads(l) for l in open(PREFS, encoding="utf-8") if l.strip()]
    if len(pairs) < 10:
        red("no_prefs", f"only {len(pairs)} preference pairs — too few to DPO honestly")
    bad = [p for p in pairs if not (p.get("chosen") and p.get("rejected") and p["chosen"].strip() != p["rejected"].strip())]
    if bad:
        red("no_prefs", f"{len(bad)} pairs where chosen==rejected or empty — not real negatives")
    man = load_json(PREFS_MANIFEST) or {}
    print(f"[t5] prefs: {len(pairs)} hard-negative pairs "
          f"(chosen=corpus reference, rejected=SFT self-generated); model={man.get('sft_model')}")

    # 2. SFT vs DPO on the same instrument
    sft = load_json(EVAL_OUT / "sft.json")
    dpo = load_json(EVAL_OUT / "dpo.json")
    if sft is None or dpo is None:
        missing = [n for n, r in (("sft.json", sft), ("dpo.json", dpo)) if r is None]
        red("no_eval", f"eval report(s) missing in {EVAL_OUT}: {missing}")
    sft_agg, dpo_agg = num(sft, "agg_nll"), num(dpo, "agg_nll")
    if sft_agg is None or dpo_agg is None:
        red("no_eval", "agg_nll missing/NaN in an eval report")

    print(f"[t5] SFT agg_nll={sft_agg:.4f}  A={num(sft.get('A',{}),'nll')}  B={num(sft.get('B',{}),'nll')}")
    print(f"[t5] DPO agg_nll={dpo_agg:.4f}  A={num(dpo.get('A',{}),'nll')}  B={num(dpo.get('B',{}),'nll')}")
    print(f"[t5] delta agg_nll (SFT-DPO) = {sft_agg - dpo_agg:+.4f} (positive = DPO better)")
    st, dt = sft.get("B", {}).get("toolname_match", {}), dpo.get("B", {}).get("toolname_match", {})
    print(f"[t5] tool-name match: SFT={st.get('rate')} DPO={dt.get('rate')} (secondary)")

    if dpo_agg > sft_agg:
        red("dpo_worse",
            f"DPO agg_nll {dpo_agg:.4f} > SFT {sft_agg:.4f} — preference tuning did NOT beat SFT. "
            f"Honest result: log it, do not tune the rubric.")

    # 3. merged DPO GGUF loads
    gguf_path = None
    m = load_json(MERGE_MANIFEST)
    if m and m.get("gguf") and Path(m["gguf"]).exists():
        gguf_path = Path(m["gguf"])
    elif GGUF_GLOB_DIR.exists():
        hits = sorted(GGUF_GLOB_DIR.glob("*.gguf")) + sorted((GGUF_GLOB_DIR.parent / (GGUF_GLOB_DIR.name + "_gguf")).glob("*.gguf"))
        gguf_path = hits[0] if hits else None
    if gguf_path is None:
        red("gguf_missing", f"no merged DPO GGUF (manifest {MERGE_MANIFEST} or {GGUF_GLOB_DIR})")
    gguf_py = LLAMA_CPP / "gguf-py"
    if str(gguf_py) not in sys.path:
        sys.path.insert(0, str(gguf_py))
    try:
        import gguf
        reader = gguf.GGUFReader(str(gguf_path))
        arch_f = reader.fields.get("general.architecture")
        arch = str(bytes(arch_f.parts[arch_f.data[0]]), "utf-8") if arch_f and arch_f.data else "?"
        n = len(reader.tensors)
        if n <= 0:
            raise ValueError("no tensors")
    except Exception as e:  # noqa: BLE001
        red("gguf_load_fail", f"{Path(gguf_path).name}: {type(e).__name__}: {e}")

    print(f"[t5] gguf: {Path(gguf_path).name} loads — arch={arch}, tensors={n}"
          + (f", llama_server_load={m.get('llama_server_load')}" if m and m.get('llama_server_load') is not None else ""))
    print("[t5] GATE GREEN")
    sys.exit(0)


if __name__ == "__main__":
    main()
