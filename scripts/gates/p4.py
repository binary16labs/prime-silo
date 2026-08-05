#!/usr/bin/env python
"""Gate P4 — two engines ranked on one frozen instrument, ledgered, in the DAG.

P4 is a REPORT contract: its budget buys evidence, not code. This gate re-derives the verdict from
the report rather than trusting it — it loads the bench records the benny-server run produced,
validates each through the P2 record schema, confirms two subjects each carry all eight navigation
fields (measured or EXPLICITLY unmeasured — never a silent zero), ranks them on the primary metric
the frozen rubric declares, proves a post-hoc rubric edit is refused by hash mismatch (R10), and
proves each subject is in the execution ledger (R9) and the lineage DAG.

It uses only the dep-free P2/P3 modules, so it runs on the ambient interpreter with no litellm.

Report schema (produced by docs/bench/produce_p4_report.py on the benny server):
  {
    "bench_id": str,
    "rubric_hash": "sha256:...",
    "primary_metric": "navigation.<field>",       # the declared instrument
    "records": [ <P2 bench_record>, ... ],          # one per subject
    "register_path": "docs/bench/results/execution_register.json",
    "lineage": { "<run_id>": {"emitted": true, ...}, ... }
  }

Contract: delivery/tasks/P4.md
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


def fail(msg: str) -> "None":
    print(f"[p4] FAIL: {msg}")
    sys.exit(1)


def main() -> None:
    # A verifier may point the gate at a specific report; default is the benny-server output path.
    global REPORT
    if len(sys.argv) > 1:
        REPORT = Path(sys.argv[1]).resolve()
    if not REPORT.exists():
        fail(
            f"no bench report at {REPORT.relative_to(ROOT)} — run the bench on the benny server "
            "first (see docs/bench/RUN-ON-BENNY-SERVER.md). This is the TDD-red state before the run."
        )

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    records = report.get("records")
    if not isinstance(records, list) or len(records) < 2:
        fail(f"a two-model bench needs at least two subjects; got {len(records or [])}")

    # 1. Every record is a valid P2 bench record.
    for rec in records:
        ok, errs = validate_record(rec)
        if not ok:
            fail(f"subject {rec.get('subject')!r} record is invalid: {'; '.join(errs)}")

    # 2. THE EIGHT FIELDS. Each subject's navigation block must carry all eight metric fields, each
    #    either a measured number or explicitly listed in `unmeasured` — never silently absent, never
    #    a zero standing in for 'not run'.
    for rec in records:
        nav = rec.get("navigation")
        if not isinstance(nav, dict):
            fail(f"subject {rec.get('subject')!r} carries no navigation block — the instrument is the "
                 "eight navigation fields")
        unmeasured = set(nav.get("unmeasured") or [])
        for field in METRIC_FIELDS:
            if field not in nav:
                fail(f"subject {rec.get('subject')!r} navigation is missing field {field!r}")
            measured = nav[field] is not None
            if not measured and field not in unmeasured:
                fail(f"subject {rec.get('subject')!r} field {field!r} is null but not declared "
                     "unmeasured — a gap must be named, not silent")
            if measured and field in unmeasured:
                fail(f"subject {rec.get('subject')!r} field {field!r} has a value AND claims "
                     "unmeasured — the record contradicts itself")

    # 3. Ranked on the DECLARED primary metric, excluding what was not measured (D3).
    declared = report.get("primary_metric")
    if not declared or declared != records[0].get("primary_metric"):
        fail(f"report primary_metric {declared!r} does not match the records' declared metric")
    ranked = rank_records(records)
    if ranked["primary_metric"] != declared:
        fail(f"ranking used {ranked['primary_metric']!r}, not the declared {declared!r}")
    if not ranked["ranked"]:
        fail("no subject was measured on the primary metric — there is nothing ranked, so the bench "
             "produced no comparable result on its own instrument")

    # 4. R10 — a rubric edited AFTER results were seen must invalidate the comparison. Mutate one
    #    record's rubric hash and confirm rank_records refuses the now-mixed pile.
    poisoned = [dict(records[0]), *(dict(r) for r in records[1:])]
    poisoned[0] = {**poisoned[0], "rubric_hash": poisoned[0]["rubric_hash"] + "-edited"}
    try:
        rank_records(poisoned)
        fail("a record with an edited rubric_hash ranked alongside the originals — a post-hoc rubric "
             "edit was NOT refused (R10)")
    except ValueError:
        pass  # correct: the instrument changed, so the comparison is invalidated

    # 5. R9 — every subject is in the execution ledger. A bench not in the ledger did not happen.
    reg_path = ROOT / report.get("register_path", "docs/bench/results/execution_register.json")
    if not reg_path.exists():
        fail(f"no execution register at {reg_path} — an unledgered bench did not happen (R9)")
    entries = read_register(reg_path)
    for rec in records:
        run_id = (rec.get("navigation") or {}).get("run_id")
        if not run_id:
            fail(f"subject {rec.get('subject')!r} carries no run_id, so it cannot be traced to the ledger")
        try:
            require_ledgered(entries, run_id)
        except UnledgeredBench:
            fail(f"subject {rec.get('subject')!r} (run {run_id}) is not in the execution register (R9)")

    # 6. Present in the DAG — a lineage RunEvent was emitted for each subject.
    lineage = report.get("lineage") or {}
    for rec in records:
        run_id = (rec.get("navigation") or {}).get("run_id")
        emitted = (lineage.get(run_id) or {}).get("emitted")
        if emitted is not True:
            fail(f"subject {rec.get('subject')!r} (run {run_id}) has no emitted lineage event — the "
                 "result is not present in the DAG. (On a box without openlineage this is expected "
                 "and P4 must run where the DAG is real.)")

    print(f"[p4] two subjects ranked on {declared!r} from a frozen rubric ({report.get('rubric_hash')}); "
          "all eight navigation fields measured-or-declared-unmeasured; a post-hoc rubric edit is "
          "refused; both subjects ledgered (R9) and present in the DAG — verified")
    print("[p4] GATE GREEN")
    sys.exit(0)


if __name__ == "__main__":
    main()
