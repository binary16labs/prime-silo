"""AAMP-001 Phase 3 — DSP-A pipeline acceptance tests.

Covers
------
  AAMP-F5   test_aamp_f5_dsp_pure_transform
  AAMP-F6   test_aamp_f6_spectrum_vu_loop
  AAMP-NFR3 test_aamp_nfr3_throughput (≥ 5 000 events/sec)
  AAMP-NFR4 test_aamp_nfr4_replay_determinism
  AAMP-COMP5 test_aamp_comp5_dsp_replay_byte_identical
"""

from __future__ import annotations

import time
from typing import List

import pytest

from benny.agentamp.dsp import (
    DEFAULT_SPECTRUM_BINS,
    DSPTransform,
    Envelope,
    DerivedData,
    envelope_key,
    transform,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _token_event(delta: str, task_id: str = "t1") -> dict:
    return {"type": "token", "delta": delta, "task_id": task_id}


def _wave_event(kind: str, wave_id: str = "w1") -> dict:
    return {"type": kind, "wave_id": wave_id}


def _policy_event(verdict: str) -> dict:
    return {"type": f"policy_{verdict}"}


def _build_stream(n: int) -> List[dict]:
    """Build a reproducible synthetic event stream of length *n*."""
    events = []
    for i in range(n):
        cycle = i % 5
        if cycle == 0:
            events.append(_token_event(f"token-{i}", f"task-{i // 10}"))
        elif cycle == 1:
            events.append(_wave_event("wave_started"))
        elif cycle == 2:
            events.append(_wave_event("wave_ended"))
        elif cycle == 3:
            events.append(_token_event("abc"))
        else:
            events.append({"type": "heartbeat"})
    return events


# ---------------------------------------------------------------------------
# AAMP-F5: pure-functional transform
# ---------------------------------------------------------------------------


def test_aamp_f5_dsp_pure_transform_yields_envelope_per_event():
    """transform() yields exactly one Envelope per input event (AAMP-F5)."""
    stream = _build_stream(20)
    envelopes = list(transform(stream))
    assert len(envelopes) == len(stream)


def test_aamp_f5_transform_envelope_structure():
    """Each Envelope has the required fields from requirement.md §4.4."""
    stream = [_token_event("hello")]
    env = next(iter(transform(stream)))
    assert env.kind == "aamp_event"
    assert isinstance(env.source_event, dict)
    assert isinstance(env.derived, DerivedData)
    assert isinstance(env.captured_at, str) and env.captured_at  # non-empty ISO-8601


def test_aamp_f5_transform_source_event_preserved():
    """source_event in the envelope matches the input dict."""
    event = {"type": "token", "delta": "hi", "task_id": "x"}
    env = next(iter(transform([event])))
    assert env.source_event["type"] == "token"
    assert env.source_event["delta"] == "hi"


def test_aamp_f5_transform_empty_stream():
    """transform() on an empty stream yields nothing (no crash)."""
    assert list(transform([])) == []


def test_aamp_f5_dsp_stateless_across_calls():
    """Two independent transform() calls on the same stream are independent."""
    stream = _build_stream(30)
    run_a = list(transform(stream))
    run_b = list(transform(stream))
    # envelope_key strips captured_at for determinism comparison
    assert [envelope_key(e) for e in run_a] == [envelope_key(e) for e in run_b]


# ---------------------------------------------------------------------------
# AAMP-F6: spectrum, VU, loop index
# ---------------------------------------------------------------------------


def test_aamp_f6_spectrum_bin_count():
    """Spectrum has DEFAULT_SPECTRUM_BINS (32) bins (AAMP-F6)."""
    stream = [_token_event("hello world")]
    env = next(iter(transform(stream)))
    assert len(env.derived.spectrum_bin) == DEFAULT_SPECTRUM_BINS


def test_aamp_f6_spectrum_bins_in_range():
    """All spectrum bins are floats in [0, 1] (AAMP-F6)."""
    stream = [_token_event(f"x" * 100)]
    env = next(iter(transform(stream)))
    for b in env.derived.spectrum_bin:
        assert 0.0 <= b <= 1.0, f"bin value {b} out of range"


def test_aamp_f6_spectrum_sums_to_one_with_tokens():
    """Spectrum bins sum to 1.0 when there are token events (AAMP-F6)."""
    stream = [_token_event("abcdefghijklmnopqrstuvwxyz")]
    env = next(iter(transform(stream)))
    total = sum(env.derived.spectrum_bin)
    assert abs(total - 1.0) < 1e-9, f"spectrum sum {total} != 1.0"


def test_aamp_f6_spectrum_all_zero_without_tokens():
    """Spectrum is all zeros before any token events (AAMP-F6)."""
    env = next(iter(transform([{"type": "heartbeat"}])))
    assert all(b == 0.0 for b in env.derived.spectrum_bin)


def test_aamp_f6_vu_left_rises_on_dispatcher_events():
    """vu_left > 0 after wave_started events (AAMP-F6)."""
    stream = [_wave_event("wave_started")] * 10
    envelopes = list(transform(stream))
    assert envelopes[-1].derived.vu_left > 0.0


def test_aamp_f6_vu_right_rises_on_reasoner_events():
    """vu_right > 0 after wave_ended events (AAMP-F6)."""
    stream = [_wave_event("wave_ended")] * 10
    envelopes = list(transform(stream))
    assert envelopes[-1].derived.vu_right > 0.0


def test_aamp_f6_vu_range():
    """vu_left and vu_right are always in [0, 1] (AAMP-F6)."""
    stream = _build_stream(100)
    for env in transform(stream):
        assert 0.0 <= env.derived.vu_left <= 1.0
        assert 0.0 <= env.derived.vu_right <= 1.0


def test_aamp_f6_loop_index_increments_on_wave_started():
    """loop_index increments exactly once per wave_started event (AAMP-F6)."""
    n_waves = 7
    stream = [_wave_event("wave_started")] * n_waves
    envelopes = list(transform(stream))
    assert envelopes[-1].derived.loop_index == n_waves


def test_aamp_f6_loop_index_zero_without_waves():
    """loop_index stays 0 when no wave_started events are seen."""
    stream = [_token_event("hello")] * 5
    env = list(transform(stream))[-1]
    assert env.derived.loop_index == 0


def test_aamp_f6_policy_state_tracks_last_verdict():
    """policy_state reflects the most-recently-seen policy event (AAMP-F6)."""
    stream = [
        {"type": "policy_denied"},
        {"type": "policy_approved"},
        {"type": "token", "delta": "x"},
        {"type": "policy_denied"},
    ]
    envelopes = list(transform(stream))
    assert envelopes[0].derived.policy_state == "denied"
    assert envelopes[1].derived.policy_state == "approved"
    assert envelopes[2].derived.policy_state == "approved"  # unchanged
    assert envelopes[3].derived.policy_state == "denied"


def test_aamp_f6_policy_state_default():
    """policy_state defaults to 'approved' before any policy event."""
    env = next(iter(transform([{"type": "token", "delta": "hi"}])))
    assert env.derived.policy_state == "approved"


def test_aamp_f6_spectrum_bins_configurable():
    """transform() respects spectrum_bins=16 and spectrum_bins=64."""
    for bins in (16, 64):
        stream = [_token_event("hello")]
        env = next(iter(transform(stream, spectrum_bins=bins)))
        assert len(env.derived.spectrum_bin) == bins


def test_aamp_f6_invalid_spectrum_bins_raises():
    with pytest.raises(ValueError, match="spectrum_bins"):
        DSPTransform(spectrum_bins=33)


# ---------------------------------------------------------------------------
# AAMP-NFR3: throughput ≥ 5 000 events/sec
# ---------------------------------------------------------------------------


def test_aamp_nfr3_throughput():
    """DSP-A processes ≥ 5 000 events/sec on the reference machine (AAMP-NFR3)."""
    n = 10_000
    stream = _build_stream(n)
    t0 = time.perf_counter()
    # Consume the iterator fully (don't let Python short-circuit)
    for _ in transform(stream):
        pass
    elapsed = time.perf_counter() - t0
    rate = n / elapsed
    assert rate >= 5_000, (
        f"DSP-A throughput {rate:.0f} events/sec < 5 000 events/sec (AAMP-NFR3). "
        f"Processed {n} events in {elapsed:.3f}s."
    )


# ---------------------------------------------------------------------------
# AAMP-NFR4: replay determinism (modulo captured_at)
# ---------------------------------------------------------------------------


def test_aamp_nfr4_replay_determinism():
    """Same input log → same envelope_keys on two separate runs (AAMP-NFR4)."""
    stream = _build_stream(200)
    keys_a = [envelope_key(e) for e in transform(stream)]
    keys_b = [envelope_key(e) for e in transform(stream)]
    assert keys_a == keys_b, "DSP-A replay is not deterministic (AAMP-NFR4)"


def test_aamp_nfr4_captured_at_differs_across_runs():
    """captured_at is the only field that may differ between replay runs."""
    stream = [_token_event("hello")]
    env_a = next(iter(transform(stream)))
    env_b = next(iter(transform(stream)))
    # All non-time fields must match
    assert envelope_key(env_a) == envelope_key(env_b)
    # captured_at may differ (wall clock) — we just verify it exists
    assert env_a.captured_at and env_b.captured_at


# ---------------------------------------------------------------------------
# AAMP-COMP5: byte-identical replay via envelope_key
# ---------------------------------------------------------------------------


def test_aamp_comp5_dsp_replay_byte_identical():
    """Re-running a recorded SSE log produces byte-identical envelope keys (AAMP-COMP5)."""
    # Build a realistic mixed stream with policy events
    stream = (
        [_wave_event("wave_started")] * 3
        + [_token_event("The quick brown fox")] * 5
        + [_policy_event("denied")]
        + [_wave_event("wave_ended")] * 3
        + [_policy_event("approved")]
        + [_token_event("jumps over")] * 4
    )

    first_run  = [envelope_key(e) for e in transform(stream)]
    second_run = [envelope_key(e) for e in transform(stream)]
    assert first_run == second_run, (
        "AAMP-COMP5: replay produced different envelopes"
    )


# ---------------------------------------------------------------------------
# DSPTransform direct API
# ---------------------------------------------------------------------------


def test_dsp_transform_reset():
    """reset() clears all accumulators so a fresh run produces fresh output."""
    dsp = DSPTransform()
    for _ in range(20):
        dsp.push(_token_event("abcde"))
        dsp.push(_wave_event("wave_started"))

    dsp.reset()

    # After reset the next event should see loop_index=0 and empty spectrum
    env = dsp.push({"type": "heartbeat"})
    assert env.derived.loop_index == 0
    assert all(b == 0.0 for b in env.derived.spectrum_bin)


def test_dsp_transform_push_returns_envelope():
    dsp = DSPTransform()
    result = dsp.push({"type": "token", "delta": "hi"})
    assert isinstance(result, Envelope)
    assert result.kind == "aamp_event"


def test_envelope_key_excludes_captured_at():
    """envelope_key must not include captured_at."""
    from dataclasses import replace
    env = Envelope(
        source_event={"type": "token"},
        derived=DerivedData(
            spectrum_bin=[0.0] * 32,
            vu_left=0.5,
            vu_right=0.3,
            loop_index=1,
            policy_state="approved",
        ),
        captured_at="2026-01-01T00:00:00+00:00",
    )
    env2 = Envelope(
        source_event={"type": "token"},
        derived=env.derived,
        captured_at="9999-12-31T23:59:59+00:00",
    )
    assert envelope_key(env) == envelope_key(env2)
