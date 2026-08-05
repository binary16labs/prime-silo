"""Fold the REAL Rung-1 window_fragment results into a bench report (P2/P3 machinery).

Rung 1 of the ladder (P4 = rung 0). The LONGVIEW map primitive — window_fragment extraction — run
on the locked sample by the REAL path (rung1_bench.mjs drives scripts/longview/lib chat() with the
production prompt). Baseline is the model LONGVIEW actually runs, google/gemma-4-12b; candidate is
google/gemma-4-e4b. The owner's question: is the smaller model faster AND still good enough?

Primary metric: authoring.wall_seconds (lower is better) — the "faster outcome" the ladder tests.
But speed alone must never crown a winner: quality_score (a model-neutral fragment-quality composite,
NOT a match against the 12B's own stored output) is carried on every record and the gate refuses a
speed verdict when the faster model's quality falls below the frozen floor. That honesty guard is the
Rung-1 analogue of P4 refusing to hide the navigation gap.

Dep-free: stdlib + the merged P2/P3 modules. No litellm.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "runtime"))

from benny.sdlc.bench_record import authoring_block, build_record, navigation_block, rank_records, validate_record
from benny.sdlc.bench_ledger import append_register, read_register, register_entry, require_ledgered
from benny.sdlc.sandbox_runner import SandboxResult

HERE = Path(__file__).parent
OUT = HERE / "results"
PRIMARY = "authoring.wall_seconds"  # lower is better — the faster-outcome question
QUALITY_FLOOR = 0.70  # frozen: a fragment scoring below this is not "good enough" to count as a win
NAV_UNAVAILABLE = (
    "navigation instrument (tool_selection_accuracy) has no agentic manifest on today's "
    "orchestrator — see the P4 amendment; Rung 1 measures the authoring/generation surface"
)


def load_summary(model_key: str) -> dict:
    p = OUT / f"{model_key}.json"
    if not p.exists():
        raise SystemExit(f"missing subject result {p} — run rung1_bench.mjs for it first")
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default="google_gemma_4_12b", help="results key for the LONGVIEW baseline")
    ap.add_argument("--candidate", default="google_gemma_4_e4b", help="results key for the candidate")
    args = ap.parse_args()

    subjects = [("baseline", args.baseline), ("candidate", args.candidate)]
    summaries = {role: load_summary(key) for role, key in subjects}

    # Frozen rubric: the sample + the exact scoring contract. Any change to what is measured changes
    # the hash and invalidates a comparison built against the old one (R10).
    sid = summaries["baseline"]["sid"]
    rubric = {
        "surface": "longview.window_fragment",
        "sid": sid,
        "window_chars": summaries["baseline"]["window_chars"],
        "primary": PRIMARY,
        "quality_floor": QUALITY_FLOOR,
        "quality_composite": ["valid_json", "keys_present", "within_bounds", "coverage"],
        "prompt": "scripts/longview/prompts/window_fragment.md",
        "non_circular": "quality scored on schema+coverage, NOT against the 12B's stored gold card",
    }
    rubric_hash = "sha256:" + hashlib.sha256(
        json.dumps(rubric, sort_keys=True).encode("utf-8")).hexdigest()[:16]

    OUT.mkdir(exist_ok=True)
    register_path = OUT / "execution_register.json"
    records = []
    quality_detail = {}

    for role, key in subjects:
        s = summaries[role]
        label = s["model"]
        run_id = f"rung1-{key}"
        trial = {
            "model": label,
            "status": "OK",
            "auto_scores": None,  # the authoring score slots (has_required_ops/step_count/parse_ok)
                                  # are P4-surface names; Rung-1 quality lives in quality_score, honest.
            "wall_seconds": s["wall_seconds"],
            "total_tokens": s["prompt_tokens"] + s["completion_tokens"],
            "cost_usd": None,     # local serving — not measured, so unmeasured, never a fake 0.
            "quality_score": s["quality_score"],
        }
        nav = navigation_block(SandboxResult(
            model=label, run_id=run_id, status="unavailable", unavailable_reason=NAV_UNAVAILABLE))
        rec = build_record(label, authoring=authoring_block(trial), navigation=nav,
                           rubric_hash=rubric_hash, primary_metric=PRIMARY)
        ok, errs = validate_record(rec)
        assert ok, errs
        records.append(rec)
        quality_detail[label] = {
            "role": role,
            "quality_score": s["quality_score"],
            "valid_json": s["valid_json"], "keys_present": s["keys_present"],
            "within_bounds": s["within_bounds"], "coverage": s["coverage"],
            "windows": s["windows"], "wall_seconds": s["wall_seconds"],
            "meets_floor": s["quality_score"] >= QUALITY_FLOOR,
        }
        append_register(register_path, register_entry(
            subject=label, run_id=run_id,
            topology={"endpoint": "http://localhost:1234/v1", "quantisation": "q4_k_m", "model_id": label},
            rubric_hash=rubric_hash,
            metrics={"wall_seconds": s["wall_seconds"],
                     "total_tokens": trial["total_tokens"],
                     "quality_score": s["quality_score"]}))

    entries = read_register(register_path)
    for rec in records:
        require_ledgered(entries, rec["navigation"]["run_id"])

    ranked = rank_records(records, higher_is_better=False)  # lower wall_seconds first
    fastest = ranked["ranked"][0]["subject"]
    # The honesty guard: a speed win only stands if the faster model is actually good enough.
    speed_win_valid = quality_detail[fastest]["meets_floor"]

    report = {
        "bench_id": "rung1-longview-window-fragment",
        "surface": "longview.window_fragment (real map primitive)",
        "sample_sid": sid,
        "rubric_hash": rubric_hash,
        "rubric": rubric,
        "primary_metric": ranked["primary_metric"],
        "higher_is_better": False,
        "quality_floor": QUALITY_FLOOR,
        "ranking": [r["subject"] for r in ranked["ranked"]],
        "excluded": ranked["excluded"],
        "fastest": fastest,
        "fastest_meets_quality_floor": speed_win_valid,
        "quality_detail": quality_detail,
        "records": records,
        "register_path": str(register_path.relative_to(ROOT)),
    }
    (OUT / "rung1-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("=== Rung 1 — LONGVIEW window_fragment bench ===")
    print(f"sample: {sid}   rubric: {rubric_hash}   floor: {QUALITY_FLOOR}")
    for r in records:
        a = r["authoring"]
        qd = quality_detail[r["subject"]]
        print(f"  {qd['role']:<9} {r['subject']:<22} wall={a['wall_seconds']}s  tokens={a['total_tokens']}  "
              f"q={a['quality_score']}  cov={qd['coverage']}  {'OK' if qd['meets_floor'] else 'BELOW-FLOOR'}")
    print(f"fastest: {fastest}  ->  {'good enough (win stands)' if speed_win_valid else 'BELOW FLOOR — speed win does NOT stand'}")
    print(f"report -> {OUT / 'rung1-report.json'}")


if __name__ == "__main__":
    main()
