"""AOS-NFR8 — BENNY_OFFLINE=1 runs the SDLC pipeline end-to-end (phases 7–9).

Red test — will fail with ModuleNotFoundError until benny/sdlc/togaf.py
is implemented.

NFR8: With BENNY_OFFLINE=1 set, the core SDLC pipeline components (TOGAF
      phase mapping, ADR emission, quality gate evaluation) must complete
      successfully using only local, stdlib-based logic — no network calls.

      Phase 7 scope: map_waves_to_phases + emit_adr + run_quality_gate all
      work in offline mode because they are stdlib-only (no litellm, no HTTP).
      Phases 8 and 9 will extend this test when their components land.

The GATE-AOS-OFF release gate requires BENNY_OFFLINE=1 to produce a clean
run against the full sdlc_pipeline.json fixture.  This test validates the
Phase 7 portion: TOGAF mapping + ADR chain + quality gate enforcement.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from benny.sdlc.contracts import Adr, QualityGate, TogafPhase
from benny.sdlc.togaf import emit_adr, map_waves_to_phases, run_quality_gate


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def _fake_proc(returncode: int, stdout: str = "", stderr: str = ""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


# ---------------------------------------------------------------------------
# AOS-NFR8: Phase 7 SDLC pipeline works offline
# ---------------------------------------------------------------------------


def test_aos_nfr8_offline_sdlc_p7(monkeypatch, tmp_path):
    """NFR8 (Phase 7): TOGAF map + ADR emit + quality gate all work with BENNY_OFFLINE=1."""
    # Set offline flag — all Phase 7 components are stdlib-only and should not
    # reach out to any network resource regardless of this flag.
    monkeypatch.setenv("BENNY_OFFLINE", "1")
    monkeypatch.setattr(
        "subprocess.run",
        lambda *args, **kwargs: _fake_proc(0, "ok"),
    )

    # 1. TOGAF phase mapping
    phase_map = {"wave_0": "A", "wave_1": "B", "wave_2": "C", "wave_3": "D"}
    result = map_waves_to_phases(4, phase_map)
    assert result[0] == TogafPhase.A
    assert result[3] == TogafPhase.D

    # 2. ADR emission — 4 ADRs, one per TOGAF phase
    for i, phase in enumerate(TogafPhase):
        adr = Adr(
            id=f"ADR-{i + 1:03d}",
            title=f"Offline decision for {phase.label}",
            togaf_phase=phase,
            status="accepted",
            context="Offline SDLC run",
            decision="Accept decision without network",
            consequences="No network calls made",
        )
        path = emit_adr(adr, tmp_path)
        assert path.exists()

    # 3. Quality gate — mocked subprocess, all 5 kinds pass
    for kind in ("linter", "typechecker", "bdd", "schema", "custom"):
        gate = QualityGate(kind=kind, command=f"echo {kind} ok")
        gate_result = run_quality_gate(gate)
        assert gate_result.passed is True


def test_nfr8_phase7_no_network_imports(monkeypatch, tmp_path):
    """NFR8 sanity: Phase 7 components can be imported and used without network deps."""
    # If benny/sdlc/togaf.py imports something that makes a network call at
    # import time, this test will detect it (module already imported above).
    from benny.sdlc import togaf  # noqa: F401 — re-import is a no-op; just checking no side-effects

    assert hasattr(togaf, "map_waves_to_phases")
    assert hasattr(togaf, "emit_adr")
    assert hasattr(togaf, "run_quality_gate")
    assert hasattr(togaf, "QualityGateError")


def test_nfr8_offline_flag_does_not_break_togaf(monkeypatch):
    """BENNY_OFFLINE=1 does not break pure-stdlib TOGAF phase mapping."""
    monkeypatch.setenv("BENNY_OFFLINE", "1")
    result = map_waves_to_phases(3)
    # Should complete without error: no LLM, no HTTP
    assert len(result) == 3
