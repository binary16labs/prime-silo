"""AOS-F28, AOS-F31 — Process-metric records.

Red tests — will fail with ModuleNotFoundError until
benny/sdlc/metrics.py is implemented.

AOS-F28: During every run, benny.sdlc.metrics records the process-metric
         record per §4.5 and persists it to data_out/metrics/{run_id}.json.
AOS-F31: Process metrics are exposed in Phoenix via OTLP attributes on
         the existing workflow span.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benny.sdlc.metrics import ProcessMetric, phoenix_attrs, record


# ---------------------------------------------------------------------------
# AOS-F28 — metrics record persisted
# ---------------------------------------------------------------------------


def test_aos_f28_metrics_record_persisted(tmp_path):
    """F28: record() persists metric to data_out/metrics/{run_id}.json"""
    metric = ProcessMetric(
        run_id="run-001",
        model="local_lemonade",
        tool_selection_accuracy=0.93,
        tool_efficiency=0.81,
        context_efficiency=0.74,
        iteration_latency_ms_p95=4200.0,
        loop_count_p95=3,
        constraint_adherence=1.0,
    )
    path = record(metric, workspace_path=tmp_path)

    assert path.exists()
    assert path.name == "run-001.json"
    assert path.parent == tmp_path / "data_out" / "metrics"

    doc = json.loads(path.read_text(encoding="utf-8"))
    assert doc["run_id"] == "run-001"
    assert doc["model"] == "local_lemonade"
    assert doc["tool_selection_accuracy"] == pytest.approx(0.93)
    assert "captured_at" in doc


def test_aos_f28_metrics_all_fields_present(tmp_path):
    """F28: persisted JSON contains all §4.5 fields."""
    required = {
        "run_id", "model",
        "tool_selection_accuracy", "tool_efficiency", "context_efficiency",
        "iteration_latency_ms_p95", "loop_count_p95",
        "constraint_adherence", "captured_at",
    }
    metric = ProcessMetric(
        run_id="run-002",
        model="lm",
        tool_selection_accuracy=1.0,
        tool_efficiency=1.0,
        context_efficiency=1.0,
        iteration_latency_ms_p95=100.0,
        loop_count_p95=1,
        constraint_adherence=1.0,
    )
    path = record(metric, workspace_path=tmp_path)
    doc = json.loads(path.read_text(encoding="utf-8"))
    missing = required - set(doc.keys())
    assert not missing, f"Missing fields: {missing}"


def test_aos_f28_metrics_idempotent(tmp_path):
    """F28: record() twice with same run_id overwrites cleanly."""
    m = ProcessMetric(run_id="run-003", model="lm",
                      tool_selection_accuracy=0.5, tool_efficiency=0.5,
                      context_efficiency=0.5, iteration_latency_ms_p95=100.0,
                      loop_count_p95=1, constraint_adherence=1.0)
    record(m, workspace_path=tmp_path)
    m2 = ProcessMetric(run_id="run-003", model="lm2",
                       tool_selection_accuracy=0.9, tool_efficiency=0.9,
                       context_efficiency=0.9, iteration_latency_ms_p95=50.0,
                       loop_count_p95=2, constraint_adherence=1.0)
    path2 = record(m2, workspace_path=tmp_path)
    doc = json.loads(path2.read_text(encoding="utf-8"))
    assert doc["model"] == "lm2"


def test_aos_f28_metrics_creates_dir(tmp_path):
    """F28: data_out/metrics/ is created if it doesn't exist."""
    m = ProcessMetric(run_id="run-004", model="lm",
                      tool_selection_accuracy=1.0, tool_efficiency=1.0,
                      context_efficiency=1.0, iteration_latency_ms_p95=1.0,
                      loop_count_p95=1, constraint_adherence=1.0)
    path = record(m, workspace_path=tmp_path)
    assert (tmp_path / "data_out" / "metrics").is_dir()


# ---------------------------------------------------------------------------
# AOS-F31 — Phoenix OTLP attributes
# ---------------------------------------------------------------------------


def test_aos_f31_phoenix_attributes_emitted():
    """F31: phoenix_attrs() returns OTLP attributes in aos.metrics.* namespace."""
    m = ProcessMetric(
        run_id="run-005",
        model="local_lemonade",
        tool_selection_accuracy=0.93,
        tool_efficiency=0.81,
        context_efficiency=0.74,
        iteration_latency_ms_p95=4200.0,
        loop_count_p95=3,
        constraint_adherence=1.0,
    )
    attrs = phoenix_attrs(m)

    assert "aos.metrics.run_id" in attrs
    assert "aos.metrics.model" in attrs
    assert "aos.metrics.tool_selection_accuracy" in attrs
    assert "aos.metrics.tool_efficiency" in attrs
    assert "aos.metrics.context_efficiency" in attrs
    assert "aos.metrics.iteration_latency_ms_p95" in attrs
    assert "aos.metrics.loop_count_p95" in attrs
    assert "aos.metrics.constraint_adherence" in attrs


def test_aos_f31_phoenix_attrs_values():
    """F31: phoenix_attrs() values match the ProcessMetric fields."""
    m = ProcessMetric(
        run_id="run-006",
        model="qwen3",
        tool_selection_accuracy=0.75,
        tool_efficiency=0.60,
        context_efficiency=0.55,
        iteration_latency_ms_p95=3000.0,
        loop_count_p95=5,
        constraint_adherence=0.99,
    )
    attrs = phoenix_attrs(m)
    assert attrs["aos.metrics.run_id"] == "run-006"
    assert attrs["aos.metrics.model"] == "qwen3"
    assert attrs["aos.metrics.tool_selection_accuracy"] == pytest.approx(0.75)
    assert attrs["aos.metrics.constraint_adherence"] == pytest.approx(0.99)
