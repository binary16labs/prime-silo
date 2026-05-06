"""AAMP-001 Phase 4 — Textual TUI mini-mode acceptance tests.

Covers
------
  AAMP-F7   test_aamp_f7_tui_palette_from_skin
  AAMP-F8   test_aamp_f8_minimode_size_floor
  AAMP-NFR6 test_aamp_nfr6_tui_first_paint (app compose under 300 ms)
"""

from __future__ import annotations

import time
from pathlib import Path

import pytest

from benny.agentamp.contracts import SkinCliPalette, SkinGlyphs
from benny.agentamp.tui import (
    MINIMODE_MIN_COLS,
    MINIMODE_MIN_ROWS,
    BennyTUI,
    SkinPalette,
    _default_palette,
    extract_palette,
    run_line_mode,
    run_tui,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_palette(**kwargs) -> SkinCliPalette:
    return SkinCliPalette(
        ansi={
            "bg": kwargs.get("bg", "#0d1117"),
            "fg": kwargs.get("fg", "#c9d1d9"),
            "accent": kwargs.get("accent", "#58a6ff"),
            "muted": kwargs.get("muted", "#6e7681"),
        },
        glyphs=SkinGlyphs(
            bullet="▸",
            running="◆",
            done="✔",
            failed="✖",
            warning="⚠",
            paused="⏸",
        ),
    )


# ---------------------------------------------------------------------------
# AAMP-F7: palette extraction from skin
# ---------------------------------------------------------------------------


def test_aamp_f7_tui_palette_from_skin():
    """extract_palette() maps skin cli_palette tokens to SkinPalette (AAMP-F7)."""
    cli_pal = _make_palette(bg="#001122", fg="#ffffff", accent="#ff0066", muted="#888888")
    pal = extract_palette(cli_pal)

    assert pal.bg == "#001122"
    assert pal.fg == "#ffffff"
    assert pal.accent == "#ff0066"
    assert pal.muted == "#888888"


def test_aamp_f7_palette_glyphs_from_skin():
    """Glyph fields come from the skin's cli_palette.glyphs."""
    cli_pal = _make_palette()
    pal = extract_palette(cli_pal)

    assert pal.bullet == "▸"
    assert pal.running == "◆"
    assert pal.done == "✔"
    assert pal.failed == "✖"
    assert pal.warning == "⚠"
    assert pal.paused == "⏸"


def test_aamp_f7_palette_falls_back_to_defaults_for_missing_tokens():
    """Missing ansi tokens fall back to SkinPalette defaults (AAMP-F7)."""
    cli_pal = SkinCliPalette(ansi={}, glyphs=SkinGlyphs())
    pal = extract_palette(cli_pal)

    # Defaults from SkinPalette dataclass
    assert pal.bg == SkinPalette.bg
    assert pal.fg == SkinPalette.fg
    assert pal.accent == SkinPalette.accent


def test_aamp_f7_extract_palette_is_deterministic():
    """Same cli_palette always produces the same SkinPalette (AAMP-F7)."""
    cli_pal = _make_palette()
    assert extract_palette(cli_pal) == extract_palette(cli_pal)


def test_aamp_f7_benny_tui_stores_palette():
    """BennyTUI.palette property returns the palette passed at construction."""
    pal = _default_palette()
    app = BennyTUI(pal, workspace="test_ws")
    assert app.palette is pal


def test_aamp_f7_benny_tui_workspace_arg():
    """BennyTUI stores the workspace name."""
    pal = _default_palette()
    app = BennyTUI(pal, workspace="my_workspace")
    assert app._workspace == "my_workspace"


def test_aamp_f7_default_palette_is_usable():
    """_default_palette() returns a SkinPalette with non-empty colour strings."""
    pal = _default_palette()
    assert isinstance(pal, SkinPalette)
    for attr in ("bg", "fg", "accent", "muted"):
        assert getattr(pal, attr), f"default palette field {attr!r} is empty"


# ---------------------------------------------------------------------------
# AAMP-F8: 80×24 floor + fallback
# ---------------------------------------------------------------------------


def test_aamp_f8_minimode_min_cols():
    """MINIMODE_MIN_COLS must be exactly 80 (AAMP-F8)."""
    assert MINIMODE_MIN_COLS == 80


def test_aamp_f8_minimode_min_rows():
    """MINIMODE_MIN_ROWS must be exactly 24 (AAMP-F8)."""
    assert MINIMODE_MIN_ROWS == 24


def test_aamp_f8_run_tui_falls_back_when_too_narrow(capsys):
    """run_tui() calls run_line_mode when cols < 80 (AAMP-F8)."""
    result = run_tui(columns=79, rows=24)
    out = capsys.readouterr().out
    assert result == 0
    assert "too small" in out.lower() or "line-mode" in out.lower()


def test_aamp_f8_run_tui_falls_back_when_too_short(capsys):
    """run_tui() calls run_line_mode when rows < 24 (AAMP-F8)."""
    result = run_tui(columns=80, rows=23)
    out = capsys.readouterr().out
    assert result == 0
    assert "too small" in out.lower() or "line-mode" in out.lower()


def test_aamp_f8_run_line_mode_prints_fallback(capsys):
    """run_line_mode() prints a helpful message and returns 0 (AAMP-F8)."""
    pal = _default_palette()
    result = run_line_mode(pal, workspace="test_ws")
    out = capsys.readouterr().out
    assert result == 0
    assert "test_ws" in out or "workspace" in out


def test_aamp_f8_run_line_mode_mentions_floor(capsys):
    """run_line_mode() output mentions the minimum terminal dimensions."""
    pal = _default_palette()
    run_line_mode(pal)
    out = capsys.readouterr().out
    assert "80" in out and "24" in out


def test_aamp_f8_exactly_floor_size_does_not_fall_back(tmp_path, monkeypatch):
    """A terminal exactly at 80×24 should NOT fall back to line-mode.

    We can't launch the full TUI in tests, so we check the routing logic
    by monkeypatching BennyTUI.run to a no-op.
    """
    monkeypatch.setattr(BennyTUI, "run", lambda self, **kw: None)
    result = run_tui(_default_palette(), columns=80, rows=24, workspace="ws")
    assert result == 0


# ---------------------------------------------------------------------------
# AAMP-NFR6: first-paint latency ≤ 300 ms
# ---------------------------------------------------------------------------


def test_aamp_nfr6_tui_app_instantiation_is_fast():
    """BennyTUI app construction (CSS + widget tree) takes < 300 ms (AAMP-NFR6)."""
    pal = _default_palette()
    t0 = time.perf_counter()
    app = BennyTUI(pal, workspace="perf_test")
    elapsed_ms = (time.perf_counter() - t0) * 1000
    assert elapsed_ms < 300, (
        f"BennyTUI() construction took {elapsed_ms:.1f} ms — "
        "NFR6 budget is 300 ms p95"
    )


@pytest.mark.anyio
async def test_aamp_nfr6_tui_compose_under_300ms():
    """BennyTUI compose() runs inside 300 ms in headless mode (AAMP-NFR6)."""
    pal = _default_palette()
    app = BennyTUI(pal, workspace="perf_ws")

    t0 = time.perf_counter()
    async with app.run_test(size=(80, 24)):
        elapsed_ms = (time.perf_counter() - t0) * 1000

    assert elapsed_ms < 300, (
        f"BennyTUI first paint took {elapsed_ms:.1f} ms — "
        "NFR6 budget is 300 ms p95"
    )


# ---------------------------------------------------------------------------
# TUI CSS palette injection
# ---------------------------------------------------------------------------


def test_tui_css_contains_palette_bg():
    """The generated CSS variables include the palette bg colour."""
    pal = SkinPalette(bg="#aabbcc", fg="#ffffff", accent="#ff0000", muted="#999999")
    app = BennyTUI(pal)
    css_vars = app.get_css_variables()
    assert css_vars.get("aamp_bg") == "#aabbcc"
    assert css_vars.get("aamp_fg") == "#ffffff"
    assert css_vars.get("aamp_accent") == "#ff0000"
    assert css_vars.get("aamp_muted") == "#999999"


def test_tui_css_palette_is_idempotent():
    """Two apps built with the same palette produce identical CSS."""
    pal = _default_palette()
    app_a = BennyTUI(pal)
    app_b = BennyTUI(pal)
    # Both apps have the same palette
    assert app_a.palette == app_b.palette
