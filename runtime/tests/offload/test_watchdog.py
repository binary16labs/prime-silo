"""A0 — compute-aware wedge watchdog tests.

All tests here are network-free: a fake clock and a fake compute probe drive the
watchdog so no real lemonade/flm.exe process is required. Real-endpoint behaviour
is exercised separately by scripts/gates/a0.py against the live service.

Scenario mapping (delivery/tasks/A0.md):
- "a wedged generation is detected"          -> test_silence_and_idle_is_wedge_suspected
- "long prefill is not misclassified"        -> test_silence_and_busy_is_prefill_in_progress
- "model process respawn is observable"      -> test_pid_change_resets_clock_as_model_restarted
"""

from __future__ import annotations

from benny.core.offload.watchdog import ComputeState, Watchdog


class _FakeClock:
    def __init__(self, start: float = 0.0):
        self.t = start

    def now(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


class _ScriptedProbe:
    """Feeds a scripted sequence of (pid, ComputeState) samples to the watchdog."""

    def __init__(self, script):
        self._script = list(script)
        self._last = self._script[0] if self._script else (1234, ComputeState.IDLE)

    def sample(self):
        if self._script:
            self._last = self._script.pop(0)
        return self._last


SILENCE_THRESHOLD_S = 120.0
HARD_CEILING_S = 15 * 60.0


def test_no_wedge_while_tokens_are_flowing():
    clock = _FakeClock()
    probe = _ScriptedProbe([(111, ComputeState.BUSY)])
    wd = Watchdog(clock=clock.now, probe=probe.sample)
    wd.on_token()
    clock.advance(30)
    wd.on_token()
    ev = wd.check()
    assert ev.state == "flowing"
    assert not ev.escalate


def test_silence_and_idle_is_wedge_suspected():
    """Given a generation emitting no tokens for 120s AND idle compute,
    When the watchdog fires, Then the run is classified wedge_suspected with a
    ledger-worthy entry and a non-zero-exit-worthy escalate flag; the watchdog
    itself never restarts anything."""
    clock = _FakeClock()
    probe = _ScriptedProbe([(111, ComputeState.IDLE)])
    wd = Watchdog(clock=clock.now, probe=probe.sample)
    wd.on_token()  # last token at t=0
    clock.advance(SILENCE_THRESHOLD_S + 1)
    ev = wd.check()
    assert ev.state == "wedge_suspected"
    assert ev.escalate is True
    assert ev.silence_s >= SILENCE_THRESHOLD_S
    # honest reporting is fine ("not restarted automatically"); the watchdog
    # must never *perform* a restart action — checked structurally below.
    assert "restarting" not in (ev.note or "").lower()


def test_silence_and_busy_is_prefill_in_progress():
    """Given silence for 120s while compute probe reports busy, Then state is
    prefill_in_progress with a heartbeat, and escalate is False (no hard ceiling
    hit yet)."""
    clock = _FakeClock()
    probe = _ScriptedProbe([(111, ComputeState.BUSY)])
    wd = Watchdog(clock=clock.now, probe=probe.sample)
    wd.on_token()
    clock.advance(SILENCE_THRESHOLD_S + 1)
    ev = wd.check()
    assert ev.state == "prefill_in_progress"
    assert ev.escalate is False
    assert ev.heartbeat is True


def test_prefill_only_escalates_past_hard_ceiling():
    """Busy compute holds off escalation right up to the ~15 minute hard ceiling,
    then the watchdog escalates even though compute is still busy (protects
    against a permanently-busy wedge)."""
    clock = _FakeClock()
    probe = _ScriptedProbe([(111, ComputeState.BUSY)])
    wd = Watchdog(clock=clock.now, probe=probe.sample)
    wd.on_token()

    clock.advance(HARD_CEILING_S - 1)
    ev = wd.check()
    assert ev.state == "prefill_in_progress"
    assert ev.escalate is False

    clock.advance(2)
    ev = wd.check()
    assert ev.state == "prefill_in_progress"
    assert ev.escalate is True
    assert "ceiling" in (ev.note or "").lower()


def test_pid_change_resets_clock_as_model_restarted():
    """Given the flm.exe PID changes mid-run, Then a model_restarted event is
    logged and the watchdog clock resets (so a fresh silence window starts)."""
    clock = _FakeClock()
    probe = _ScriptedProbe([(111, ComputeState.IDLE), (222, ComputeState.IDLE)])
    wd = Watchdog(clock=clock.now, probe=probe.sample)
    wd.on_token()
    clock.advance(SILENCE_THRESHOLD_S + 1)
    ev = wd.check()
    assert ev.state == "wedge_suspected"

    # PID respawns; watchdog must observe this as model_restarted and reset,
    # never wedge_suspected on the same stale window.
    clock.advance(1)
    ev2 = wd.check()
    assert ev2.state == "model_restarted"
    assert ev2.escalate is False

    # clock reset -> immediately after respawn, silence is ~0, no wedge yet
    clock.advance(1)
    ev3 = wd.check()
    assert ev3.state in ("flowing", "prefill_in_progress")
    assert ev3.escalate is False


def test_watchdog_never_calls_a_restart_action():
    """The watchdog module must not expose or invoke any service-restart hook —
    NEVER auto-restart the service is a hard constraint, verified structurally."""
    import benny.core.offload.watchdog as wd_mod

    src = open(wd_mod.__file__, encoding="utf-8").read().lower()
    for banned in (
        "subprocess.popen",
        "os.system",
        "taskkill",
        "start lemonade",
        "restart_service",
    ):
        assert banned not in src, f"watchdog module must never restart services (found {banned!r})"


def test_watchdog_event_is_json_serializable_for_ledger():
    clock = _FakeClock()
    probe = _ScriptedProbe([(111, ComputeState.IDLE)])
    wd = Watchdog(clock=clock.now, probe=probe.sample)
    wd.on_token()
    clock.advance(SILENCE_THRESHOLD_S + 1)
    ev = wd.check()
    import json

    payload = ev.to_ledger_dict()
    json.dumps(payload)  # must not raise
    assert payload["state"] == "wedge_suspected"
    assert "silence_s" in payload and "pid" in payload
