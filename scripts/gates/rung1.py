#!/usr/bin/env python
"""Gate Rung 1 — the LONGVIEW map primitive benched on the real path, baseline vs candidate.

Rung 1 of the evaluation ladder (P4 = rung 0). It answers the owner's question honestly: is the
SMALLER model (google/gemma-4-e4b) faster than the model LONGVIEW actually runs
(google/gemma-4-12b) AND still good enough on the window_fragment extraction that is the real map
primitive? This gate re-derives that verdict rather than trusting the report, and — the point — it
REFUSES to let a speed win stand if the faster model's fragment quality falls below the frozen floor.
A faster-but-worse model is not a win; hiding that behind a bare wall-clock ranking is the Rung-1
analogue of the P4 report hiding the navigation gap.

Dep-free: the merged P2/P3 modules only. Runs on the ambient interpreter (no litellm).
Contract: the ladder direction (EP-M follow-on); sample locked at
docs/bench/rung1/results/rung1-report.json.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "runtime"))

from benny.sdlc.bench_record import rank_records, validate_record
from benny.sdlc.bench_ledger import read_register, require_ledgered, UnledgeredBench

REPORT = ROOT / "docs" / "bench" / "rung1" / "results" / "rung1-report.json"


def fail(msg: str) -> None:
    print(f"[rung1] FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    global REPORT
    if len(sys.argv) > 1:
        REPORT = Path(sys.argv[1]).resolve()
    if not REPORT.exists():
        fail(f"no bench report at {REPORT} — run rung1_bench.mjs for both subjects then "
             "produce_rung1_report.py. This is the TDD-red state before the run.")

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    records = report.get("records")
    if not isinstance(records, list) or len(records) < 2:
        fail(f"a baseline-vs-candidate bench needs two subjects; got {len(records or [])}")

    # 1. Every record is a valid P2 bench record (closed schema, no composite smuggled in).
    for rec in records:
        ok, errs = validate_record(rec)
        if not ok:
            fail(f"subject {rec.get('subject')!r} record is invalid: {'; '.join(errs)}")

    # 2. THE RUN IS REAL. Each subject carries a measured wall time and a measured quality score —
    #    the bench actually generated fragments, it is not an empty shell.
    declared = report.get("primary_metric")
    if declared != "authoring.wall_seconds":
        fail(f"Rung 1 ranks on authoring.wall_seconds (the faster-outcome question); got {declared!r}")
    for rec in records:
        a = rec.get("authoring") or {}
        wall = a.get("wall_seconds")
        q = a.get("quality_score")
        if not isinstance(wall, (int, float)) or isinstance(wall, bool) or wall <= 0:
            fail(f"subject {rec.get('subject')!r} has no measured wall_seconds ({wall!r}) — it did not run")
        if not isinstance(q, (int, float)) or isinstance(q, bool):
            fail(f"subject {rec.get('subject')!r} has no measured quality_score ({q!r}) — quality unmeasured")

    # 3. Ranked on the declared metric, honouring direction; report's ranking matches a re-derivation.
    ranked = rank_records(records, higher_is_better=False)
    if ranked["primary_metric"] != declared:
        fail(f"ranking used {ranked['primary_metric']!r}, not the declared {declared!r}")
    if [r["subject"] for r in ranked["ranked"]] != report.get("ranking"):
        fail(f"report ranking {report.get('ranking')} != re-derivation {[r['subject'] for r in ranked['ranked']]}")

    # 4. THE HONESTY GUARD — a speed win must be good enough. The faster subject is ranked[0]; if its
    #    quality is below the frozen floor, the report MUST say the speed win does not stand. This is
    #    the check that stops "smaller = faster" from being declared while quality quietly collapsed.
    floor = report.get("quality_floor")
    if not isinstance(floor, (int, float)):
        fail("no frozen quality_floor in the report — the good-enough guard is unarmed")
    fastest = ranked["ranked"][0]["subject"]
    if report.get("fastest") != fastest:
        fail(f"report names fastest={report.get('fastest')!r} but re-derivation says {fastest!r}")
    fast_rec = next(r for r in records if r["subject"] == fastest)
    fast_q = fast_rec["authoring"]["quality_score"]
    claimed_valid = report.get("fastest_meets_quality_floor")
    truly_valid = fast_q >= floor
    if claimed_valid != truly_valid:
        fail(f"report says fastest_meets_quality_floor={claimed_valid} but {fastest!r} q={fast_q} "
             f"vs floor={floor} is {truly_valid} — the good-enough verdict is misreported")
    # Cross-check the per-subject quality_detail agrees (no split-brain between the two surfaces).
    qd = (report.get("quality_detail") or {}).get(fastest) or {}
    if qd.get("meets_floor") != truly_valid:
        fail(f"quality_detail for {fastest!r} disagrees with its record on meeting the floor")

    # 5. R10 — a rubric edited after results were seen invalidates the comparison by hash mismatch.
    poisoned = [{**records[0], "rubric_hash": records[0]["rubric_hash"] + "-edited"}, *records[1:]]
    try:
        rank_records(poisoned, higher_is_better=False)
        fail("a record with an edited rubric_hash ranked alongside the originals — R10 not enforced")
    except ValueError:
        pass

    # 6. R9 — both subjects are in the execution ledger.
    reg_path = ROOT / report.get("register_path", "docs/bench/rung1/results/execution_register.json")
    if not reg_path.exists():
        fail(f"no execution register at {reg_path} — an unledgered bench did not happen (R9)")
    entries = read_register(reg_path)
    for rec in records:
        run_id = (rec.get("navigation") or {}).get("run_id")
        try:
            require_ledgered(entries, run_id)
        except UnledgeredBench:
            fail(f"subject {rec.get('subject')!r} (run {run_id}) is not in the execution register (R9)")

    verdict = "good enough — the speed win stands" if truly_valid else \
              "BELOW the quality floor — the speed win does NOT stand (faster but worse)"
    print(f"[rung1] two subjects really benched on the real window_fragment path, ranked on "
          f"{declared!r} (lower is better) from a frozen rubric ({report.get('rubric_hash')}); "
          f"fastest={fastest} q={fast_q} vs floor={floor} -> {verdict}; a post-hoc rubric edit is "
          "refused; both subjects ledgered (R9) — verified")
    print("[rung1] GATE GREEN")
    sys.exit(0)


if __name__ == "__main__":
    main()
