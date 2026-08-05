#!/usr/bin/env python
"""Gate P4 — two engines ranked on one frozen instrument, ledgered (AUTHORING surface).

OWNER-SIGNED AMENDMENT (2026-08-05): P4's navigation instrument (`tool_selection_accuracy`) has no
agentic manifest to run against on today's orchestrator — the swarm template emits zero G0 node
events and data pipelines don't exercise the model's tool selection. That is an instrument gap, not
a report defect, and is spun off as its own contract. So P4 lands on the AUTHORING surface: a real
`pypes model-bench` run of both subjects, ranked on a declared authoring metric, ledgered. This gate
re-derives that verdict rather than trusting it, and it REFUSES a report that hides the navigation
gap behind a silently-empty block — the gap must be named (status `unavailable`, with a reason).

Uses only the dep-free P2/P3 modules; runs on the ambient interpreter (no litellm).
Contract: delivery/tasks/P4.md (+ its amendment)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "runtime"))

from benny.sdlc.bench_record import rank_records, validate_record
from benny.sdlc.bench_ledger import read_register, require_ledgered, UnledgeredBench
from benny.sdlc.sandbox_runner import METRIC_FIELDS

REPORT = ROOT / "docs" / "bench" / "results" / "p4-report.json"


def fail(msg: str) -> None:
    print(f"[p4] FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    global REPORT
    if len(sys.argv) > 1:
        REPORT = Path(sys.argv[1]).resolve()
    if not REPORT.exists():
        fail(f"no bench report at {REPORT} — run the bench first (see docs/bench/RUN-ON-BENNY-SERVER.md). "
             "This is the TDD-red state before the run.")

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    records = report.get("records")
    if not isinstance(records, list) or len(records) < 2:
        fail(f"a two-model bench needs at least two subjects; got {len(records or [])}")

    # 1. Every record is a valid P2 bench record (closed schema, no composite).
    for rec in records:
        ok, errs = validate_record(rec)
        if not ok:
            fail(f"subject {rec.get('subject')!r} record is invalid: {'; '.join(errs)}")

    # 2. THE AUTHORING SURFACE IS REAL. Each subject's authoring block carries a measured value for
    #    the declared primary metric — the bench actually ran, it is not an empty shell.
    declared = report.get("primary_metric")
    if not declared or not declared.startswith("authoring."):
        fail(f"the authoring amendment ranks on an authoring metric; got primary_metric {declared!r}")
    field = declared.split(".", 1)[1]
    for rec in records:
        val = (rec.get("authoring") or {}).get(field)
        if not isinstance(val, (int, float)) or isinstance(val, bool):
            fail(f"subject {rec.get('subject')!r} has no measured {declared} ({val!r}) — the bench did "
                 "not really run for it")

    # 3. THE NAVIGATION GAP IS NAMED, NOT HIDDEN. The amendment is honest only if the navigation
    #    block says 'unavailable' with a reason and leaves all eight fields explicitly unmeasured —
    #    a silently-empty block would let the instrument gap masquerade as a passing measurement.
    for rec in records:
        nav = rec.get("navigation")
        if not isinstance(nav, dict):
            fail(f"subject {rec.get('subject')!r} carries no navigation block")
        if nav.get("status") != "unavailable" or not nav.get("unavailable_reason"):
            fail(f"subject {rec.get('subject')!r} navigation is not declared unavailable-with-reason — "
                 "the amendment must name the instrument gap, not bury it")
        unmeasured = set(nav.get("unmeasured") or [])
        for m in METRIC_FIELDS:
            if nav.get(m) is not None or m not in unmeasured:
                fail(f"subject {rec.get('subject')!r} navigation field {m!r} is not explicitly unmeasured "
                     "— an unavailable surface must leave every field unmeasured, never a value")

    # 4. Ranked on the DECLARED metric, honouring its direction.
    hib = bool(report.get("higher_is_better", True))
    ranked = rank_records(records, higher_is_better=hib)
    if ranked["primary_metric"] != declared:
        fail(f"ranking used {ranked['primary_metric']!r}, not the declared {declared!r}")
    if [r["subject"] for r in ranked["ranked"]] != report.get("ranking"):
        fail(f"the report's ranking {report.get('ranking')} does not match a re-derivation "
             f"{[r['subject'] for r in ranked['ranked']]}")

    # 5. R10 — a rubric edited after results were seen invalidates the comparison by hash mismatch.
    poisoned = [{**records[0], "rubric_hash": records[0]["rubric_hash"] + "-edited"}, *records[1:]]
    try:
        rank_records(poisoned, higher_is_better=hib)
        fail("a record with an edited rubric_hash ranked alongside the originals — R10 not enforced")
    except ValueError:
        pass

    # 6. R9 — every subject is in the execution ledger.
    reg_path = ROOT / report.get("register_path", "docs/bench/results/execution_register.json")
    if not reg_path.exists():
        fail(f"no execution register at {reg_path} — an unledgered bench did not happen (R9)")
    entries = read_register(reg_path)
    for rec in records:
        run_id = (rec.get("navigation") or {}).get("run_id")
        try:
            require_ledgered(entries, run_id)
        except UnledgeredBench:
            fail(f"subject {rec.get('subject')!r} (run {run_id}) is not in the execution register (R9)")

    print(f"[p4] two subjects really benched and ranked on {declared!r} "
          f"({'higher' if hib else 'lower'} is better) from a frozen rubric ({report.get('rubric_hash')}); "
          "the navigation instrument gap is declared unavailable-with-reason (not hidden); a post-hoc "
          "rubric edit is refused; both subjects ledgered (R9) — verified")
    print("[p4] GATE GREEN")
    sys.exit(0)


if __name__ == "__main__":
    main()
