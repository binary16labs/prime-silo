"""P3 rework — regression tests for every defect claude-p3-verifier found.

LOG 2026-08-04T20:00Z. Kept in its own file so each fixture stays traceable to the finding that
demanded it: these were written by the person who broke the first version, not by the person who
built it, and that provenance is the point.
"""

from __future__ import annotations

import json
import threading
import time as _time

import pytest

from benny.sdlc.bench_ledger import (
    ALIVE,
    UNKNOWN,
    WEDGED,
    HostLock,
    LockHeld,
    UnledgeredBench,
    acquire_blocking,
    append_register,
    classify_liveness,
    emit_lineage,
    read_register,
    register_entry,
    require_ledgered,
    run_serialised,
    topology_fingerprint,
)


def _entry(**kw):
    base = dict(
        subject="incumbent",
        run_id="run-1",
        topology={"endpoint": "http://localhost:1234", "quantisation": "q4_k_m", "context_length": 4096},
        rubric_hash="fnv1a:dead",
        metrics={"iteration_latency_ms_p95": 340.0},
    )
    base.update(kw)
    return register_entry(**base)


# --- serialisation: the proof the in-flight counter could not give -----------


def test_REAL_contention_two_callers_never_overlap_and_none_is_dropped(tmp_path):
    """A verifier deleted the host lock from run_serialised entirely and every test stayed green,
    because the loop is sequential by construction. This contends for real."""
    peak = {"now": 0, "max": 0}
    guard = threading.Lock()

    def body(subject):
        with guard:
            peak["now"] += 1
            peak["max"] = max(peak["max"], peak["now"])
        _time.sleep(0.15)
        with guard:
            peak["now"] -= 1
        return subject

    out = {}

    def run(tag):
        out[tag] = run_serialised([f"{tag}1", f"{tag}2"], body, lock_dir=tmp_path)

    threads = [threading.Thread(target=run, args=(tag,)) for tag in ("A", "B")]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert peak["max"] == 1, "two subjects genuinely overlapped"
    assert out["A"] == ["A1", "A2"] and out["B"] == ["B1", "B2"]
    assert [v for v in out["A"] + out["B"] if isinstance(v, Exception)] == [], "a contender was dropped"


def test_a_contender_waits_rather_than_being_refused(tmp_path):
    """`LockHeld` used to fall into run_serialised's blanket except, so a contended subject was
    discarded and recorded indistinguishably from an endpoint failure."""
    holder = HostLock(tmp_path).acquire()
    released = []

    def release_on_first_poll(_):
        holder.release()
        released.append(True)

    lock = acquire_blocking(tmp_path, timeout=5.0, sleep=release_on_first_poll)
    assert released, "acquire_blocking did not wait"
    lock.release()


# --- the lineage claim -------------------------------------------------------


def test_emit_lineage_reports_True_only_when_it_actually_emitted():
    """The previous version imported a symbol, never called it, and returned emitted=True. Here
    the import failed so it reported False and looked correct; anywhere openlineage is installed
    it claimed a successful emit having emitted nothing."""
    calls = []
    out = emit_lineage(
        {"run_id": "r1"},
        emitter=lambda: (
            lambda rid, e: calls.append(("start", rid)),
            lambda rid, e: calls.append(("complete", rid)),
        ),
    )
    assert out["emitted"] is True
    assert calls == [("start", "r1"), ("complete", "r1")], "it claimed to emit without emitting"


def test_emit_lineage_reports_False_when_the_sink_is_absent():
    def unavailable():
        raise ImportError("no openlineage")

    out = emit_lineage({"run_id": "r1"}, emitter=unavailable)
    assert out["emitted"] is False and "ImportError" in out["reason"]


def test_a_sink_that_is_present_but_failing_is_not_reported_as_emitted():
    def boom(rid, e):
        raise RuntimeError("marquez down")

    out = emit_lineage({"run_id": "r1"}, emitter=lambda: (boom, boom))
    assert out["emitted"] is False and "marquez down" in out["reason"]


# --- scenario 1 needs a REFUSAL, not a predicate -----------------------------


def test_an_unledgered_bench_is_REFUSED(tmp_path):
    """Scenario: an unledgered bench is refused. The Then clause says it fails; a read-only
    predicate cannot fail anything, and the first version only delivered the ability to notice."""
    with pytest.raises(UnledgeredBench):
        require_ledgered(read_register(tmp_path / "nope.json"), "run-1")
    path = tmp_path / "execution_register.json"
    append_register(path, _entry())
    require_ledgered(read_register(path), "run-1")  # does not raise


# --- liveness: the trailing stall and the absolute thresholds ----------------


def test_a_job_that_died_after_working_does_not_read_ALIVE_forever():
    """Comparing only first and last let one good delta latch ALIVE permanently — the same R12
    failure the log rule exists to prevent, reached through a different door."""
    assert classify_liveness([
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0},
        {"t": 60, "cpu_seconds": 160.0, "artifact_mtime": 500.0},
        {"t": 3600, "cpu_seconds": 160.0, "artifact_mtime": 500.0},
    ]) == WEDGED


