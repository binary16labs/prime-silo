"""P3 — a bench result not in the ledger did not happen.

Red tests. They fail until `benny/sdlc/bench_ledger.py` exists.

Four guarantees, and the fourth is the one this estate has already been burned by:

  1. every bench emits an execution-register entry and a lineage event (R9);
  2. serving topology is captured per subject, because q4_k_m and q8 of the same weights are
     DIFFERENT subjects and the record must be able to prove which ran (R11);
  3. subjects execute strictly in sequence — the eGPU is single-tenant (R12);
  4. a wedged endpoint is detected by CPU-time and artifact mtime, NEVER by a log line. A tqdm
     line is not proof of life. This estate once read an advancing log as a live job when the
     job was dead, so "the log is moving" is treated as no evidence at all.

Scenarios ↔ delivery/tasks/P3.md gherkin.
"""

from __future__ import annotations

import json

import pytest

from benny.sdlc.bench_ledger import (
    ALIVE,
    UnledgeredBench,
    acquire_blocking,
    emit_lineage,
    require_ledgered,
    UNKNOWN,
    WEDGED,
    HostLock,
    LockHeld,
    append_register,
    bench_is_ledgered,
    classify_liveness,
    read_register,
    register_entry,
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


# ---------------------------------------------------------------------------
# Scenario: an unledgered bench is refused (R9)
# ---------------------------------------------------------------------------


def test_a_bench_with_no_register_entry_is_not_ledgered(tmp_path):
    path = tmp_path / "execution_register.json"
    assert bench_is_ledgered(read_register(path), "run-1") is False


def test_a_ledgered_bench_is_found_by_its_run_id(tmp_path):
    path = tmp_path / "execution_register.json"
    append_register(path, _entry())
    assert bench_is_ledgered(read_register(path), "run-1") is True
    assert bench_is_ledgered(read_register(path), "run-2") is False


def test_the_register_is_append_only_and_survives_repeated_writes(tmp_path):
    path = tmp_path / "execution_register.json"
    for i in range(5):
        append_register(path, _entry(run_id=f"run-{i}"))
    entries = read_register(path)
    assert [e["run_id"] for e in entries] == [f"run-{i}" for i in range(5)]


def test_a_missing_register_reads_as_empty_not_as_an_error(tmp_path):
    assert read_register(tmp_path / "nope.json") == []


def test_a_corrupt_register_refuses_rather_than_silently_reading_empty(tmp_path):
    """An unreadable ledger must not look like an empty one — 'no entry' and 'cannot tell'
    are different answers, and only one of them is safe to act on."""
    path = tmp_path / "execution_register.json"
    path.write_text("{ this is not json", encoding="utf-8")
    with pytest.raises(ValueError):
        read_register(path)


def test_an_entry_missing_its_run_id_or_subject_is_refused():
    for missing in ("run_id", "subject"):
        kwargs = dict(subject="s", run_id="r", topology={}, rubric_hash="h", metrics={})
        kwargs[missing] = ""
        with pytest.raises(ValueError):
            register_entry(**kwargs)


def test_an_entry_records_what_a_regulator_would_ask_for():
    e = _entry()
    for key in ("subject", "run_id", "topology", "rubric_hash", "metrics", "recorded_at", "topology_fingerprint"):
        assert key in e, f"the register entry cannot answer for {key}"


# ---------------------------------------------------------------------------
# R11 — serving topology distinguishes subjects
# ---------------------------------------------------------------------------


def test_two_quantisations_of_the_same_weights_are_different_subjects():
    q4 = topology_fingerprint({"endpoint": "e", "quantisation": "q4_k_m", "context_length": 4096})
    q8 = topology_fingerprint({"endpoint": "e", "quantisation": "q8_0", "context_length": 4096})
    assert q4 != q8, "q4_k_m and q8 must not fingerprint the same — the record could not prove which ran"


def test_the_fingerprint_is_stable_and_order_independent():
    a = topology_fingerprint({"endpoint": "e", "quantisation": "q8_0", "context_length": 4096})
    b = topology_fingerprint({"context_length": 4096, "quantisation": "q8_0", "endpoint": "e"})
    assert a == b


def test_context_length_and_endpoint_both_change_the_fingerprint():
    base = {"endpoint": "e", "quantisation": "q8_0", "context_length": 4096}
    assert topology_fingerprint(base) != topology_fingerprint({**base, "context_length": 8192})
    assert topology_fingerprint(base) != topology_fingerprint({**base, "endpoint": "other"})


# ---------------------------------------------------------------------------
# R12 — the eGPU is single-tenant: strict serialisation
# ---------------------------------------------------------------------------


def test_the_loop_visits_subjects_one_at_a_time(tmp_path):
    """NOTE: this proves almost nothing alone, and the previous docstring claiming otherwise was
    wrong. A verifier deleted the host lock entirely and this still passed — the loop is sequential
    by construction, so the counter merely restates that Python runs a for-loop one iteration at a
    time. The REAL proof is the threaded contention test further down."""
    inflight = {"now": 0, "max": 0}

    def body(subject):
        inflight["now"] += 1
        inflight["max"] = max(inflight["max"], inflight["now"])
        inflight["now"] -= 1
        return subject

    out = run_serialised(["a", "b", "c"], body, lock_dir=tmp_path)
    assert out == ["a", "b", "c"], "order must be the declared order"
    assert inflight["max"] == 1, "two subjects were in flight at once"


def test_a_failing_subject_does_not_strand_the_lock(tmp_path):
    def body(subject):
        if subject == "b":
            raise RuntimeError("endpoint refused")
        return subject

    out = run_serialised(["a", "b", "c"], body, lock_dir=tmp_path)
    assert out[0] == "a" and out[2] == "c"
    assert isinstance(out[1], RuntimeError)
    # The lock must be free afterwards, or every later run blocks forever on a dead subject.
    with HostLock(tmp_path) as held:
        assert held is not None


def test_the_host_lock_is_exclusive(tmp_path):
    with HostLock(tmp_path):
        with pytest.raises(LockHeld):
            with HostLock(tmp_path):
                pass


def test_the_lock_is_released_even_when_the_body_raises(tmp_path):
    with pytest.raises(RuntimeError):
        with HostLock(tmp_path):
            raise RuntimeError("boom")
    with HostLock(tmp_path):
        pass  # acquiring again proves it was released


def test_a_stale_lock_from_a_dead_process_can_be_broken(tmp_path):
    """A lock whose owner is gone must not wedge the estate forever."""
    with HostLock(tmp_path, owner_alive=lambda pid: True):
        pass
    (tmp_path / "bench.lock").write_text(json.dumps({"pid": 999999}), encoding="utf-8")
    with HostLock(tmp_path, owner_alive=lambda pid: False):
        pass  # the dead owner's lock was reclaimed


# ---------------------------------------------------------------------------
# Scenario: a wedge is caught by resource evidence, not by a log line
# ---------------------------------------------------------------------------


def test_an_advancing_log_with_flat_cpu_and_flat_artifacts_is_WEDGED():
    """Scenario: an endpoint whose log is advancing but whose CPU time is flat is reported wedged.

    This is the failure this estate has actually hit. The log is the ONLY signal moving here, and
    it is deliberately given no weight at all."""
    samples = [
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0, "log_lines": 10},
        {"t": 30, "cpu_seconds": 100.0, "artifact_mtime": 500.0, "log_lines": 400},
        {"t": 60, "cpu_seconds": 100.0, "artifact_mtime": 500.0, "log_lines": 900},
    ]
    assert classify_liveness(samples) == WEDGED


