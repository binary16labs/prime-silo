"""Produce the P4 bench report ON THE BENNY SERVER (needs litellm + the orchestrator + openlineage).

Runs both surfaces for the two subjects in the roster, folds them through the merged P2 record and
P3 ledger, ranks on the frozen rubric's primary metric, and writes docs/bench/results/p4-report.json
in the schema scripts/gates/p4.py validates.

  AUTHORING  — `pypes model-bench docs/bench/p4-authoring-spec.json` (run separately; this script
               reads its saved trials JSON via --authoring <path>).
  NAVIGATION — run_multi_model over the roster's subjects with the REAL make_bench_hook, driving the
               orchestrator; derive_metrics yields the two live metrics, the other six stay unmeasured.

Prerequisites (see RUN-ON-BENNY-SERVER.md): both subjects reachable through benny's registry
(house/qwen2.5-coder-tuned + gemma-e4b), BENNY_TUNED_MODEL pointing at the served id, and an SDLC
manifest that exercises tool selection (pass with --manifest; the operator picks the canonical one).

This file is NOT run on the serving/trainer box — it needs the benny stack. It is here so the
benny-server run is one command, and so the fold/ledger/report logic is reviewed with the gate.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from benny.sdlc.bench_record import authoring_block, build_record, navigation_block, rank_records, validate_record
from benny.sdlc.bench_ledger import append_register, emit_lineage, read_register, register_entry, require_ledgered
from benny.sdlc.bench_executor import make_bench_hook
from benny.sdlc.sandbox_runner import run_multi_model, SandboxResult

HERE = Path(__file__).resolve().parent
OUT = HERE / "results"
PRIMARY = "navigation.tool_selection_accuracy"


def frozen_rubric_hash(roster: dict) -> str:
    import hashlib
    payload = json.dumps({"rubric": roster.get("rubric"), "primary_metric": PRIMARY,
                          "roster_models": [m["id"] for m in roster["models"]]},
                         sort_keys=True, separators=(",", ":"))
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", default=str(HERE / "p4-roster.json"))
    ap.add_argument("--manifest", required=True, help="SDLC manifest that exercises tool selection")
    ap.add_argument("--workspace", required=True, help="benny workspace root (runs_root)")
    ap.add_argument("--authoring", default="", help="optional saved model-bench trials JSON, keyed by subject")
    args = ap.parse_args()

    OUT.mkdir(exist_ok=True)
    roster = json.loads(Path(args.roster).read_text(encoding="utf-8"))
    rubric_hash = frozen_rubric_hash(roster)
    subjects = [s["label"] for s in roster["subjects"]]
    authoring = json.loads(Path(args.authoring).read_text(encoding="utf-8")) if args.authoring else {}

    # NAVIGATION — the real orchestrator, one subject at a time (single-tenant serving).
    hook = make_bench_hook(roster, runs_root=Path(args.workspace))
    nav_results = run_multi_model(
        manifest_path=Path(args.manifest), models=subjects,
        workspace=Path(args.workspace), hook=hook,
    )
    nav_by = {r.model: r for r in nav_results}

    register_path = OUT / "execution_register.json"
    records, lineage = [], {}
    for label in subjects:
        nav = navigation_block(nav_by[label])
        auth = authoring_block(authoring[label]) if label in authoring else None
        rec = build_record(label, authoring=auth, navigation=nav,
                           rubric_hash=rubric_hash, primary_metric=PRIMARY)
        ok, errs = validate_record(rec)
        assert ok, errs
        records.append(rec)

        run_id = nav_by[label].run_id or f"p4-{label}"
        entry = register_entry(
            subject=label, run_id=run_id,
            topology={"endpoint": "benny", "quantisation": "q4_k_m",
                      "model_id": next(m["id"] for m in roster["models"]
                                       if m["label"] in json.dumps(next(s["assign"] for s in roster["subjects"] if s["label"] == label)))},
            rubric_hash=rubric_hash, roster_hash=None,
            metrics={k: getattr(nav_by[label], k) for k in ("tool_selection_accuracy", "iteration_latency_ms_p95")},
        )
        append_register(register_path, entry)
        lineage[run_id] = emit_lineage(entry, workspace=str(args.workspace))

    entries = read_register(register_path)
    for label in subjects:
        require_ledgered(entries, nav_by[label].run_id or f"p4-{label}")

    ranked = rank_records(records)
    report = {
        "bench_id": roster["id"], "rubric_hash": rubric_hash, "primary_metric": PRIMARY,
        "ranking": [r["subject"] for r in ranked["ranked"]], "excluded": ranked["excluded"],
        "records": records, "register_path": str(register_path), "lineage": lineage,
    }
    (OUT / "p4-report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("wrote", OUT / "p4-report.json")
    print("ranking:", report["ranking"], "| excluded:", report["excluded"])
    print("now verify: python scripts/gates/p4.py")


if __name__ == "__main__":
    main()
