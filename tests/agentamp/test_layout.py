"""AAMP-001 Phase 6 — Layout DSL engine acceptance tests.

Covers
------
  AAMP-F20  test_aamp_f20_layout_snap_zones_clamp
  AAMP-F21  test_aamp_f21_layout_event_envelope
"""

from __future__ import annotations

import pytest

from benny.agentamp.layout import (
    SNAP_ZONES,
    LayoutResult,
    apply_layout,
    clamp_window,
    layout_event_envelope,
    resolve_snap,
)
from benny.agentamp.dsp import DerivedData, Envelope, make_layout_envelope
from benny.agentamp.contracts import SkinLayout, SkinWindow


# ---------------------------------------------------------------------------
# AAMP-F20 — snap zones and viewport clamping
# ---------------------------------------------------------------------------


class TestSnapZones:
    """test_aamp_f20_layout_snap_zones_clamp: snap zone placement."""

    VIEWPORT_W = 1920
    VIEWPORT_H = 1080
    WIN_W = 400
    WIN_H = 300

    def _snap(self, zone: str) -> tuple:
        return resolve_snap(
            zone, self.VIEWPORT_W, self.VIEWPORT_H, self.WIN_W, self.WIN_H
        )

    def test_tl_places_at_origin(self) -> None:
        """'tl' snap zone puts the window at (0, 0)."""
        x, y = self._snap("tl")
        assert (x, y) == (0, 0)

    def test_tr_places_at_top_right(self) -> None:
        """'tr' snap zone puts the window's right edge at viewport_w."""
        x, y = self._snap("tr")
        assert x == self.VIEWPORT_W - self.WIN_W
        assert y == 0

    def test_bl_places_at_bottom_left(self) -> None:
        """'bl' snap zone puts the window's bottom edge at viewport_h."""
        x, y = self._snap("bl")
        assert x == 0
        assert y == self.VIEWPORT_H - self.WIN_H

    def test_br_places_at_bottom_right(self) -> None:
        """'br' snap zone puts the window in the bottom-right corner."""
        x, y = self._snap("br")
        assert x == self.VIEWPORT_W - self.WIN_W
        assert y == self.VIEWPORT_H - self.WIN_H

    def test_center_places_in_middle(self) -> None:
        """'c' snap zone centres the window in the viewport."""
        x, y = self._snap("c")
        assert x == (self.VIEWPORT_W - self.WIN_W) // 2
        assert y == (self.VIEWPORT_H - self.WIN_H) // 2

    def test_all_snap_zones_defined(self) -> None:
        """SNAP_ZONES contains exactly the five documented zones."""
        assert SNAP_ZONES == frozenset({"tl", "tr", "bl", "br", "c"})

    def test_invalid_snap_raises_value_error(self) -> None:
        """resolve_snap raises ValueError for unknown snap zone strings."""
        with pytest.raises(ValueError, match="Invalid snap zone"):
            resolve_snap("lt", 1920, 1080, 400, 300)


