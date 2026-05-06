"""AOS-001 Phase 7 — AOS-F4: ADR emission + AOS-OBS4: Phoenix OTLP attributes.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/togaf.py
is implemented.

F4:   emit_adr() writes ADR-{seq:03d}.md to data_out/adr/ with context,
      decision, consequences, and a back-reference to the TOGAF phase.
      Sequence numbers are monotonic per workspace (calling emit_adr three
      times yields ADR-001, ADR-002, ADR-003 with no gaps).

OBS4: phoenix_adr_attrs() and phoenix_quality_gate_attrs() return dicts
      with all required OTLP span attributes in the aos.* namespace.
"""

from __future__ import annotations

import pytest

from benny.sdlc.contracts import Adr, QualityGate, TogafPhase
from benny.sdlc.togaf import (
    build_adr_event,
    emit_adr,
    next_adr_seq,
    phoenix_adr_attrs,
    phoenix_quality_gate_attrs,
)

# ---------------------------------------------------------------------------
# Test fixture ADR
# ---------------------------------------------------------------------------


def _make_adr(
    adr_id: str = "ADR-TEST-001",
    phase: TogafPhase = TogafPhase.B,
    title: str = "Use Pydantic for data contracts",
) -> Adr:
    return Adr(
        id=adr_id,
        title=title,
        togaf_phase=phase,
        status="accepted",
        context="The team needs a consistent approach to data validation.",
        decision="Use Pydantic v2 for all data contract models in benny/sdlc/.",
        consequences="All new models must import from pydantic. Validated at Phase 0 gate.",
    )


# ---------------------------------------------------------------------------
# AOS-F4: ADR emission
# ---------------------------------------------------------------------------


class TestAdrEmission:
    """AOS-F4: emit_adr writes correct ADR markdown files."""

    def test_aos_f4_adr_emission(self, tmp_path):
        """F4 primary: emit_adr creates an ADR-001.md with required sections."""
        adr = _make_adr()
        path = emit_adr(adr, tmp_path)

        assert path.exists(), f"ADR file not created: {path}"
        content = path.read_text(encoding="utf-8")

        # Title must appear
        assert "Use Pydantic for data contracts" in content
        # TOGAF phase reference
        assert "B" in content
        # Context section
        assert "Context" in content
        # Decision section
        assert "Decision" in content
        # Consequences section
        assert "Consequences" in content

    def test_f4_adr_file_is_markdown(self, tmp_path):
        """ADR file has .md extension and starts with # heading."""
        adr = _make_adr()
        path = emit_adr(adr, tmp_path)
        assert path.suffix == ".md"
        content = path.read_text(encoding="utf-8")
        assert content.startswith("#")

    def test_f4_adr_filename_is_adr_001(self, tmp_path):
        """First ADR in a workspace gets sequence number 001."""
        adr = _make_adr()
        path = emit_adr(adr, tmp_path)
        assert path.name == "ADR-001.md"

    def test_f4_adr_content_includes_id(self, tmp_path):
        """ADR content includes the ADR id from the Adr model."""
        adr = _make_adr(adr_id="ADR-TEST-XYZ")
        path = emit_adr(adr, tmp_path)
        content = path.read_text(encoding="utf-8")
        assert "ADR-TEST-XYZ" in content

    def test_f4_adr_content_includes_togaf_phase_label(self, tmp_path):
        """ADR content includes the human-readable TOGAF phase label."""
        adr = _make_adr(phase=TogafPhase.C)
        path = emit_adr(adr, tmp_path)
        content = path.read_text(encoding="utf-8")
        assert "Information Systems Architecture" in content

    def test_f4_adr_created_in_data_out_adr_dir(self, tmp_path):
        """ADR file is written under workspace/data_out/adr/."""
        adr = _make_adr()
        path = emit_adr(adr, tmp_path)
        expected_parent = tmp_path / "data_out" / "adr"
        assert path.parent == expected_parent

    def test_f4_adr_dir_created_automatically(self, tmp_path):
        """data_out/adr/ directory is created if it does not exist."""
        adr_dir = tmp_path / "data_out" / "adr"
        assert not adr_dir.exists()
        emit_adr(_make_adr(), tmp_path)
        assert adr_dir.exists()

    def test_aos_f4_adr_sequence_monotonic(self, tmp_path):
        """F4 primary: three consecutive emits produce ADR-001, ADR-002, ADR-003."""
        paths = [emit_adr(_make_adr(adr_id=f"ADR-{i}"), tmp_path) for i in range(3)]
        names = [p.name for p in paths]
        assert names == ["ADR-001.md", "ADR-002.md", "ADR-003.md"]

    def test_f4_sequence_no_gaps(self, tmp_path):
        """Sequence numbers are contiguous — no gaps between emissions."""
        for i in range(5):
            emit_adr(_make_adr(adr_id=f"ADR-G-{i}"), tmp_path)
        adr_dir = tmp_path / "data_out" / "adr"
        files = sorted(adr_dir.glob("ADR-*.md"))
        seqs = [int(f.stem.split("-")[1]) for f in files]
        assert seqs == list(range(1, 6))

    def test_f4_subsequent_emit_does_not_overwrite(self, tmp_path):
        """Emitting a second ADR does not overwrite the first."""
        adr1 = _make_adr(title="First Decision")
        adr2 = _make_adr(title="Second Decision")
        path1 = emit_adr(adr1, tmp_path)
        path2 = emit_adr(adr2, tmp_path)
        assert path1 != path2
        assert path1.exists()
        assert "First Decision" in path1.read_text(encoding="utf-8")

    def test_f4_all_togaf_phases_emittable(self, tmp_path):
        """ADRs for all four TOGAF phases can be emitted."""
        for phase in TogafPhase:
            adr = _make_adr(phase=phase, title=f"Decision for phase {phase.value}")
            path = emit_adr(adr, tmp_path)
            content = path.read_text(encoding="utf-8")
            assert phase.value in content


