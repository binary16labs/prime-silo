"""AOS-F29, AOS-F30, AOS-NFR9 — Multi-model sandbox runner.

Red tests — will fail with ModuleNotFoundError until
benny/sdlc/sandbox_runner.py is implemented.

AOS-F29: benny sandbox <manifest> --models a,b,c executes the same manifest
         against each model and outputs a side-by-side comparison report.
AOS-F30: Report includes per-model: tool_selection_accuracy, tool_efficiency,
         context_efficiency, iteration_latency_p95, loop_count_p95,
         constraint_adherence, total_cost, total_tokens.
AOS-NFR9: Soak: 10× consecutive successes (tested via 10 runs on smoke manifest).
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benny.sdlc.sandbox_runner import SandboxResult, run_multi_model, write_sandbox_report


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------


def _smoke_hook(model: str, manifest_path: Path, workspace: Path) -> SandboxResult:
    """Minimal test hook — returns a deterministic SandboxResult."""
    return SandboxResult(
        model=model,
        tool_selection_accuracy=0.9,
        tool_efficiency=0.8,
        context_efficiency=0.7,
        iteration_latency_ms_p95=100.0,
        loop_count_p95=2,
        constraint_adherence=1.0,
        total_cost=0.01,
        total_tokens=500,
    )


# ---------------------------------------------------------------------------
# AOS-F29 — multi-model report output
# ---------------------------------------------------------------------------


def test_aos_f29_sandbox_multi_model_report(tmp_path):
    """F29: run_multi_model returns one SandboxResult per model."""
    manifest = tmp_path / "smoke.json"
    manifest.write_text('{"id": "smoke"}', encoding="utf-8")

    results = run_multi_model(
        manifest_path=manifest,
        models=["model_a", "model_b", "model_c"],
        workspace=tmp_path,
        hook=_smoke_hook,
    )

    assert len(results) == 3
    assert {r.model for r in results} == {"model_a", "model_b", "model_c"}


def test_aos_f29_write_sandbox_report(tmp_path):
    """F29: write_sandbox_report creates .md file at data_out/sandbox_reports/."""
    manifest = tmp_path / "smoke.json"
    manifest.write_text('{"id": "smoke-001"}', encoding="utf-8")

    results = run_multi_model(
        manifest_path=manifest,
        models=["model_a", "model_b"],
        workspace=tmp_path,
        hook=_smoke_hook,
    )
    path = write_sandbox_report(
        results,
        manifest_id="smoke-001",
        workspace_path=tmp_path,
    )

    assert path.exists()
    assert path.suffix == ".md"
    assert path.parent == tmp_path / "data_out" / "sandbox_reports"


def test_aos_f29_report_contains_model_names(tmp_path):
    """F29: sandbox report mentions every model that was run."""
    manifest = tmp_path / "smoke.json"
    manifest.write_text('{"id": "m1"}', encoding="utf-8")

    results = run_multi_model(
        manifest_path=manifest,
        models=["alpha", "beta"],
        workspace=tmp_path,
        hook=_smoke_hook,
    )
    path = write_sandbox_report(results, manifest_id="m1", workspace_path=tmp_path)
    content = path.read_text(encoding="utf-8")
    assert "alpha" in content
    assert "beta" in content


# ---------------------------------------------------------------------------
# AOS-F30 — report shape
# ---------------------------------------------------------------------------


def test_aos_f30_report_shape():
    """F30: SandboxResult has all required per-model metric fields."""
    required = {
        "model",
        "tool_selection_accuracy", "tool_efficiency", "context_efficiency",
        "iteration_latency_ms_p95", "loop_count_p95",
        "constraint_adherence", "total_cost", "total_tokens",
    }
    result = _smoke_hook("test_model", Path("."), Path("."))
    for field in required:
        assert hasattr(result, field), f"SandboxResult missing field: {field}"


def test_aos_f30_report_contains_all_metrics(tmp_path):
    """F30: written report includes all 8 required per-model metrics."""
    manifest = tmp_path / "smoke.json"
    manifest.write_text('{"id": "m2"}', encoding="utf-8")

    results = run_multi_model(
        manifest_path=manifest,
        models=["model_x"],
        workspace=tmp_path,
        hook=_smoke_hook,
    )
    path = write_sandbox_report(results, manifest_id="m2", workspace_path=tmp_path)
    content = path.read_text(encoding="utf-8")

    for metric in [
        "tool_selection_accuracy", "tool_efficiency", "context_efficiency",
        "iteration_latency", "loop_count", "constraint_adherence",
        "total_cost", "total_tokens",
    ]:
        assert metric in content, f"Report missing metric: {metric}"


def test_aos_f30_result_values_in_valid_range():
    """F30: accuracy/efficiency/adherence metrics are in [0.0, 1.0]."""
    r = _smoke_hook("model", Path("."), Path("."))
    assert 0.0 <= r.tool_selection_accuracy <= 1.0
    assert 0.0 <= r.tool_efficiency <= 1.0
    assert 0.0 <= r.context_efficiency <= 1.0
    assert 0.0 <= r.constraint_adherence <= 1.0


# ---------------------------------------------------------------------------
# AOS-NFR9 — soak test (10× consecutive)
# ---------------------------------------------------------------------------


def test_aos_nfr9_sandbox_soak_10x(tmp_path):
    """NFR9: 10 consecutive sandbox runs all succeed without error."""
    manifest = tmp_path / "soak.json"
    manifest.write_text('{"id": "soak"}', encoding="utf-8")

    for i in range(10):
        results = run_multi_model(
            manifest_path=manifest,
            models=["model_a"],
            workspace=tmp_path,
            hook=_smoke_hook,
        )
        assert len(results) == 1
        assert results[0].constraint_adherence >= 0.0
