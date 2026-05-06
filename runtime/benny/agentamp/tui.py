"""AAMP-001 Phase 4 — Skinnable Textual TUI (mini-mode).

Public API
----------
  MINIMODE_MIN_COLS / MINIMODE_MIN_ROWS
      Floor terminal dimensions (80×24).  Terminals smaller than this fall
      back to :func:`run_line_mode` (AAMP-F8).

  SkinPalette
      Extracted CLI colour + glyph config from a :class:`SkinCliPalette`.

  extract_palette(cli_palette) -> SkinPalette
      Deterministic extraction — always produces a usable palette regardless
      of how many token the skin has set (AAMP-F7).

  BennyTUI
      Textual :class:`~textual.app.App` with four panes: run-list, current-
      wave, log-tail, and a 1-line status bar.  The palette and glyphs come
      from the active skin; the colour scheme is injected as CSS variables
      at mount time (AAMP-F7).

  run_tui(skin_palette, *, workspace, benny_home, columns, rows) -> int
      Launch the TUI or fall back to line-mode when the terminal is too
      small.  Returns an int exit code.

  run_line_mode(skin_palette, *, workspace) -> int
      Plain-text fallback for terminals narrower than 80 cols or shorter
      than 24 rows (AAMP-F8).

Requirements covered
--------------------
  F7    TUI launches with palette/glyphs from the active skin.
  F8    80×24 floor; smaller terminals fall back to run_line_mode().
  NFR6  BennyTUI is designed for < 300 ms first-frame p95.

Dependencies: textual (optional, soft-import), stdlib.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional

# ---------------------------------------------------------------------------
# Soft import — Textual is optional; absence caught at run_tui() time.
# ---------------------------------------------------------------------------

try:
    from textual.app import App, ComposeResult
    from textual.color import Color
    from textual.css.query import NoMatches
    from textual.widgets import Footer, Header, Label, Log, Static
    from textual.containers import Horizontal, Vertical, ScrollableContainer
    _TEXTUAL_AVAILABLE = True
except ImportError:  # pragma: no cover
    _TEXTUAL_AVAILABLE = False
    App = object  # type: ignore[assignment,misc]
    ComposeResult = None  # type: ignore[assignment]

from .contracts import SkinCliPalette, SkinGlyphs


# ---------------------------------------------------------------------------
# Terminal floor constants (AAMP-F8)
# ---------------------------------------------------------------------------

MINIMODE_MIN_COLS: int = 80
MINIMODE_MIN_ROWS: int = 24


# ---------------------------------------------------------------------------
# Palette extraction
# ---------------------------------------------------------------------------


@dataclass
class SkinPalette:
    """Extracted, ready-to-use palette from a skin's ``cli_palette`` block.

    All fields have safe defaults so the TUI is usable even with a minimal
    or absent skin (AAMP-F7).
    """

    # ANSI colours (CSS-compatible strings)
    bg:     str = "#1a1a2e"
    fg:     str = "#eaeaea"
    accent: str = "#e94560"
    muted:  str = "#6c6c8a"

    # Glyphs
    bullet:  str = "▸"
    running: str = "◆"
    done:    str = "✔"
    failed:  str = "✖"
    warning: str = "⚠"
    paused:  str = "⏸"


def extract_palette(cli_palette: SkinCliPalette) -> SkinPalette:
    """Build a :class:`SkinPalette` from a skin's ``cli_palette`` block.

    Unknown or missing tokens in the skin fall back to the palette defaults.
    This function is pure and deterministic (AAMP-F7).

    Parameters
    ----------
    cli_palette:
        The ``cli_palette`` field of a loaded :class:`~benny.agentamp.contracts.SkinManifest`.
    """
    ansi = cli_palette.ansi or {}
    g = cli_palette.glyphs

    return SkinPalette(
        bg=ansi.get("bg", SkinPalette.bg),
        fg=ansi.get("fg", SkinPalette.fg),
        accent=ansi.get("accent", SkinPalette.accent),
        muted=ansi.get("muted", SkinPalette.muted),
        bullet=g.bullet,
        running=g.running,
        done=g.done,
        failed=g.failed,
        warning=g.warning,
        paused=g.paused,
    )


def _default_palette() -> "SkinPalette":
    return extract_palette(SkinCliPalette())


# ---------------------------------------------------------------------------
# Textual TUI (AAMP-F7)
# ---------------------------------------------------------------------------

# CSS uses Textual CSS variable syntax ($aamp_*) so palette tokens are
# injected at runtime via get_css_variables() (AAMP-F7).
_BASE_CSS = """\
Screen {
    background: $aamp_bg;
    color: $aamp_fg;
}
#run-list {
    width: 30%;
    border: solid $aamp_accent;
    padding: 0 1;
}
#wave-pane {
    border: solid $aamp_accent;
    padding: 0 1;
    height: 50%;
}
#log-pane {
    border: solid $aamp_muted;
    padding: 0 1;
    height: 50%;
}
#status-bar {
    height: 1;
    background: $aamp_accent;
    color: $aamp_bg;
    padding: 0 1;
}
"""


class BennyTUI(App):  # type: ignore[misc]
    """Textual TUI for Benny (AAMP-F7).

    Four panes:
      * run-list  — recent ``benny runs ls`` output
      * wave-pane — current wave / task being processed
      * log-tail  — last N lines from the api log
      * status-bar — 1-line summary (skin id, active run, offline flag)

    The colour scheme and glyphs are driven entirely by the active skin's
    ``cli_palette`` via CSS variables injected by :meth:`get_css_variables`
    (AAMP-F7).
    """

    TITLE = "Benny — AgentAmp Mini-mode"
    CSS = _BASE_CSS

    def __init__(
        self,
        palette: Optional[SkinPalette] = None,
        *,
        workspace: str = "default",
        benny_home: Optional[Path] = None,
    ) -> None:
        # Store palette BEFORE super().__init__() so get_css_variables() works
        self._palette: SkinPalette = palette or _default_palette()
        self._workspace = workspace
        self._benny_home = benny_home or Path(
            os.environ.get("BENNY_HOME", Path.home() / ".benny")
        )
        super().__init__()

    # ------------------------------------------------------------------
    # CSS variable injection (AAMP-F7)
    # ------------------------------------------------------------------

    def get_css_variables(self) -> dict:  # type: ignore[override]
        variables = super().get_css_variables()
        variables.update({
            "aamp_bg":     self._palette.bg,
            "aamp_fg":     self._palette.fg,
            "aamp_accent": self._palette.accent,
            "aamp_muted":  self._palette.muted,
        })
        return variables

    # ------------------------------------------------------------------
    # Textual composition
    # ------------------------------------------------------------------

    def compose(self) -> ComposeResult:  # type: ignore[override]
        p = self._palette
        yield Static(
            f"{p.running} Benny  |  workspace: {self._workspace}",
            id="status-bar",
        )
        with Horizontal():
            yield ScrollableContainer(
                Static(f"{p.bullet} No runs yet.", id="run-list-content"),
                id="run-list",
            )
            with Vertical():
                yield Log(id="wave-pane", highlight=True)
                yield Log(id="log-pane")

    def on_mount(self) -> None:
        p = self._palette
        try:
            wave = self.query_one("#wave-pane", Log)
            wave.write_line(f"{p.running} Waiting for a run …")
        except Exception:
            pass
        try:
            log = self.query_one("#log-pane", Log)
            log.write_line(f"{p.bullet} Log tail will appear here.")
        except Exception:
            pass

    # ------------------------------------------------------------------
    # Convenience (used by tests)
    # ------------------------------------------------------------------

    @property
    def palette(self) -> SkinPalette:
        return self._palette


# ---------------------------------------------------------------------------
# Size check + runner
# ---------------------------------------------------------------------------


def _terminal_size() -> tuple[int, int]:
    """Return (columns, rows) from the real terminal, defaulting to 80×24."""
    try:
        size = os.get_terminal_size()
        return size.columns, size.lines
    except OSError:
        return MINIMODE_MIN_COLS, MINIMODE_MIN_ROWS


def run_line_mode(palette: SkinPalette, *, workspace: str = "default") -> int:
    """Plain-text fallback for terminals < 80×24 (AAMP-F8).

    Prints a summary line and exits — no TUI widgets, no ANSI escape sequences
    that the undersized terminal can't handle.
    """
    p = palette
    print(
        f"{p.warning} Terminal too small for TUI mini-mode "
        f"(need {MINIMODE_MIN_COLS}×{MINIMODE_MIN_ROWS}). "
        "Falling back to line-mode."
    )
    print(f"{p.bullet} workspace: {workspace}")
    print(f"{p.bullet} Run 'benny runs ls' to see recent runs.")
    return 0


def run_tui(
    palette: Optional[SkinPalette] = None,
    *,
    workspace: str = "default",
    benny_home: Optional[Path] = None,
    columns: Optional[int] = None,
    rows: Optional[int] = None,
) -> int:
    """Launch TUI or fall back to line-mode (AAMP-F7, AAMP-F8).

    Parameters
    ----------
    palette:
        Skin palette to use.  Defaults to the built-in default palette.
    workspace:
        Active workspace name, shown in the status bar.
    benny_home:
        Path to BENNY_HOME.  Defaults to ``$BENNY_HOME`` env var.
    columns / rows:
        Override terminal size (used in tests).  If ``None``, the real
        terminal size is queried.
    """
    if not _TEXTUAL_AVAILABLE:  # pragma: no cover
        print(
            "TUI mini-mode requires textual. "
            "Install with: pip install 'textual>=0.80.0'",
            file=sys.stderr,
        )
        return 1

    _palette = palette or _default_palette()

    # Determine terminal dimensions
    if columns is None or rows is None:
        real_cols, real_rows = _terminal_size()
        cols = columns if columns is not None else real_cols
        r    = rows    if rows    is not None else real_rows
    else:
        cols, r = columns, rows

    # AAMP-F8: fall back to line mode when terminal is too small
    if cols < MINIMODE_MIN_COLS or r < MINIMODE_MIN_ROWS:
        return run_line_mode(_palette, workspace=workspace)

    app = BennyTUI(
        _palette,
        workspace=workspace,
        benny_home=benny_home,
    )
    app.run()
    return 0
