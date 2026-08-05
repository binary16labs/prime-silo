"""Fold the REAL Rung-2 results (window_fragment over a SAMPLE of cards) into a bench report.

Rung 2 widens Rung 1: does E4B-beats-12B hold beyond n=1? Same real path, same frozen non-circular
scoring, now aggregated per CARD across docs/bench/rung1/sample-rung2.json. The report matches the
Rung-1 schema so scripts/gates/rung1.py validates it unchanged — including the honesty guard that
refuses a speed win below the frozen quality floor.

Ranks on authoring.wall_seconds = MEAN wall-seconds per card (a card is one LONGVIEW artifact).
Dep-free: stdlib + merged P2/P3.
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
PRIMARY = "authoring.wall_seconds"
QUALITY_FLOOR = 0.70
NAV_UNAVAILABLE = (
    "navigation instrument (tool_selection_accuracy) has no agentic manifest on today's "
    "orchestrator — see the P4 amendment; Rung 2 measures the authoring/generation surface"
)


def load_summary(model_key: str) -> dict:
    p = OUT / f"{model_key}__rung2.json"
    if not p.exists():
        raise SystemExit(f"missing subject result {p} — run rung2_bench.mjs for it first")
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--baseline", default="google_gemma_4_12b")
    ap.add_argument("--candidate", default="google_gemma_4_e4b")
    args = ap.parse_args()

    subjects = [("baseline", args.baseline), ("candidate", args.candidate)]
    summaries = {role: load_summary(key) for role, key in subjects}

    n_cards = summaries["baseline"]["n_cards"]
    if summaries["candidate"]["n_cards"] != n_cards:
        raise SystemExit("baseline and candidate ran different card counts — not comparable")

    rubric = {
        "surface": "longview.window_fragment",
        "sample": "sample-rung2.json",
        "n_cards": n_cards,
        "window_chars": summaries["baseline"]["window_chars"],
        "primary": PRIMARY,
        "quality_floor": QUALITY_FLOOR,
        "quality_composite": ["valid_json", "keys_present", "within_bounds", "coverage"],
        "prompt": "scripts/longview/prompts/window_fragment.md",
        "non_circular": "quality scored on schema+coverage, NOT against the 12B's stored gold card",
        "rank_unit": "mean wall_seconds per card",
    }
    rubric_hash = "sha256:" + hashlib.sha256(
        json.dumps(rubric, sort_keys=True).encode("utf-8")).hexdigest()[:16]

    OUT.mkdir(exist_ok=True)
    register_path = OUT / "rung2_execution_register.json"
    records = []
    quality_detail = {}

    for role, key in subjects:
        s = summaries[role]
        label = s["model"]
        run_id = f"rung2-{key}"
        trial = {
            "model": label, "status": "OK", "auto_scores": None,
            "wall_seconds": s["wall_seconds"],  # mean per card
            "total_tokens": s["prompt_tokens"] + s["completion_tokens"],
            "cost_usd": None,
            "quality_score": s["quality_score"],
        }
        nav = navigation_block(SandboxResult(
            model=label, run_id=run_id, status="unavailable", unavailable_reason=NAV_UNAVAILABLE))
        rec = build_record(label, authoring=authoring_block(trial), navigation=nav,
                           rubric_hash=rubric_hash, primary_metric=PRIMARY)
        ok, errs = validate_record(rec)
        assert ok, errs
        records.append(rec)
        # per-card spread so the reader sees consistency, not just a mean
        walls = sorted(x["wall_seconds"] for x in s["per_sid"])
        quals = sorted(x["quality_score"] for x in s["per_sid"])
        quality_detail[label] = {
            "role": role, "n_cards": n_cards,
            "quality_score": s["quality_score"], "coverage": s["coverage"],
            "valid_json": s["valid_json"], "keys_present": s["keys_present"], "within_bounds": s["within_bounds"],
            "mean_wall_per_card": s["wall_seconds"], "total_wall_seconds": s["total_wall_seconds"],
            "wall_min": walls[0], "wall_max": walls[-1],
            "quality_min": quals[0], "quality_max": quals[-1],
            "cards_meeting_floor": sum(1 for x in s["per_sid"] if x["quality_score"] >= QUALITY_FLOOR),
            "meets_floor": s["quality_score"] >= QUALITY_FLOOR,
        }
        append_register(register_path, register_entry(
            subject=label, run_id=run_id,
            topology={"endpoint": "http://localhost:1234/v1", "quantisation": "q4_k_m", "model_id": label},
            rubric_hash=rubric_hash,
            metrics={"wall_seconds": s["wall_seconds"], "total_tokens": trial["total_tokens"],
                     "quality_score": s["quality_score"], "n_cards": n_cards}))

    entries = read_register(register_path)
    for rec in records:
        require_ledgered(entries, rec["navigation"]["run_id"])

    ranked = rank_records(records, higher_is_better=False)
    fastest = ranked["ranked"][0]["subject"]
    speed_win_valid = quality_detail[fastest]["meets_floor"]

    report = {
        "bench_id": "rung2-longview-window-fragment-widened",
        "surface": "longview.window_fragment (real map primitive, widened)",
        "n_cards": n_cards,
        "sample": "sample-rung2.json",
        "rubric_hash": rubric_hash, "rubric": rubric,
        "primary_metric": ranked["primary_metric"], "higher_is_better": False,
        "quality_floor": QUALITY_FLOOR,
        "ranking": [r["subject"] for r in ranked["ranked"]], "excluded": ranked["excluded"],
        "fastest": fastest, "fastest_meets_quality_floor": speed_win_valid,
        "quality_detail": quality_detail, "records": records,
        "register_path": str(register_path.relative_to(ROOT)),
    }
    (OUT / "rung2-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print(f"=== Rung 2 — LONGVIEW window_fragment, widened to {n_cards} cards ===")
    print(f"rubric: {rubric_hash}   floor: {QUALITY_FLOOR}")
    for r in records:
        a = r["authoring"]; qd = quality_detail[r["subject"]]
        print(f"  {qd['role']:<9} {r['subject']:<22} mean={a['wall_seconds']}s/card "
              f"(total {qd['total_wall_seconds']}s)  q={a['quality_score']} "
              f"(cards>=floor {qd['cards_meeting_floor']}/{n_cards})  cov={qd['coverage']}")
    print(f"fastest: {fastest}  ->  {'good enough (win stands)' if speed_win_valid else 'BELOW FLOOR'}")
    print(f"report -> {OUT / 'rung2-report.json'}")


if __name__ == "__main__":
    main()