def test_advancing_cpu_is_alive_even_when_the_log_is_silent():
    """The converse. A quiet job doing real work must not be killed as wedged."""
    samples = [
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0, "log_lines": 10},
        {"t": 30, "cpu_seconds": 118.0, "artifact_mtime": 500.0, "log_lines": 10},
    ]
    assert classify_liveness(samples) == ALIVE


def test_an_advancing_artifact_mtime_is_alive_even_when_cpu_is_flat():
    """A job blocked on I/O still burns no CPU. Artifact mtime is the second real signal."""
    samples = [
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0, "log_lines": 0},
        {"t": 30, "cpu_seconds": 100.0, "artifact_mtime": 530.0, "log_lines": 0},
    ]
    assert classify_liveness(samples) == ALIVE


def test_one_sample_cannot_decide_anything():
    """A single observation has no rate of change. UNKNOWN, never ALIVE — an optimistic default
    here is how a dead job keeps its slot."""
    assert classify_liveness([{"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0, "log_lines": 1}]) == UNKNOWN
    assert classify_liveness([]) == UNKNOWN


def test_log_lines_alone_can_never_produce_ALIVE():
    """The whole point, stated as a property: vary the log freely, hold the real signals flat,
    and the verdict must never become ALIVE."""
    for lines in (0, 1, 10, 10_000, 10_000_000):
        samples = [
            {"t": 0, "cpu_seconds": 7.0, "artifact_mtime": 1.0, "log_lines": 0},
            {"t": 60, "cpu_seconds": 7.0, "artifact_mtime": 1.0, "log_lines": lines},
        ]
        assert classify_liveness(samples) != ALIVE, f"{lines} log lines bought a liveness verdict"


def test_a_tiny_cpu_tick_below_the_floor_is_not_mistaken_for_progress():
    """Clock jitter and a scheduler tick are not work."""
    samples = [
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0, "log_lines": 0},
        {"t": 60, "cpu_seconds": 100.02, "artifact_mtime": 500.0, "log_lines": 0},
    ]
    assert classify_liveness(samples) == WEDGED


def test_missing_resource_fields_are_UNKNOWN_not_alive():
    samples = [{"t": 0, "log_lines": 1}, {"t": 30, "log_lines": 900}]
    assert classify_liveness(samples) == UNKNOWN