class TestClampWindow:
    """test_aamp_f20_layout_snap_zones_clamp: viewport clamping."""

    def test_in_bounds_unchanged(self) -> None:
        """A window that fits inside the viewport is not moved."""
        x, y, w, h = clamp_window(10, 20, 400, 300, 1920, 1080)
        assert (x, y, w, h) == (10, 20, 400, 300)

    def test_negative_x_clamped_to_zero(self) -> None:
        """x < 0 is clamped to 0."""
        x, y, w, h = clamp_window(-50, 0, 400, 300, 1920, 1080)
        assert x == 0

    def test_negative_y_clamped_to_zero(self) -> None:
        """y < 0 is clamped to 0."""
        x, y, w, h = clamp_window(0, -100, 400, 300, 1920, 1080)
        assert y == 0

    def test_right_edge_overflow_clamped(self) -> None:
        """x + w > viewport_w is pushed left so the window fits."""
        x, y, w, h = clamp_window(1800, 0, 400, 300, 1920, 1080)
        assert x + w <= 1920

    def test_bottom_edge_overflow_clamped(self) -> None:
        """y + h > viewport_h is pushed up so the window fits."""
        x, y, w, h = clamp_window(0, 900, 400, 300, 1920, 1080)
        assert y + h <= 1080

    def test_minimum_width_enforced(self) -> None:
        """w is raised to min_w when w < min_w."""
        x, y, w, h = clamp_window(0, 0, 50, 300, 1920, 1080, min_w=200)
        assert w == 200

    def test_minimum_height_enforced(self) -> None:
        """h is raised to min_h when h < min_h."""
        x, y, w, h = clamp_window(0, 0, 400, 50, 1920, 1080, min_h=150)
        assert h == 150

    def test_window_wider_than_viewport_shrunk(self) -> None:
        """A window wider than the viewport is shrunk to viewport_w."""
        x, y, w, h = clamp_window(0, 0, 3000, 300, 1920, 1080)
        assert w <= 1920

    def test_window_taller_than_viewport_shrunk(self) -> None:
        """A window taller than the viewport is shrunk to viewport_h."""
        x, y, w, h = clamp_window(0, 0, 400, 2000, 1920, 1080)
        assert h <= 1080


class TestApplyLayout:
    """test_aamp_f20_layout_snap_zones_clamp: apply_layout integration."""

    def test_applies_snap_to_windows(self) -> None:
        """apply_layout resolves snap zones for each window."""
        layout = SkinLayout(windows=[
            SkinWindow(id="main", x=9999, y=9999, w=920, h=540, snap="tl"),
            SkinWindow(id="playlist", x=9999, y=9999, w=320, h=540, snap="tr"),
        ])
        results = apply_layout(layout, 1920, 1080)
        assert len(results) == 2
        main = next(r for r in results if r.window_id == "main")
        pl = next(r for r in results if r.window_id == "playlist")
        # tl → (0, 0)
        assert main.x == 0
        assert main.y == 0
        assert main.snap == "tl"
        # tr → right edge flush
        assert pl.x == 1920 - 320
        assert pl.y == 0
        assert pl.snap == "tr"

    def test_clamps_out_of_bounds_absolute(self) -> None:
        """Absolute windows that overflow are clamped (no snap)."""
        layout = SkinLayout(windows=[
            SkinWindow(id="win", x=1900, y=1050, w=200, h=100),
        ])
        results = apply_layout(layout, 1920, 1080)
        r = results[0]
        assert r.x + r.w <= 1920
        assert r.y + r.h <= 1080

    def test_returns_one_result_per_window(self) -> None:
        """apply_layout returns exactly len(windows) LayoutResult objects."""
        layout = SkinLayout(windows=[
            SkinWindow(id=f"w{i}", x=0, y=0, w=100, h=100)
            for i in range(5)
        ])
        results = apply_layout(layout, 1920, 1080)
        assert len(results) == 5
        assert all(isinstance(r, LayoutResult) for r in results)

    def test_empty_layout_returns_empty(self) -> None:
        """apply_layout on an empty SkinLayout returns an empty list."""
        results = apply_layout(SkinLayout(windows=[]), 1920, 1080)
        assert results == []

    def test_min_w_enforced_via_skin_window(self) -> None:
        """min_w from SkinWindow is passed through to clamp_window."""
        layout = SkinLayout(windows=[
            SkinWindow(id="tiny", x=0, y=0, w=10, h=10, min_w=100, min_h=80),
        ])
        results = apply_layout(layout, 1920, 1080)
        assert results[0].w >= 100
        assert results[0].h >= 80


# ---------------------------------------------------------------------------
# AAMP-F21 — layout event envelope
# ---------------------------------------------------------------------------


