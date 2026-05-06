"""Phase 0 acceptance tests: AOS-F1, AOS-F2.

AOS-F1 — SwarmManifest v1.0 payloads remain valid under the v1.1 schema
         and a v1.1 manifest round-trips without data loss.
AOS-F2 — TogafPhase enum covers exactly ADM phases A–D with correct labels.
"""
import pytest
from benny.core.manifest import SwarmManifest, ManifestConfig
from benny.sdlc.contracts import (
    TogafPhase,
    QualityGate,
    BddScenario,
    Adr,
    ArtifactRef,
    DisclosureEntry,
    ProcessMetric,
    SdlcConfig,
)


# ---------------------------------------------------------------------------
# AOS-F1: backward compatibility + round-trip
# ---------------------------------------------------------------------------


def test_aos_f1_schema_v1_1_back_compat():
    """v1.0 manifest dict validates under v1.1 schema; all new fields have defaults."""
    v1_0_payload = {
        "id": "test-manifest-001",
        "name": "Legacy Manifest",
        "schema_version": "1.0",
    }
    m = SwarmManifest(**v1_0_payload)
    assert m.schema_version == "1.0"
    # New v1.1 fields must exist with defaults — no ValidationError raised above
    assert hasattr(m, "sdlc")
    assert hasattr(m, "policy")
    assert hasattr(m, "memory")
    assert m.sdlc is None
    assert m.policy is None
    assert m.memory is None


def test_aos_f1_v1_1_round_trip():
    """A v1.1 manifest serializes and deserializes without data loss."""
    sdlc_cfg = SdlcConfig(
        togaf_phase=TogafPhase.A,
        quality_gates=[
            QualityGate(kind="linter", command="ruff check .", on_failure="halt")
        ],
    )
    m = SwarmManifest(
        id="test-aos-001",
        name="AOS Round-Trip Test",
        schema_version="1.1",
        sdlc=sdlc_cfg.model_dump(),
    )
    payload = m.model_dump()
    m2 = SwarmManifest(**payload)
    assert m2.id == m.id
    assert m2.schema_version == "1.1"
    assert m2.sdlc is not None
    assert m2.sdlc["togaf_phase"] == TogafPhase.A.value


# ---------------------------------------------------------------------------
# AOS-F2: TOGAF phase enum
# ---------------------------------------------------------------------------


def test_aos_f2_togaf_phase_enum():
    """TogafPhase enum has exactly the four TOGAF ADM phases A–D."""
    phase_values = {p.value for p in TogafPhase}
    assert phase_values == {"A", "B", "C", "D"}


def test_aos_f2_phase_map_validation():
    """Each TOGAF phase carries the correct canonical label."""
    assert TogafPhase.A.label == "Architecture Vision"
    assert TogafPhase.B.label == "Business Architecture"
    assert TogafPhase.C.label == "Information Systems Architecture"
    assert TogafPhase.D.label == "Technology Architecture"


# ---------------------------------------------------------------------------
# Smoke tests for ancillary contract models
# ---------------------------------------------------------------------------


def test_quality_gate_defaults():
    gate = QualityGate(kind="typechecker", command="mypy benny/")
    assert gate.on_failure == "halt"
    assert gate.timeout_s == 120


def test_bdd_scenario_round_trip():
    s = BddScenario(
        id="BDD-001",
        given="a valid manifest",
        when="benny run is called",
        then="all tasks complete",
    )
    assert s.id == "BDD-001"


def test_adr_togaf_phase_field():
    adr = Adr(
        id="ADR-001",
        title="Use PBR for large outputs",
        togaf_phase=TogafPhase.B,
        decision="Store outputs above threshold in artifact store.",
    )
    assert adr.togaf_phase == TogafPhase.B


def test_artifact_ref_uri_required():
    ref = ArtifactRef(uri="artifact://abc123def456")
    assert ref.uri.startswith("artifact://")


def test_disclosure_entry_layers():
    for layer in (1, 2, 3):
        entry = DisclosureEntry(tool_name="my_tool", layer=layer, token_count=100)
        assert entry.layer == layer


def test_process_metric_fields():
    m = ProcessMetric(
        run_id="run-001",
        task_id="task-001",
        wall_s=1.5,
        cpu_s=0.8,
        rss_mb=512.0,
        tokens_in=200,
        tokens_out=50,
        cost_usd=0.001,
        model="qwen3_5_9b",
    )
    assert m.wall_s == 1.5


def test_manifest_config_model_per_persona():
    """ManifestConfig accepts model_per_persona dict (AOS-F1 / OQ-1)."""
    cfg = ManifestConfig(
        model="local_lemonade",
        model_per_persona={"planner": "local_lemonade", "architect": "local_litert"},
    )
    assert cfg.model_per_persona["planner"] == "local_lemonade"
    assert cfg.model_per_persona["architect"] == "local_litert"
