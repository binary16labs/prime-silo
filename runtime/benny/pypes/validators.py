"""Validation runner — completeness, uniqueness, thresholds, move analysis.

Validators are *engine-agnostic*: every check goes through the engine
protocol, so a rule written in the manifest works identically on
Pandas, Polars, or any future backend.

Move analysis compares the current step output to the **same step** in
a prior run. It reads the prior run's checkpoint (parquet) — so if
a checkpoint is missing (e.g. the prior run failed before reaching
this step) the check downgrades to ``WARN`` rather than ``FAIL``.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from .engine import ExecutionEngine
from .models import ValidationResult, ValidationSpec


def run_validations(
    engine: ExecutionEngine,
    df: Any,
    spec: Optional[ValidationSpec],
    baseline_df: Optional[Any] = None,
) -> ValidationResult:
    """Execute ``spec`` against ``df`` and return a typed result."""
    result = ValidationResult()
    result.row_count = engine.row_count(df)
    result.column_count = len(engine.columns(df))
    result.fingerprint = engine.fingerprint(df)

    if spec is None:
        return result

    # 1. Completeness
    for col in spec.completeness:
        nulls = engine.null_count(df, col)
        check: Dict[str, Any] = {"check": "completeness", "field": col, "nulls": nulls}
        if nulls > 0:
            check["status"] = "FAILED"
            result.status = "FAIL"
        else:
            check["status"] = "PASSED"
        result.checks.append(check)

    # 2. Uniqueness
    for col in spec.uniqueness:
        dups = engine.duplicate_count(df, [col])
        check = {"check": "uniqueness", "field": col, "duplicates": dups}
        if dups > 0:
            check["status"] = "FAILED"
            result.status = "FAIL"
        else:
            check["status"] = "PASSED"
        result.checks.append(check)

    # 3. Thresholds
    for t in spec.thresholds:
        field = t.get("field")
        if field is None:
            continue
        mm = engine.min_max(df, field)
        check = {
            "check": "threshold",
            "field": field,
            "observed": mm,
            "expected": {k: v for k, v in t.items() if k in ("min", "max")},
        }
        violation = False
        if "max" in t and mm.get("max") is not None and mm["max"] > t["max"]:
            violation = True
        if "min" in t and mm.get("min") is not None and mm["min"] < t["min"]:
            violation = True
        if violation:
            check["status"] = "FAILED"
            result.status = "FAIL"
        else:
            check["status"] = "PASSED"
        result.checks.append(check)

    # 4. Row-count bounds
    if spec.row_count:
        rc = result.row_count or 0
        check = {"check": "row_count", "observed": rc, "expected": spec.row_count}
        if ("min" in spec.row_count and rc < spec.row_count["min"]) or (
            "max" in spec.row_count and rc > spec.row_count["max"]
        ):
            check["status"] = "FAILED"
            result.status = "FAIL"
        else:
            check["status"] = "PASSED"
        result.checks.append(check)

    # 5. Move analysis (z-score / IQR against baseline)
    if spec.move_analysis:
        mv = spec.move_analysis
        field = mv.get("field")
        threshold_pct = float(mv.get("threshold_percent", 20.0))
        if field is None:
            result.checks.append({"check": "move_analysis", "status": "SKIPPED", "reason": "no field"})
        elif baseline_df is None:
            result.checks.append(
                {"check": "move_analysis", "field": field, "status": "WARN", "reason": "no baseline checkpoint"}
            )
            if result.status == "PASS":
                result.status = "WARN"
        else:
            cur = engine.describe(df, field)
            base = engine.describe(baseline_df, field)
            cur_mean = cur.get("mean")
            base_mean = base.get("mean")
            check = {
                "check": "move_analysis",
                "field": field,
                "current": cur,
                "baseline": base,
                "threshold_percent": threshold_pct,
            }
            if cur_mean is None or base_mean is None or not base_mean:
                check["status"] = "WARN"
                check["reason"] = "insufficient data"
                if result.status == "PASS":
                    result.status = "WARN"
            else:
                delta_pct = abs(cur_mean - base_mean) / abs(base_mean) * 100.0
                check["delta_percent"] = round(delta_pct, 4)
                if delta_pct > threshold_pct:
                    check["status"] = "FAILED"
                    result.status = "FAIL"
                else:
                    check["status"] = "PASSED"
            result.checks.append(check)

    return result