# ---------------------------------------------------------------------------
# next_adr_seq helper
# ---------------------------------------------------------------------------


class TestNextAdrSeq:
    """next_adr_seq returns the correct next sequence number."""

    def test_seq_starts_at_1_when_empty(self, tmp_path):
        """Empty directory → next seq is 1."""
        adr_dir = tmp_path / "data_out" / "adr"
        adr_dir.mkdir(parents=True)
        assert next_adr_seq(adr_dir) == 1

    def test_seq_increments_after_existing_files(self, tmp_path):
        """With ADR-001.md and ADR-002.md present, next seq is 3."""
        adr_dir = tmp_path / "data_out" / "adr"
        adr_dir.mkdir(parents=True)
        (adr_dir / "ADR-001.md").write_text("# ADR-001")
        (adr_dir / "ADR-002.md").write_text("# ADR-002")
        assert next_adr_seq(adr_dir) == 3

    def test_seq_creates_dir_if_absent(self, tmp_path):
        """next_adr_seq creates the adr_dir if it does not exist."""
        adr_dir = tmp_path / "some" / "new" / "dir"
        assert not adr_dir.exists()
        seq = next_adr_seq(adr_dir)
        assert seq == 1
        assert adr_dir.exists()


# ---------------------------------------------------------------------------
# AOS-OBS4: Phoenix OTLP attributes
# ---------------------------------------------------------------------------


class TestPhoenixAttrs:
    """AOS-OBS4: Phoenix OTLP attribute dicts for ADR and quality gate spans."""

    def test_aos_obs4_phoenix_attrs(self):
        """OBS4 primary: phoenix_adr_attrs has all required aos.* namespace keys."""
        attrs = phoenix_adr_attrs("ADR-001", phase=TogafPhase.A, seq=1)
        assert attrs["aos.adr.id"] == "ADR-001"
        assert attrs["aos.adr.seq"] == 1
        assert attrs["aos.adr.togaf_phase"] == "A"
        assert "aos.adr.togaf_label" in attrs

    def test_obs4_quality_gate_attrs(self):
        """phoenix_quality_gate_attrs has all required aos.quality_gate.* keys."""
        gate = QualityGate(kind="linter", command="ruff check .")
        attrs = phoenix_quality_gate_attrs(gate, exit_code=0, passed=True)
        assert attrs["aos.quality_gate.kind"] == "linter"
        assert attrs["aos.quality_gate.command"] == "ruff check ."
        assert attrs["aos.quality_gate.exit_code"] == 0
        assert attrs["aos.quality_gate.passed"] is True
        assert "aos.quality_gate.on_failure" in attrs

    def test_obs4_adr_togaf_label_is_correct(self):
        """ADR attrs togaf_label matches the phase's canonical label."""
        for phase in TogafPhase:
            attrs = phoenix_adr_attrs(f"ADR-{phase.value}", phase=phase, seq=1)
            assert attrs["aos.adr.togaf_label"] == phase.label

    def test_obs4_quality_gate_passed_false_on_failure(self):
        """phoenix_quality_gate_attrs with passed=False reflects correctly."""
        gate = QualityGate(kind="bdd", command="pytest -k bdd", on_failure="retry")
        attrs = phoenix_quality_gate_attrs(gate, exit_code=1, passed=False)
        assert attrs["aos.quality_gate.passed"] is False
        assert attrs["aos.quality_gate.exit_code"] == 1
        assert attrs["aos.quality_gate.on_failure"] == "retry"

    def test_obs4_all_keys_in_aos_namespace(self):
        """All OTLP attribute keys are in the aos.* namespace."""
        gate = QualityGate(kind="schema", command="jsonschema validate .")
        qg_attrs = phoenix_quality_gate_attrs(gate, exit_code=0, passed=True)
        for key in qg_attrs:
            assert key.startswith("aos."), f"Key {key!r} is not in aos.* namespace"

        adr_attrs_dict = phoenix_adr_attrs("ADR-001", phase=TogafPhase.D, seq=5)
        for key in adr_attrs_dict:
            assert key.startswith("aos."), f"Key {key!r} is not in aos.* namespace"


# ---------------------------------------------------------------------------
# AOS-OBS3: adr_emitted SSE event schema (from build_adr_event)
# ---------------------------------------------------------------------------


class TestAdrSseEvent:
    """AOS-OBS3 (continued): adr_emitted SSE event has required fields."""

    def test_adr_emitted_event_schema(self):
        """build_adr_event returns a dict with all required SSE fields."""
        event = build_adr_event("ADR-001", phase=TogafPhase.B, path="/ws/data_out/adr/ADR-001.md")
        assert event["event"] == "adr_emitted"
        assert event["adr_id"] == "ADR-001"
        assert event["togaf_phase"] == "B"
        assert event["togaf_label"] == "Business Architecture"
        assert event["path"] == "/ws/data_out/adr/ADR-001.md"

    def test_adr_emitted_all_required_fields_present(self):
        """All 5 required fields are present in every adr_emitted event."""
        required = {"event", "adr_id", "togaf_phase", "togaf_label", "path"}
        event = build_adr_event("ADR-007", phase=TogafPhase.D, path="/some/path.md")
        missing = required - set(event.keys())
        assert not missing, f"Missing SSE fields: {missing}"
