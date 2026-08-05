"""Fold the REAL model_compare authoring results into the P4 report (authoring surface).

Owner-signed amendment (2026-08-05): P4's navigation instrument (tool_selection_accuracy) has no
agentic manifest to run against on today's orchestrator — the swarm template emits zero G0 node
events and data pipelines don't exercise the model's tool selection. Rather than block EP-M on that
instrument gap, P4 lands on the AUTHORING surface: `pypes model-bench` really ran both subjects and
produced discriminating efficiency numbers. The navigation block is recorded UNAVAILABLE with the
reason, never a zero. The instrument gap is spun off as its own contract.

Reads the model_compare results.json (produced by `benny_cli.py pypes model-bench`), so this fold
needs only the stdlib + the dep-free P2/P3 modules — no litellm.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "runtime"))

from benny.sdlc.bench_record import authoring_block, build_record, navigation_block, rank_records, validate_record
from benny.sdlc.bench_ledger import append_register, read_register, register_entry, require_ledgered
from benny.sdlc.sandbox_runner import SandboxResult

OUT = Path(__file__).parent / "results"
PRIMARY = "authoring.wall_seconds"  # lower is better — efficiency, the metric the smaller-and-faster goal cares about
NAV_UNAVAILABLE = "navigation instrument (tool_selection_accuracy) has no agentic manifest on today's orchestrator — see the P4 amendment"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--results", required=True, help="model_compare results.json")
    ap.add_argument("--rubric-hash", default="", help="frozen rubric id; derived from the spec if omitted")
    args = ap.parse_args()

    data = json.loads(Path(args.results).read_text(encoding="utf-8"))
    trials = data.get("best_per_model") or data.get("trials") or []
    if isinstance(trials, dict):
        trials = list(trials.values())

    import hashlib
    rubric_hash = args.rubric_hash or ("sha256:" + hashlib.sha256(
        json.dumps({"spec": data.get("spec_id"), "task": data.get("task"), "primary": PRIMARY},
                   sort_keys=True).encode("utf-8")).hexdigest()[:16])

    OUT.mkdir(exist_ok=True)
    register_path = OUT / "execution_register.json"
    records = []

    for t in trials:
        label = t.get("label") or t.get("model")
        run_id = f"p4-{label}"
        # the authoring block: the real, measured efficiency fields; rubric-quality fields (auto_scores)
        # were not computed without the judge, so they stay unmeasured — honest, not zero.
        trial = {
            "model": label, "status": t.get("status", "OK"),
            "auto_scores": t.get("auto_scores"),
            "wall_seconds": t.get("wall_seconds"), "total_tokens": t.get("total_tokens"),
            "cost_usd": t.get("cost_usd"), "quality_score": t.get("quality_score"),
        }
        nav = navigation_block(SandboxResult(model=label, run_id=run_id, status="unavailable",
                                             unavailable_reason=NAV_UNAVAILABLE))
        rec = build_record(label, authoring=authoring_block(trial), navigation=nav,
                           rubric_hash=rubric_hash, primary_metric=PRIMARY)
        ok, errs = validate_record(rec)
        assert ok, errs
        records.append(rec)

        append_register(register_path, register_entry(
            subject=label, run_id=run_id,
            topology={"endpoint": "http://localhost:1234/v1", "quantisation": "q4_k_m",
                      "model_id": t.get("model_id")},
            rubric_hash=rubric_hash,
            metrics={k: trial[k] for k in ("wall_seconds", "total_tokens", "cost_usd")}))

    entries = read_register(register_path)
    for rec in records:
        require_ledgered(entries, rec["navigation"]["run_id"])

    ranked = rank_records(records, higher_is_better=False)  # lower wall_seconds ranks first
    report = {
        "bench_id": data.get("spec_id"), "surface": "authoring (owner-signed amendment; navigation instrument gap)",
        "rubric_hash": rubric_hash, "primary_metric": ranked["primary_metric"],
        "higher_is_better": False,
        "ranking": [r["subject"] for r in ranked["ranked"]], "excluded": ranked["excluded"],
        "records": records, "register_path": str(register_path.relative_to(ROOT)),
    }
    (OUT / "p4-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

    print("=== P4 authoring-surface report ===")
    print(f"primary_metric: {ranked['primary_metric']} (lower is better)   rubric: {rubric_hash}")
    for r in records:
        a = r["authoring"]
        print(f"  {r['subject']:<12} wall={a['wall_seconds']}s  tokens={a['total_tokens']}  "
              f"cost=${a['cost_usd']}  quality={a['quality_score']}")
    print(f"ranking (faster first): {report['ranking']}")
    print(f"navigation: UNAVAILABLE for both (instrument gap, on record)")
    print(f"report -> {OUT / 'p4-report.json'}")


if __name__ == "__main__":
    main()
