"""A0 — compute-aware wedge watchdog (ADR-004 hardening).

Token-silence alone is not evidence of a wedge: a 16k-context prefill on the
FLM/NPU recipe legitimately produces zero output tokens for 20-45s (measured
TTFT 22s @ 7.7k input; larger inputs push higher). The 2026-07-05 incident
misread that as a hang. This module cross-checks silence against a **compute
probe** (flm.exe CPU/NPU activity) before calling anything a wedge:

- silence + BUSY compute  -> ``prefill_in_progress`` (heartbeat, no escalate
  until a ~15 minute hard ceiling — protects against a permanently-busy wedge).
- silence + IDLE compute  -> ``wedge_suspected`` (escalate immediately; honest
  ledger entry, non-zero exit upstream).
- PID change mid-run      -> ``model_restarted`` (never escalates; resets the
  silence clock so the next window starts clean).

Hard constraint: this module NEVER restarts, kills, or otherwise mutates the
model service. It only observes and classifies. See test_watchdog.py::
test_watchdog_never_calls_a_restart_action for the structural guard.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from enum import Enum
from typing import Callable, Optional, Tuple

SILENCE_THRESHOLD_S = 120.0  # do not lower — measured-correct per A0 contract
HARD_CEILING_S = 15 * 60.0  # ~15 minutes, per A0 contract


class ComputeState(str, Enum):
    BUSY = "busy"
    IDLE = "idle"
    UNKNOWN = "unknown"


ComputeSample = Tuple[Optional[int], ComputeState]  # (pid, state)
ComputeProbeFn = Callable[[], ComputeSample]
ClockFn = Callable[[], float]


@dataclass
class WatchdogEvent:
    state: str  # flowing | prefill_in_progress | wedge_suspected | model_restarted
    escalate: bool
    silence_s: float
    pid: Optional[int]
    compute: str
    heartbeat: bool = False
    note: str = ""

    def to_ledger_dict(self) -> dict:
        return {
            "state": self.state,
            "escalate": self.escalate,
            "silence_s": round(self.silence_s, 1),
            "pid": self.pid,
            "compute": self.compute,
            "heartbeat": self.heartbeat,
            "note": self.note,
        }


def _default_clock() -> float:
    return time.monotonic()


def default_flm_compute_probe(process_name: str = "flm.exe") -> ComputeProbeFn:
    """Build a real compute probe backed by psutil (best-effort; falls back to
    UNKNOWN if psutil or the process is unavailable rather than raising — a
    watchdog that crashes is worse than one that reports unknown compute)."""

    def _probe() -> ComputeSample:
        try:
            import psutil  # deferred: keep this module importable without psutil in unit tests
        except Exception:
            return None, ComputeState.UNKNOWN

        try:
            procs = [
                p
                for p in psutil.process_iter(["pid", "name"])
                if p.info.get("name") == process_name
            ]
            if not procs:
                return None, ComputeState.UNKNOWN
            proc = procs[0]
            pid = proc.info["pid"]
            # non-blocking sample: first call primes psutil's internal delta,
            # so callers should poll this probe repeatedly (which the watchdog does).
            cpu = proc.cpu_percent(interval=None)
            state = ComputeState.BUSY if cpu > 1.0 else ComputeState.IDLE
            return pid, state
        except Exception:
            return None, ComputeState.UNKNOWN

    return _probe


class Watchdog:
    """Tracks token arrival and cross-checks silence against a compute probe.

    Usage: call :meth:`on_token` whenever a token arrives, and :meth:`check`
    periodically (e.g. every poll interval while waiting on a generation).
    """

    def __init__(self, clock: ClockFn = _default_clock, probe: Optional[ComputeProbeFn] = None):
        self._clock = clock
        self._probe = probe or default_flm_compute_probe()
        self._last_token_ts = clock()
        self._last_pid: Optional[int] = None
        self._silence_start_ts: Optional[float] = None

    def on_token(self) -> None:
        self._last_token_ts = self._clock()

    def check(self) -> WatchdogEvent:
        now = self._clock()
        silence_s = now - self._last_token_ts
        pid, compute = self._probe()

        # PID respawn detection takes priority over everything else: a changed
        # PID means whatever silence we were tracking belonged to a dead process.
        if self._last_pid is not None and pid is not None and pid != self._last_pid:
            self._last_pid = pid
            self._last_token_ts = now  # reset clock
            return WatchdogEvent(
                state="model_restarted",
                escalate=False,
                silence_s=0.0,
                pid=pid,
                compute=compute.value,
                note=f"flm.exe PID changed to {pid}; watchdog clock reset",
            )
        if pid is not None:
            self._last_pid = pid

        if silence_s < SILENCE_THRESHOLD_S:
            return WatchdogEvent(
                state="flowing",
                escalate=False,
                silence_s=silence_s,
                pid=pid,
                compute=compute.value,
            )

        if compute == ComputeState.BUSY:
            past_ceiling = silence_s >= HARD_CEILING_S
            return WatchdogEvent(
                state="prefill_in_progress",
                escalate=past_ceiling,
                silence_s=silence_s,
                pid=pid,
                compute=compute.value,
                heartbeat=True,
                note=(
                    f"prefill still in progress after {silence_s:.0f}s "
                    f"({'past' if past_ceiling else 'within'} the {HARD_CEILING_S:.0f}s hard ceiling)"
                ),
            )

        # silence + idle (or unknown) compute -> honest failure, never auto-fixed
        return WatchdogEvent(
            state="wedge_suspected",
            escalate=True,
            silence_s=silence_s,
            pid=pid,
            compute=compute.value,
            note=(
                f"no tokens for {silence_s:.0f}s and compute is {compute.value} — "
                f"wedge suspected. The service is NOT restarted automatically."
            ),
        )
