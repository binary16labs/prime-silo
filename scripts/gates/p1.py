#!/usr/bin/env python3
"""Gate P1 — the harness measures, or says that it did not.

`run_multi_model` shipped eight agentic metrics that were never once measured: `hook` defaulted to
`_dry_run_stub`, which returns 0.0 for every field, so an underived metric and a genuine zero were
the same bytes in the report.

This gate proves the defect is gone AND cannot come back. The behavioural checks are written so that
coercing any `None` back to `0.0` — the most likely regression — turns the gate red immediately.

Scope note: P1 is the metric SCHEMA. This gate deliberately does not import `bench_executor`
(that is P6's gate), so the schema is proven to stand on its own.

Hermetic: no LLM, no network, no pydantic (the ambient interpreter lacks it; `sandbox_runner` is
stdlib-only by design).
"""
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RUNTIME = ROOT / "runtime"
sys.path.insert(0, str(RUNTIME))

TESTS = ["tests/sdlc/test_sandbox_result.py", "tests/sdlc/test_sandbox_runner.py"]
failures: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    for rel in ("runtime/benny/sdlc/sandbox_runner.py", "runtime/tests/sdlc/test_sandbox_result.py"):
        if not (ROOT / rel).exists():
            print(f"[p1] FAIL: required artifact missing: {rel}")
            return 1

    from benny.sdlc.sandbox_runner import (
        METRIC_FIELDS,
        SandboxResult,
        rank_subjects,
        run_multi_model,
        write_sandbox_report,
    )

    src = (RUNTIME / "benny/sdlc/sandbox_runner.py").read_text(encoding="utf-8")

    # 1. THE DEFECT ITSELF. This exact expression is what silently produced zeros.
    check(
        "hook or _dry_run_stub" not in src,
        "`hook or _dry_run_stub` is back — hook=None silently stubs again",
    )

    # 2. Every metric field is Optional in the dataclass. A field declared `float` with no default
    #    cannot represent 'not measured'.
    for f in METRIC_FIELDS:
        check(f"{f}: Optional[" in src, f"SandboxResult.{f} is not Optional — it cannot express unmeasured")

    # 3. Unmeasured is the DEFAULT, not a special case someone must remember.
    fresh = SandboxResult(model="s")
    for f in METRIC_FIELDS:
        check(getattr(fresh, f) is None, f"a fresh SandboxResult reports {f}={getattr(fresh, f)!r} instead of None")

    # 4. hook=None raises rather than fabricating a run (R2).
    try:
        run_multi_model(manifest_path=Path("x.json"), models=["a"], workspace=Path("."), hook=None)
        failures.append("run_multi_model(hook=None) returned instead of raising")
    except ValueError:
        pass
    except Exception as exc:
        failures.append(f"run_multi_model(hook=None) raised {type(exc).__name__}, expected ValueError")

    # 5. An unavailable subject does not abort the run, and reports NO metrics.
    def down_hook(subject, manifest_path, workspace):
        if subject == "b":
            raise RuntimeError("endpoint refused connection")
        return SandboxResult(model=subject, tool_selection_accuracy=0.9)

    rows = run_multi_model(
        manifest_path=Path("x.json"), models=["a", "b", "c"], workspace=Path("."), hook=down_hook
    )
    check(len(rows) == 3, "an unavailable subject aborted the remaining subjects")
    check(rows[1].status == "unavailable", "an unreachable subject was not marked unavailable")
    check(bool(rows[1].unavailable_reason), "an unavailable subject carries no reason")
    for f in METRIC_FIELDS:
        check(getattr(rows[1], f) is None, f"an unavailable subject reported {f} — zeros rank it on merit")

    # 6. Unmeasured is excluded from ranking, not ranked last (design D3).
    ranked = rank_subjects(
        [SandboxResult(model="x", tool_efficiency=0.5), SandboxResult(model="y")],
        primary_metric="tool_efficiency",
    )
    check([r.model for r in ranked["ranked"]] == ["x"], "an unmeasured subject was ranked")
    check(
        dict(ranked["excluded"]).get("y") == "unmeasured",
        "an unmeasured subject was not reported as excluded",
    )

    # 7. The report says `unmeasured` in words. A blank cell reads as an oversight and a 0 reads as
    #    a result; it was neither.
    with tempfile.TemporaryDirectory() as tmp:
        out = write_sandbox_report(
            [SandboxResult(model="x", tool_efficiency=0.5)], manifest_id="g", workspace_path=Path(tmp)
        )
        body = out.read_text(encoding="utf-8")
    check("unmeasured" in body, "the report does not render unmeasured metrics as `unmeasured`")

    # 8. The stub still exists but only by name (design D4).
    stubbed = run_multi_model(
        manifest_path=Path("x.json"), models=["a"], workspace=Path("."), hook="dry-run"
    )
    check(stubbed[0].status == "dry-run", "the dry-run stub is not tagged as a dry run")

    if failures:
        for f in failures:
            print(f"[p1] FAIL: {f}")
        print("[p1] GATE FAILED")
        return 1

    p = subprocess.run([sys.executable, "-m", "pytest", *TESTS, "-q"], cwd=str(RUNTIME))
    if p.returncode != 0:
        print("[p1] GATE FAILED (acceptance tests)")
        return p.returncode

    print(
        "[p1] hook=None refused, unmeasured != 0.0 across all 8 metrics, unavailable subject "
        "isolated with a reason, unmeasured excluded from ranking — verified"
    )
    print("[p1] GATE GREEN")
    return 0


if __name__ == "__main__":
    sys.exit(main())