class TestLayoutEventEnvelope:
    """test_aamp_f21_layout_event_envelope: layout transitions emit DSP-A envelopes."""

    def test_envelope_has_layout_event_in_derived(self) -> None:
        """The Envelope derived.layout_event field is set to the event_type."""
        env = make_layout_envelope("main", "window_moved")
        assert env.derived.layout_event == "window_moved"

    def test_envelope_source_event_type_is_aamp_layout(self) -> None:
        """source_event.type is 'aamp_layout' for layout envelopes."""
        env = make_layout_envelope("playlist", "window_resized")
        assert env.source_event["type"] == "aamp_layout"

    def test_envelope_source_event_carries_window_id(self) -> None:
        """source_event.window_id matches the window_id argument."""
        env = make_layout_envelope("vis-panel", "window_snapped")
        assert env.source_event["window_id"] == "vis-panel"

    def test_envelope_source_event_carries_event_name(self) -> None:
        """source_event.event matches the event_type argument."""
        env = make_layout_envelope("main", "window_moved")
        assert env.source_event["event"] == "window_moved"

    def test_envelope_kind_is_aamp_event(self) -> None:
        """The envelope kind is 'aamp_event' (per requirement.md §4.4)."""
        env = make_layout_envelope("main", "window_moved")
        assert env.kind == "aamp_event"

    def test_envelope_captured_at_is_set(self) -> None:
        """captured_at is a non-empty ISO-8601 string."""
        env = make_layout_envelope("main", "window_moved")
        assert env.captured_at  # non-empty

    def test_default_spectrum_is_zeroed(self) -> None:
        """Without a dsp_state, spectrum bins are all 0.0."""
        env = make_layout_envelope("main", "window_moved")
        assert all(v == 0.0 for v in env.derived.spectrum_bin)

    def test_inherits_dsp_state_when_provided(self) -> None:
        """When dsp_state is given, spectrum/VU/loop_index are preserved."""
        baseline = DerivedData(
            spectrum_bin=[0.5] * 32,
            vu_left=0.8,
            vu_right=0.3,
            loop_index=7,
            policy_state="denied",
        )
        env = make_layout_envelope("main", "window_moved", dsp_state=baseline)
        assert env.derived.vu_left == pytest.approx(0.8)
        assert env.derived.vu_right == pytest.approx(0.3)
        assert env.derived.loop_index == 7
        assert env.derived.policy_state == "denied"
        assert env.derived.layout_event == "window_moved"

    def test_layout_event_in_to_dict(self) -> None:
        """DerivedData.to_dict() includes layout_event when it is set."""
        env = make_layout_envelope("main", "window_snapped")
        d = env.derived.to_dict()
        assert "layout_event" in d
        assert d["layout_event"] == "window_snapped"

    def test_layout_event_absent_from_regular_envelope_dict(self) -> None:
        """Regular (non-layout) DerivedData omits layout_event from to_dict()."""
        from benny.agentamp.dsp import DSPTransform
        dsp = DSPTransform()
        env = dsp.push({"type": "token", "delta": "hello"})
        d = env.derived.to_dict()
        assert "layout_event" not in d  # omitted when None

    def test_layout_event_envelope_via_layout_module(self) -> None:
        """layout.layout_event_envelope is a thin wrapper over dsp.make_layout_envelope."""
        env = layout_event_envelope("main", "window_moved")
        assert env.derived.layout_event == "window_moved"

    def test_envelope_key_includes_layout_event(self) -> None:
        """envelope_key includes layout_event so layout envelopes are deterministically distinct."""
        from benny.agentamp.dsp import envelope_key
        env_moved = make_layout_envelope("main", "window_moved")
        env_resized = make_layout_envelope("main", "window_resized")
        assert envelope_key(env_moved) != envelope_key(env_resized)

    @pytest.mark.parametrize("event_type", [
        "window_moved",
        "window_resized",
        "window_snapped",
        "window_opened",
        "window_closed",
    ])
    def test_all_event_types_accepted(self, event_type: str) -> None:
        """make_layout_envelope accepts any event_type string."""
        env = make_layout_envelope("win", event_type)
        assert env.derived.layout_event == event_type
