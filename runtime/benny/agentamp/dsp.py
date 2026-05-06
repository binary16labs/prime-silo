"""AAMP-001 Phase 3 — DSP-A pipeline (deterministic event-stream transformer).

Public API
----------
  DerivedData
      Computed analytics for a single SSE event: 32-bin spectrum, left/right
      VU meters, loop index, policy state.

  Envelope
      The AAMP DSP-A output unit per requirement.md §4.4.
      ``captured_at`` is the only field excluded from determinism tests.

  DSPTransform
      Stateful accumulator that processes SSE events one at a time and emits
      Envelopes.  Same input sequence → same derived output (AAMP-NFR4/COMP5).

  transform(sse_stream, *, spectrum_bins=32, window_size=64) -> Iterator[Envelope]
      Convenience generator that wraps :class:`DSPTransform`.

Algorithm
---------
Spectrum (AAMP-F6)
  A 32-bin histogram over the character-code distribution of recent token
  deltas.  Each incoming ``token`` event's ``delta`` characters are bucketed
  into ``ord(ch) % spectrum_bins`` and accumulated in a fixed-size ring
  buffer.  Bins are normalised by total character count so each float lies
  in ``[0, 1]`` and the sum is ``1.0`` (or all zeros when the buffer is
  empty).

VU meters (AAMP-F6)
  ``vu_left``  — fraction of recent events that are *dispatcher* events
  (``wave_started``, ``task_started``); represents "outbound / prompt"
  energy.
  ``vu_right`` — fraction of recent events that are *reasoner* events
  (``wave_ended``, ``task_completed``, ``quality_gate_*``); represents
  "inbound / response" energy.
  Both are computed over the most-recent ``window_size`` events.

Loop index (AAMP-F6)
  Monotonically-incrementing counter; advanced on each ``wave_started``
  event, which marks the beginning of a new swarm iteration.

Policy state (AAMP-F6)
  Tracks the most-recently-seen policy event (``"approved"`` / ``"denied"``).

Determinism invariant (AAMP-F5, AAMP-NFR4, AAMP-COMP5)
  ``captured_at`` is stamped at construction time and is the *only*
  non-deterministic field.  All other Envelope fields depend solely on the
  input event sequence.  The helper :func:`envelope_key` strips
  ``captured_at`` so replay tests can compare two runs byte-for-byte.

Dependencies: stdlib only (collections, datetime, typing).
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, Iterable, Iterator, List, Optional


# ---------------------------------------------------------------------------
# Event type constants
# ---------------------------------------------------------------------------

_DISPATCHER_EVENTS = frozenset({
    "wave_started",
    "task_started",
})

_REASONER_EVENTS = frozenset({
    "wave_ended",
    "task_completed",
    "quality_gate_passed",
    "quality_gate_failed",
})

_POLICY_EVENTS = frozenset({
    "policy_denied",
    "policy_approved",
})

# Number of spectrum bins; same as aamp.dsp.spectrum_bins config default.
DEFAULT_SPECTRUM_BINS: int = 32
DEFAULT_WINDOW_SIZE: int = 64   # events; controls VU rolling window


# ---------------------------------------------------------------------------
# Output types
# ---------------------------------------------------------------------------


@dataclass
class DerivedData:
    """Computed analytics for one SSE event (AAMP-F6).

    All fields except ``policy_state`` and ``layout_event`` are numeric;
    all floats lie in [0, 1].

    ``layout_event`` is ``None`` for regular SSE-stream envelopes and is
    set only by :func:`make_layout_envelope` for layout-transition events
    (AAMP-F21).
    """

    spectrum_bin: List[float]           # 32 (or spectrum_bins) floats in [0, 1]
    vu_left: float                      # dispatcher activity ratio [0, 1]
    vu_right: float                     # reasoner activity ratio [0, 1]
    loop_index: int                     # number of wave_started events seen so far
    policy_state: str                   # "approved" | "denied"
    layout_event: Optional[str] = None  # set for layout transitions (AAMP-F21)

    def to_dict(self) -> dict:
        d: dict = {
            "spectrum_bin": self.spectrum_bin,
            "vu_left": self.vu_left,
            "vu_right": self.vu_right,
            "loop_index": self.loop_index,
            "policy_state": self.policy_state,
        }
        if self.layout_event is not None:
            d["layout_event"] = self.layout_event
        return d


@dataclass
class Envelope:
    """DSP-A output unit per requirement.md §4.4.

    ``captured_at`` is excluded from determinism comparisons (use
    :func:`envelope_key` to drop it).
    """

    kind: str = "aamp_event"
    source_event: Dict = field(default_factory=dict)
    derived: DerivedData = field(default_factory=lambda: DerivedData(
        spectrum_bin=[0.0] * DEFAULT_SPECTRUM_BINS,
        vu_left=0.0,
        vu_right=0.0,
        loop_index=0,
        policy_state="approved",
    ))
    captured_at: str = ""  # set at construction; excluded from determinism

    def to_dict(self) -> dict:
        return {
            "kind": self.kind,
            "source_event": self.source_event,
            "derived": self.derived.to_dict(),
            "captured_at": self.captured_at,
        }


def envelope_key(env: Envelope) -> tuple:
    """Return a deterministic key for *env*, omitting ``captured_at``.

    Used by replay tests (AAMP-NFR4, AAMP-COMP5) to compare two runs
    without wall-clock noise.  ``layout_event`` is included so layout-
    transition envelopes remain distinguishable from regular ones.
    """
    d = env.derived
    return (
        env.kind,
        env.source_event.get("type", ""),
        tuple(round(v, 10) for v in d.spectrum_bin),
        round(d.vu_left, 10),
        round(d.vu_right, 10),
        d.loop_index,
        d.policy_state,
        d.layout_event,  # AAMP-F21; None for regular envelopes
    )


# ---------------------------------------------------------------------------
# DSP state machine
# ---------------------------------------------------------------------------


class DSPTransform:
    """Stateful accumulator that maps SSE events to DSP-A Envelopes.

    Same input sequence always produces the same derived output, making
    replay tests straightforward (AAMP-F5, AAMP-NFR4, AAMP-COMP5).

    Parameters
    ----------
    spectrum_bins:
        Number of spectrum bins.  Must be a power of two in [16, 64].
        Default ``32`` (config ``aamp.dsp.spectrum_bins``).
    window_size:
        Rolling window depth (in events) for VU meter calculation.
        Default ``64``.
    """

    def __init__(
        self,
        *,
        spectrum_bins: int = DEFAULT_SPECTRUM_BINS,
        window_size: int = DEFAULT_WINDOW_SIZE,
    ) -> None:
        if spectrum_bins not in (16, 32, 64):
            raise ValueError(
                f"spectrum_bins must be 16, 32, or 64; got {spectrum_bins}"
            )
        self._bins = spectrum_bins
        self._window = window_size

        # Ring buffer of bucket indices from recent token characters
        self._token_buf: deque[int] = deque(maxlen=window_size * 8)

        # Per-event binary flags for VU computation (1 = matched, 0 = not)
        self._dispatcher_buf: deque[int] = deque(maxlen=window_size)
        self._reasoner_buf: deque[int] = deque(maxlen=window_size)

        self._loop_index: int = 0
        self._policy_state: str = "approved"

    # ------------------------------------------------------------------
    # Public
    # ------------------------------------------------------------------

    def push(self, event: dict) -> Envelope:
        """Process one SSE *event* and return an :class:`Envelope`.

        This is the only method needed for stream processing; it is safe to
        call in a tight loop.

        Parameters
        ----------
        event:
            A dict as emitted by :class:`~benny.core.event_bus.EventBus`.
            The ``type`` key is the only required field; all others are
            optional.
        """
        etype: str = event.get("type", "")

        # 1. Spectrum accumulation — token deltas → character buckets
        if etype == "token":
            delta: str = event.get("delta", "")
            for ch in delta:
                self._token_buf.append(ord(ch) % self._bins)

        # 2. VU accumulators
        self._dispatcher_buf.append(1 if etype in _DISPATCHER_EVENTS else 0)
        self._reasoner_buf.append(1 if etype in _REASONER_EVENTS else 0)

        # 3. Loop index — each wave_started = one new swarm iteration
        if etype == "wave_started":
            self._loop_index += 1

        # 4. Policy state — track most-recent policy verdict
        if etype in _POLICY_EVENTS:
            self._policy_state = "denied" if "denied" in etype else "approved"

        # 5. Build and return envelope
        derived = self._compute_derived()
        return Envelope(
            source_event=dict(event),
            derived=derived,
            captured_at=datetime.now(tz=timezone.utc).isoformat(),
        )

    def reset(self) -> None:
        """Reset all accumulators to initial state (useful between replay runs)."""
        self._token_buf.clear()
        self._dispatcher_buf.clear()
        self._reasoner_buf.clear()
        self._loop_index = 0
        self._policy_state = "approved"

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _compute_derived(self) -> DerivedData:
        # --- spectrum ---
        counts = [0] * self._bins
        for bucket in self._token_buf:
            counts[bucket] += 1
        total = sum(counts) or 1  # avoid div-by-zero when buffer is empty
        spectrum = [c / total for c in counts]

        # --- VU ---
        d_list = list(self._dispatcher_buf)
        r_list = list(self._reasoner_buf)
        vu_left  = sum(d_list) / len(d_list) if d_list else 0.0
        vu_right = sum(r_list) / len(r_list) if r_list else 0.0

        return DerivedData(
            spectrum_bin=spectrum,
            vu_left=vu_left,
            vu_right=vu_right,
            loop_index=self._loop_index,
            policy_state=self._policy_state,
        )


# ---------------------------------------------------------------------------
# Layout-event envelope factory (AAMP-F21)
# ---------------------------------------------------------------------------


def make_layout_envelope(
    window_id: str,
    event_type: str,
    *,
    dsp_state: Optional[DerivedData] = None,
    spectrum_bins: int = DEFAULT_SPECTRUM_BINS,
) -> Envelope:
    """Build a DSP-A Envelope for a layout transition event (AAMP-F21).

    Layout transitions (window moved, resized, snapped) are exposed to
    visualisers as first-class DSP-A envelopes.  The ``derived.layout_event``
    field carries the event type string so visualisers can react without
    parsing the raw ``source_event`` dict.

    Parameters
    ----------
    window_id:
        The ``id`` of the layout window whose state changed.
    event_type:
        Layout event type string, e.g. ``"window_moved"``,
        ``"window_resized"``, ``"window_snapped"``.
    dsp_state:
        Optional :class:`DerivedData` baseline to copy spectrum / VU /
        loop_index / policy_state from.  Defaults to zeroed data.
    spectrum_bins:
        Spectrum bin count for the zeroed baseline.  Ignored when
        *dsp_state* is provided.

    Returns
    -------
    Envelope
        An Envelope with ``source_event.type == "aamp_layout"`` and
        ``derived.layout_event == event_type``.
    """
    if dsp_state is not None:
        derived = DerivedData(
            spectrum_bin=list(dsp_state.spectrum_bin),
            vu_left=dsp_state.vu_left,
            vu_right=dsp_state.vu_right,
            loop_index=dsp_state.loop_index,
            policy_state=dsp_state.policy_state,
            layout_event=event_type,
        )
    else:
        derived = DerivedData(
            spectrum_bin=[0.0] * spectrum_bins,
            vu_left=0.0,
            vu_right=0.0,
            loop_index=0,
            policy_state="approved",
            layout_event=event_type,
        )

    return Envelope(
        source_event={
            "type": "aamp_layout",
            "window_id": window_id,
            "event": event_type,
        },
        derived=derived,
        captured_at=datetime.now(tz=timezone.utc).isoformat(),
    )


# ---------------------------------------------------------------------------
# Convenience generator
# ---------------------------------------------------------------------------


def transform(
    sse_stream: Iterable[dict],
    *,
    spectrum_bins: int = DEFAULT_SPECTRUM_BINS,
    window_size: int = DEFAULT_WINDOW_SIZE,
) -> Iterator[Envelope]:
    """Wrap *sse_stream* in a :class:`DSPTransform` and yield Envelopes.

    This is a pure generator — it holds no state outside the local
    :class:`DSPTransform` instance, so it is safe to call concurrently on
    different streams.

    Parameters
    ----------
    sse_stream:
        Any iterable of SSE event dicts.
    spectrum_bins:
        Passed to :class:`DSPTransform`.  Default ``32``.
    window_size:
        Passed to :class:`DSPTransform`.  Default ``64``.

    Yields
    ------
    Envelope
        One per input event, in order.
    """
    dsp = DSPTransform(spectrum_bins=spectrum_bins, window_size=window_size)
    for event in sse_stream:
        yield dsp.push(event)
