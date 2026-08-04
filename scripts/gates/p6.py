#!/usr/bin/env python3
"""Gate P6 — the executor derives what the stream supports and admits the rest.

P1 made `unmeasured` structurally distinct from `0.0`. P6 has to fill that schema in without
quietly re-inventing the thing P1 removed: a number that was never measured.

The checks below are written so that the tempting shortcuts turn the gate red — summing the subset
of nodes that happened to report tokens and calling it a total, or treating zero gate evaluations
as perfect adherence.

It also asserts the honest claim in the contract: against `pypes/orchestrator.py` as it stands,
exactly TWO of the eight metrics are derivable. That assertion is the deliverable, not an
embarrassment to be smoothed over.

Hermetic: no LLM, no network, no pydantic.
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "runtime"
sys.path.insert(0, str(RUNTIME))

TESTS = ["tests/sdlc/test_bench_executor.py", "tests/sdlc/test_sandbox_result.py"]
failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def orchestrator_events():
    """A transcription of what the orchestrator actually emits: duration_ms, no tokens."""
    return [
        {"event": "run_started", "run_id": "r", "nodes": ["a", "b"]},
        {"event": "node_finished", "run_id": "r", "node_id": "a", "attempt": 1, "duration_ms": 120},
        {"event": "node_finished", "run_id": "r", "node_id": "b", "attempt": 1, "duration_ms": 340},
    ]


def main() -> int:
    for rel in ("runtime/benny/sdlc/bench_executor.py", "runtime/tests/sdlc/test_bench_executor.py"):
        if not (ROOT / rel).exists():
            print(f"[p6] FAIL: required artifact missing: {rel}")
            return 1

    from benny.sdlc.bench_executor import (
        SubjectUnavailable,
        derive_metrics,
        make_bench_hook,
        percentile,
        resolve_assignment,
    )
    from benny.sdlc.sandbox_runner import METRIC_FIELDS

    # 1. Nothing derived from nothing.
    empty = derive_metrics([])
    for f in METRIC_FIELDS:
        check(empty[f] is None, f"derive_metrics([]) invented {f}={empty[f]!r} from no events")
    check(percentile([]) is None, "p95 of an empty sample is 0.0 — that is the defect in miniature")

    # 2. THE HONEST CLAIM. Two of eight against today's orchestrator.
    m = derive_metrics(orchestrator_events())
    measured = {k for k, v in m.items() if v is not None}
    check(
        measured == {"iteration_latency_ms_p95", "loop_count_p95"},
        f"expected exactly latency+loops derivable from today's stream, got {sorted(measured)}",
    )

    # 3. The premise of that claim, checked against the orchestrator itself rather than assumed.
    orch = (RUNTIME / "benny/pypes/orchestrator.py").read_text(encoding="utf-8")
    check("events.node_finished" in orch, "the orchestrator no longer emits node_finished")
    if "events.node_finished" in orch:
        call = orch[orch.index("events.node_finished"):][:200]
        check(
            "tokens_in" not in call,
            "the orchestrator now emits tokens — widen derive_metrics rather than leaving the "
            "metrics unmeasured",
        )

    # 4. A partial sum is a smaller lie, not a truth.
    partial = [dict(e) for e in orchestrator_events()]
    partial[1].update(tokens_in=400, tokens_out=100)  # only ONE node reports
    check(
        derive_metrics(partial)["total_tokens"] is None,
        "total_tokens was summed from the subset of nodes that reported — that is a fabricated total",
    )

    # 5. Absence of evaluation is not evidence of adherence. The old stub returned 1.0 here.
    check(
        derive_metrics(orchestrator_events())["constraint_adherence"] is None,
        "constraint_adherence was reported with zero gate evaluations",
    )

    # 6. Resolution is fail-closed: an unknown label is refused, never silently defaulted.
    roster = {
        "models": [{"label": "m1", "id": "vendor/model-1", "tier": ["implementer"]}],
        "subjects": [{"label": "s1", "assign": {"*": "m1"}}, {"label": "bad", "assign": {"*": "ghost"}}],
    }
    check(resolve_assignment(roster, "s1")["implementer"] == "vendor/model-1", "wildcard assignment broke")
    for label, what in (("nope", "unknown subject"), ("bad", "unknown model label")):
        try:
            resolve_assignment(roster, label)
            failures.append(f"{what} was accepted instead of refused")
        except KeyError:
            pass

    # 7. A missing stream measures nothing rather than zero.
    hook = make_bench_hook(roster, drive=lambda s, a, mp, w: "never-wrote", runs_root=ROOT)
    row = hook("s1", Path("x.json"), ROOT)
    for f in METRIC_FIELDS:
        check(getattr(row, f) is None, f"{f} invented from a missing event stream")

    # 8. An unreachable subject propagates so the runner can record it honestly.
    def down(subject, assignment, manifest_path, workspace):
        raise SubjectUnavailable("endpoint refused")

    try:
        make_bench_hook(roster, drive=down, runs_root=ROOT)("s1", Path("x.json"), ROOT)
        failures.append("SubjectUnavailable was swallowed by the hook instead of propagating")
    except SubjectUnavailable:
        pass

    if failures:
        for f in failures:
            print(f"[p6] FAIL: {f}")
        print("[p6] GATE FAILED")
        return 1

    p = subprocess.run([sys.executable, "-m", "pytest", *TESTS, "-q"], cwd=str(RUNTIME))
    if p.returncode != 0:
        print("[p6] GATE FAILED (acceptance tests)")
        return p.returncode

    print(
        "[p6] derivation honest: 2/8 measurable against today's orchestrator and the other 6 "
        "reported unmeasured, partial token sums refused, zero-evaluation adherence refused, "
        "roster resolution fail-closed — verified"
    )
    print("[p6] GATE GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
