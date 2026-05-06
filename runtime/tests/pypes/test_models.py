"""Schema-level tests for the Pypes manifest contract."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from benny.pypes.models import (
    EngineType,
    FormatType,
    MedallionStage,
    OperationSpec,
    PipelineStep,
    PypesManifest,
    SourceSpec,
    ValidationSpec,
)

DEMO_MANIFEST = (
    Path(__file__).resolve().parents[2]
    / "manifests"
    / "templates"
    / "financial_risk_pipeline.json"
)


def test_demo_manifest_loads_and_round_trips():
    raw = json.loads(DEMO_MANIFEST.read_text(encoding="utf-8"))
    m = PypesManifest.model_validate(raw)
    assert m.id == "financial-risk-demo"
    assert m.kind == "pypes_pipeline"
    assert len(m.steps) == 4
    # Round-trip: dump → reload → equal
    again = PypesManifest.model_validate_json(m.model_dump_json())
    assert again.id == m.id
    assert [s.id for s in again.steps] == [s.id for s in m.steps]


def test_step_outputs_must_be_unique():
    with pytest.raises(Exception):
        PipelineStep(id="bad", outputs=["a", "a"])


def test_manifest_step_ids_must_be_unique():
    s1 = PipelineStep(id="s1", outputs=["x"])
    s2 = PipelineStep(id="s1", outputs=["y"])  # duplicate
    with pytest.raises(Exception):
        PypesManifest(id="m", name="m", steps=[s1, s2])


def test_step_lookup_helpers():
    raw = json.loads(DEMO_MANIFEST.read_text(encoding="utf-8"))
    m = PypesManifest.model_validate(raw)
    assert m.step("gold_exposure") is not None
    assert m.step("nonexistent") is None
    assert m.report("counterparty_risk") is not None


def test_clp_binding_present_on_gold_steps():
    """CLP discipline: every gold step in the demo declares a clp_binding."""
    raw = json.loads(DEMO_MANIFEST.read_text(encoding="utf-8"))
    m = PypesManifest.model_validate(raw)
    for s in m.steps:
        if s.stage == MedallionStage.GOLD:
            assert s.clp_binding, f"gold step '{s.id}' missing clp_binding"


def test_validation_spec_thresholds_are_typed():
    vs = ValidationSpec(
        thresholds=[{"field": "notional", "max": 100_000_000}],
        completeness=["trade_id"],
        uniqueness=["trade_id"],
    )
    assert vs.thresholds[0]["field"] == "notional"
    assert vs.completeness == ["trade_id"]


def test_engine_and_format_enums_match_strings():
    assert EngineType("pandas") == EngineType.PANDAS
    assert FormatType("parquet") == FormatType.PARQUET


def test_source_spec_accepts_csv_and_parquet():
    SourceSpec(uri="data_in/x.csv", format=FormatType.CSV)
    SourceSpec(uri="data_out/y.parquet", format=FormatType.PARQUET)


def test_operation_spec_passthrough_params():
    op = OperationSpec(operation="filter", params={"column": "status", "op": "==", "value": "completed"})
    assert op.operation == "filter"
    assert op.params["column"] == "status"