def test_thresholds_are_rates_so_the_window_length_matters():
    assert classify_liveness([
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 1.0},
        {"t": 0.5, "cpu_seconds": 100.49, "artifact_mtime": 1.0},
    ]) == ALIVE, "98% busy over half a second was called wedged"
    assert classify_liveness([
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 1.0},
        {"t": 86400, "cpu_seconds": 100.5, "artifact_mtime": 1.0},
    ]) == WEDGED, "half a CPU-second in a day was called alive"


def test_zero_elapsed_time_cannot_produce_progress():
    assert classify_liveness([
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 1.0},
        {"t": 0, "cpu_seconds": 100.5, "artifact_mtime": 1.0},
    ]) == UNKNOWN


def test_out_of_order_samples_do_not_produce_a_false_WEDGED():
    assert classify_liveness([
        {"t": 60, "cpu_seconds": 160.0, "artifact_mtime": 1.0},
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 1.0},
    ]) == ALIVE


def test_unusable_sample_types_are_never_a_crash():
    for bad in (
        [{"t": 0, "cpu_seconds": "100", "artifact_mtime": 1.0}, {"t": 60, "cpu_seconds": "160", "artifact_mtime": 1.0}],
        ["not a dict", {"t": 60, "cpu_seconds": 1.0, "artifact_mtime": 1.0}],
        [{"t": 0, "cpu_seconds": float("nan"), "artifact_mtime": 1.0},
         {"t": 60, "cpu_seconds": float("nan"), "artifact_mtime": 1.0}],
        [{"cpu_seconds": 1.0, "artifact_mtime": 1.0}, {"cpu_seconds": 9.0, "artifact_mtime": 1.0}],
        [{"t": 0, "cpu_seconds": True, "artifact_mtime": 1.0}, {"t": 60, "cpu_seconds": False, "artifact_mtime": 1.0}],
    ):
        assert classify_liveness(bad) in (UNKNOWN, WEDGED), bad


# --- register and fingerprint ------------------------------------------------


def test_concurrent_appends_do_not_lose_entries(tmp_path):
    """40 concurrent appends previously left 2 entries on disk while 4 writers were told they had
    succeeded — the inversion of "a bench not in the ledger did not happen"."""
    path = tmp_path / "execution_register.json"
    append_register(path, _entry(run_id="seed"))
    errors = []

    def writer(i):
        try:
            append_register(path, _entry(run_id=f"run-{i}"))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=writer, args=(i,)) for i in range(12)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert errors == [], f"writers raised: {errors[:2]}"
    assert {e["run_id"] for e in read_register(path)} == {"seed", *(f"run-{i}" for i in range(12))}


def test_a_register_whose_entries_are_not_objects_is_refused(tmp_path):
    path = tmp_path / "execution_register.json"
    path.write_text('["a", 3, null]', encoding="utf-8")
    with pytest.raises(ValueError):
        read_register(path)


def test_a_register_that_is_a_dict_is_refused(tmp_path):
    path = tmp_path / "execution_register.json"
    path.write_text('{"run_id": "r"}', encoding="utf-8")
    with pytest.raises(ValueError):
        read_register(path)


def test_the_fingerprint_refuses_keys_it_does_not_cover():
    """gpu_layers=99 and gpu_layers=0 previously fingerprinted identically — and on a
    single-tenant eGPU, layer offload IS serving topology."""
    with pytest.raises(ValueError) as exc:
        topology_fingerprint({"endpoint": "e", "quantisation": "q8_0", "gpu_layers": 99})
    assert "gpu_layers" in str(exc.value)


def test_model_id_changes_the_fingerprint():
    base = {"endpoint": "e", "quantisation": "q8_0", "context_length": 4096, "model_id": "a"}
    assert topology_fingerprint(base) != topology_fingerprint({**base, "model_id": "b"})


def test_the_entry_carries_the_roster_hash_it_was_given():
    assert _entry(roster_hash="fnv1a:roster")["roster_hash"] == "fnv1a:roster"


# --- lock ownership ----------------------------------------------------------


def test_release_by_a_non_owner_does_not_free_the_lock(tmp_path):
    owner = HostLock(tmp_path).acquire()
    HostLock(tmp_path).release()  # a third party tries to free it
    with pytest.raises(LockHeld):
        HostLock(tmp_path).acquire()
    owner.release()


def test_a_zero_byte_lock_is_not_stolen_from_a_possibly_live_owner(tmp_path):
    """The 0-byte file is exactly the state between an O_EXCL create and the write that follows —
    a live owner mid-acquire had the host taken from under it."""
    (tmp_path / "bench.lock").write_text("", encoding="utf-8")
    with pytest.raises(LockHeld):
        HostLock(tmp_path).acquire()


def test_a_lock_whose_owner_cannot_be_probed_is_treated_as_alive(tmp_path):
    """`_default_owner_alive(4)` returned False, so a privileged process's lock was stolen."""
    (tmp_path / "bench.lock").write_text(json.dumps({"pid": 4, "token": "x"}), encoding="utf-8")

    def permission_denied(pid):
        raise PermissionError("not your process")

    def probe(pid):
        try:
            permission_denied(pid)
        except PermissionError:
            return True
        return False

    with pytest.raises(LockHeld):
        HostLock(tmp_path, owner_alive=probe).acquire()
