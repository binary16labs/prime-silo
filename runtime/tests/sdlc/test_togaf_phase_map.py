"""AOS-001 Phase 7 — TOGAF phase mapping: map_waves_to_phases.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/togaf.py
is implemented.

Covers the AOS-F2 extension requirement that the togaf_phase_map field maps
wave indices to TogafPhase enum values, with unmapped waves defaulting to
TogafPhase.D (Technology Architecture).
"""

from __future__ import annotations

import pytest

from benny.sdlc.contracts import TogafPhase
from benny.sdlc.togaf import map_waves_to_phases


# ---------------------------------------------------------------------------
# Basic mapping
# ---------------------------------------------------------------------------


class TestMapWavesToPhases:
    """map_waves_to_phases: wave index → TogafPhase."""

    def test_map_waves_basic(self):
        """Explicit phase_map entries are respected."""
        phase_map = {"wave_0": "A", "wave_2": "C"}
        result = map_waves_to_phases(4, phase_map)
        assert result[0] == TogafPhase.A
        assert result[2] == TogafPhase.C

    def test_togaf_unmapped_defaults_to_d(self):
        """Unmapped wave indices default to TogafPhase.D (Technology Architecture)."""
        phase_map = {"wave_0": "A"}
        result = map_waves_to_phases(3, phase_map)
        assert result[1] == TogafPhase.D
        assert result[2] == TogafPhase.D

    def test_togaf_empty_phase_map_all_default(self):
        """Empty phase_map → all waves default to TogafPhase.D."""
        result = map_waves_to_phases(4, {})
        for i in range(4):
            assert result[i] == TogafPhase.D

    def test_togaf_none_phase_map_all_default(self):
        """None phase_map → all waves default to TogafPhase.D."""
        result = map_waves_to_phases(3, None)
        for i in range(3):
            assert result[i] == TogafPhase.D

    def test_togaf_all_waves_mapped(self):
        """All four canonical TOGAF phases can be mapped."""
        phase_map = {
            "wave_0": "A",
            "wave_1": "B",
            "wave_2": "C",
            "wave_3": "D",
        }
        result = map_waves_to_phases(4, phase_map)
        assert result == {
            0: TogafPhase.A,
            1: TogafPhase.B,
            2: TogafPhase.C,
            3: TogafPhase.D,
        }

    def test_togaf_returns_all_wave_indices(self):
        """Result dict contains an entry for every wave index 0..wave_count-1."""
        result = map_waves_to_phases(5)
        assert set(result.keys()) == {0, 1, 2, 3, 4}

    def test_togaf_zero_waves(self):
        """wave_count=0 returns an empty dict (edge case)."""
        result = map_waves_to_phases(0)
        assert result == {}

    def test_togaf_single_wave(self):
        """Single wave maps correctly."""
        result = map_waves_to_phases(1, {"wave_0": "B"})
        assert result == {0: TogafPhase.B}

    def test_togaf_result_values_are_togaf_phase_instances(self):
        """All values in the result are TogafPhase enum members."""
        result = map_waves_to_phases(4, {"wave_1": "C"})
        for val in result.values():
            assert isinstance(val, TogafPhase)

    def test_togaf_extra_phase_map_keys_ignored(self):
        """phase_map entries beyond wave_count are silently ignored."""
        phase_map = {"wave_0": "A", "wave_99": "B"}  # wave_99 doesn't exist
        result = map_waves_to_phases(2, phase_map)
        assert 99 not in result
        assert set(result.keys()) == {0, 1}

    def test_togaf_d_is_technology_architecture(self):
        """TogafPhase.D label confirms 'Technology Architecture' (AOS-F2 invariant)."""
        assert TogafPhase.D.label == "Technology Architecture"

    def test_togaf_phase_d_is_default(self):
        """Default phase for unmapped waves is exactly TogafPhase.D."""
        result = map_waves_to_phases(1, {})
        assert result[0] is TogafPhase.D
