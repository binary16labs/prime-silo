"""AAMP-001 Phase 6 — Layout DSL engine (AAMP-F20, AAMP-F21).

Resolves skin-pack layout declarations into concrete pixel coordinates.
The engine supports:

  * **Absolute placement** — ``x``, ``y``, ``w``, ``h`` fields on each
    :class:`~benny.agentamp.contracts.SkinWindow`.
  * **Snap zones** — ``snap`` field: ``"tl"`` (top-left), ``"tr"``
    (top-right), ``"bl"`` (bottom-left), ``"br"`` (bottom-right), ``"c"``
    (centre).  Snap overrides the ``x``/``y`` values.
  * **Minimum sizes** — ``min_w`` / ``min_h`` clamp ``w`` / ``h`` from below.
  * **Viewport clamping** — out-of-bounds placements (after snap + size
    enforcement) are pushed back inside the viewport boundary (AAMP-F20).

Layout transitions emit DSP-A envelopes via
:func:`~benny.agentamp.dsp.make_layout_envelope` so visualisers can react
to window-state changes (AAMP-F21).

Public API
----------
  SNAP_ZONES
      Frozenset of valid snap-zone identifiers.

  LayoutResult
      Resolved window position after snap + clamp.

  resolve_snap(snap, viewport_w, viewport_h, w, h) -> (int, int)
      Compute the ``(x, y)`` origin for a named snap zone.

  clamp_window(x, y, w, h, viewport_w, viewport_h, min_w, min_h)
      -> LayoutResult   Enforce minimum sizes then clamp to viewport boundary.

  apply_layout(skin_layout, viewport_w, viewport_h) -> List[LayoutResult]
      Apply snap + clamp to every window in *skin_layout*.  Returns one
      :class:`LayoutResult` per window in the same order.

  layout_event_envelope(window_id, event_type, *, dsp_state, spectrum_bins)
      -> Envelope
      Factory for DSP-A layout-event envelopes (AAMP-F21).  Delegates to
      :func:`benny.agentamp.dsp.make_layout_envelope`.

Requirements covered
--------------------
  F20   Snap zones, minimum sizes, out-of-bounds clamping.
  F21   Layout transitions emit DSP-A envelopes with derived.layout_event.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Tuple


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

#: Valid snap-zone identifiers (AAMP-F20).
SNAP_ZONES: frozenset[str] = frozenset({"tl", "tr", "bl", "br", "c"})


# ---------------------------------------------------------------------------
# LayoutResult
# ---------------------------------------------------------------------------


@dataclass
class LayoutResult:
    """Resolved window geometry after snap + clamp (AAMP-F20).

    Attributes
    ----------
    window_id:   The ``id`` field from the skin layout window.
    x, y:        Resolved top-left corner (pixels, clamped to viewport).
    w, h:        Final width / height (pixels, at least min_w / min_h).
    snap:        The snap zone that was applied, or ``None``.
    """

    window_id: str
    x: int
    y: int
    w: int
    h: int
    snap: Optional[str]


# ---------------------------------------------------------------------------
# resolve_snap — F20
# ---------------------------------------------------------------------------


def resolve_snap(
    snap: str,
    viewport_w: int,
    viewport_h: int,
    w: int,
    h: int,
) -> Tuple[int, int]:
    """Return the ``(x, y)`` origin for *snap* within the viewport.

    Parameters
    ----------
    snap:
        A snap-zone identifier from :data:`SNAP_ZONES`.
    viewport_w, viewport_h:
        Viewport dimensions in pixels.  Must be positive.
    w, h:
        Window width and height.  Used to compute right/bottom anchors.

    Returns
    -------
    tuple[int, int]
        ``(x, y)`` origin such that the window sits in the requested zone.

    Raises
    ------
    ValueError
        If *snap* is not in :data:`SNAP_ZONES`.
    """
    if snap not in SNAP_ZONES:
        raise ValueError(
            f"Invalid snap zone {snap!r}. Allowed: {sorted(SNAP_ZONES)}"
        )

    if snap == "tl":
        return (0, 0)
    if snap == "tr":
        return (max(0, viewport_w - w), 0)
    if snap == "bl":
        return (0, max(0, viewport_h - h))
    if snap == "br":
        return (max(0, viewport_w - w), max(0, viewport_h - h))
    # "c" — centre
    return (max(0, (viewport_w - w) // 2), max(0, (viewport_h - h) // 2))


# ---------------------------------------------------------------------------
# clamp_window — F20
# ---------------------------------------------------------------------------


def clamp_window(
    x: int,
    y: int,
    w: int,
    h: int,
    viewport_w: int,
    viewport_h: int,
    min_w: int = 0,
    min_h: int = 0,
) -> Tuple[int, int, int, int]:
    """Enforce minimum sizes and clamp the window to the viewport boundary.

    Order of operations (AAMP-F20):
    1. Apply minimum width / height.
    2. Push ``x`` so that ``x + w <= viewport_w`` (clamp right).
    3. Push ``y`` so that ``y + h <= viewport_h`` (clamp bottom).
    4. Clamp ``x >= 0`` and ``y >= 0``.

    Parameters
    ----------
    x, y:             Proposed top-left corner.
    w, h:             Proposed dimensions.
    viewport_w, viewport_h: Viewport size in pixels.  Must be positive.
    min_w, min_h:     Minimum dimensions.  Default 0 (no constraint).

    Returns
    -------
    tuple[int, int, int, int]
        Clamped ``(x, y, w, h)``.
    """
    # 1. Minimum sizes
    w = max(w, min_w)
    h = max(h, min_h)

    # Guard: if window is wider/taller than viewport, shrink to fit
    w = min(w, viewport_w)
    h = min(h, viewport_h)

    # 2–3. Clamp right / bottom edges
    x = min(x, viewport_w - w)
    y = min(y, viewport_h - h)

    # 4. Clamp top-left
    x = max(x, 0)
    y = max(y, 0)

    return (x, y, w, h)


# ---------------------------------------------------------------------------
# apply_layout — F20
# ---------------------------------------------------------------------------


def apply_layout(
    skin_layout: "benny.agentamp.contracts.SkinLayout",  # type: ignore[name-defined]
    viewport_w: int,
    viewport_h: int,
) -> List[LayoutResult]:
    """Apply snap + clamp to every window in *skin_layout*.

    Parameters
    ----------
    skin_layout:
        A :class:`~benny.agentamp.contracts.SkinLayout` instance (from the
        active skin manifest).
    viewport_w, viewport_h:
        Current viewport dimensions in pixels.  Must be positive.

    Returns
    -------
    List[LayoutResult]
        One resolved position per window, in the same order as
        ``skin_layout.windows``.
    """
    results: List[LayoutResult] = []

    for win in skin_layout.windows:
        x, y = win.x, win.y
        w, h = win.w, win.h
        snap = getattr(win, "snap", None)
        min_w = getattr(win, "min_w", 0)
        min_h = getattr(win, "min_h", 0)

        # Apply snap zone (overrides x/y from manifest)
        if snap and snap in SNAP_ZONES:
            x, y = resolve_snap(snap, viewport_w, viewport_h, w, h)

        # Enforce min sizes + clamp to viewport
        x, y, w, h = clamp_window(x, y, w, h, viewport_w, viewport_h, min_w, min_h)

        results.append(
            LayoutResult(
                window_id=win.id,
                x=x,
                y=y,
                w=w,
                h=h,
                snap=snap if snap in SNAP_ZONES else None,
            )
        )

    return results


# ---------------------------------------------------------------------------
# layout_event_envelope — F21
# ---------------------------------------------------------------------------


def layout_event_envelope(
    window_id: str,
    event_type: str,
    *,
    dsp_state: Optional["benny.agentamp.dsp.DerivedData"] = None,  # type: ignore[name-defined]
    spectrum_bins: int = 32,
) -> "benny.agentamp.dsp.Envelope":  # type: ignore[name-defined]
    """Build a DSP-A Envelope for a layout transition event (AAMP-F21).

    Delegates to :func:`benny.agentamp.dsp.make_layout_envelope`.

    Parameters
    ----------
    window_id:
        The ``id`` of the layout window whose state changed.
    event_type:
        Layout event type string, e.g. ``"window_moved"``,
        ``"window_resized"``, ``"window_snapped"``.
    dsp_state:
        Optional :class:`~benny.agentamp.dsp.DerivedData` baseline to
        inherit spectrum / VU from.  Defaults to zeroed data.
    spectrum_bins:
        Spectrum resolution.  Defaults to 32.

    Returns
    -------
    Envelope
        An Envelope with ``derived.layout_event`` set to *event_type*.
    """
    from .dsp import make_layout_envelope  # deferred to avoid circular import

    return make_layout_envelope(
        window_id,
        event_type,
        dsp_state=dsp_state,
        spectrum_bins=spectrum_bins,
    )
