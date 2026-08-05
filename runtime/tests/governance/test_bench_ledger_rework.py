"""P3 rework — regression tests for every defect claude-p3-verifier found.

LOG 2026-08-04T20:00Z. Kept in its own file so each fixture stays traceable to the finding that
demanded it: these were written by the person who broke the first version, not by the person who
built it, and that provenance is the point.
"""

from __future__ import annotations

import ast
import inspect
import json
import os
import threading
import time as _time
from pathlib import Path

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
    governed_bench,
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


# --- the REAL governance signature, parsed from source (no openlineage import) ----------------
#
# The lineage emitters cannot be imported on this interpreter (governance/__init__ eager-imports
# openlineage). The previous fix "solved" that with a two-argument injected double — which made the
# claim testable and the real path untested, because the double's arity was invented, not the
# production one. Instead we parse the parameter list straight out of governance/lineage.py and
# build a recorder that BINDS every call against it. A recorder rejects any call the real function
# would reject, so the tested arity IS the production arity, and a regression to `start(run_id,
# entry)` makes these tests red rather than sliding past a permissive stub.

_LINEAGE_SRC = Path(__file__).resolve().parents[2] / "benny" / "governance" / "lineage.py"


def _real_signature(func_name: str) -> inspect.Signature:
    tree = ast.parse(_LINEAGE_SRC.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == func_name:
            args = node.args
            n_required = len(args.args) - len(args.defaults)
            params = [
                inspect.Parameter(
                    a.arg,
                    inspect.Parameter.POSITIONAL_OR_KEYWORD,
                    default=inspect.Parameter.empty if i < n_required else None,
                )
                for i, a in enumerate(args.args)
            ]
            return inspect.Signature(params)
    raise AssertionError(f"{func_name} not found in {_LINEAGE_SRC}")


def _recorder(func_name: str, sink: list):
    """A double with the REAL signature of `func_name`. It binds each call against that signature —
    so a call that would not satisfy the real function raises here too — then records the bound
    arguments."""
    sig = _real_signature(func_name)

    def rec(*args, **kwargs):
        bound = sig.bind(*args, **kwargs)
        bound.apply_defaults()
        sink.append(dict(bound.arguments))
        return "run-id"

    rec.__signature__ = sig
    return rec


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


def test_emit_lineage_calls_the_REAL_governance_signature():
    """THE FAIL, closed. The default path called `start(run_id, entry)` into
    `track_workflow_start(workflow_id, workflow_name, workspace, ...)` — it could never emit, and
    only a two-argument injected double returned True. These recorders carry the REAL signatures
    parsed from source, so this passes only because emit_lineage now calls the production shape."""
    started, completed = [], []
    out = emit_lineage(
        {"run_id": "r1", "subject": "incumbent", "topology_fingerprint": "sha256:abc",
         "execution_time_ms": 1234},
        workspace="bench_ws",
        emitter=lambda: (_recorder("track_workflow_start", started),
                         _recorder("track_workflow_complete", completed)),
    )
    assert out["emitted"] is True, out
    assert started[0]["workflow_id"] == "r1"
    assert started[0]["workflow_name"] == "bench/incumbent"
    assert started[0]["workspace"] == "bench_ws"
    assert completed[0]["workflow_id"] == "r1"
    assert completed[0]["workspace"] == "bench_ws"
    assert completed[0]["nodes_executed"] == ["incumbent"]
    assert completed[0]["execution_time_ms"] == 1234


def test_a_workspace_is_required_for_a_governed_lineage_event():
    """A lineage event with no workspace is not a governed run — the parameter is required, so the
    call site cannot forget it the way the arity was forgotten before."""
    with pytest.raises(TypeError):
        emit_lineage({"run_id": "r1", "subject": "s"})  # missing workspace


def test_emit_lineage_reports_False_when_the_sink_is_absent():
    def unavailable():
        raise ImportError("no openlineage")

    out = emit_lineage({"run_id": "r1", "subject": "s"}, workspace="w", emitter=unavailable)
    assert out["emitted"] is False and "ImportError" in out["reason"]


def test_a_sink_that_is_present_but_failing_is_not_reported_as_emitted():
    """A present sink that raises must report False — `emitted` comes from the CALL, not the import.
    The doubles carry the real signature so the failure is a genuine emit failure, not an arity
    mismatch masquerading as one."""
    def boom(*args, **kwargs):
        raise RuntimeError("marquez down")

    out = emit_lineage({"run_id": "r1", "subject": "s"}, workspace="w",
                       emitter=lambda: (boom, boom))
    assert out["emitted"] is False and "marquez down" in out["reason"]


def test_the_default_emitter_targets_the_real_convenience_functions_by_name():
    """The default path must import the REAL functions, not a stand-in. Proven structurally: the
    default emitter's source names track_workflow_start/complete from the governance module, so a
    silent swap to a local no-op cannot pass unnoticed."""
    import benny.sdlc.bench_ledger as mod
    src = inspect.getsource(mod._default_lineage_emitter)
    assert "track_workflow_start" in src and "track_workflow_complete" in src
    assert "governance.lineage" in src


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


def test_artifact_mtime_is_a_rate_too_not_an_absolute_floor():
    """THE SURVIVING FINDING. mtime was left an absolute 1.0s floor while the docstring claimed both
    signals were rates. A job that wrote one artifact 2 seconds into a 24-hour window, then died,
    advanced mtime by 2s — over the absolute floor — and read ALIVE for the whole day. As a rate,
    2s over 86400s is nothing, so it is WEDGED; and mtime advancing WITH the window is still ALIVE."""
    assert classify_liveness([
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0},
        {"t": 86400, "cpu_seconds": 100.0, "artifact_mtime": 502.0},
    ]) == WEDGED, "an artifact advanced 2s in a day was called alive — the absolute-floor bug"
    assert classify_liveness([
        {"t": 0, "cpu_seconds": 100.0, "artifact_mtime": 500.0},
        {"t": 60, "cpu_seconds": 100.0, "artifact_mtime": 560.0},
    ]) == ALIVE, "an artifact advancing with wall time is a live writer, on mtime alone"


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


def test_default_owner_alive_treats_an_unprobeable_pid_as_alive(monkeypatch):
    """THE REAL FUNCTION, not an injected stand-in. The previous test defined its own probe(),
    caught its own PermissionError and never called `_default_owner_alive` at all — the function
    appeared in the whole suite only inside that test's docstring. Here os.kill is forced to raise
    PermissionError and the real function must still report the owner ALIVE, so a privileged or
    other-user process never has its lock stolen."""
    import benny.sdlc.bench_ledger as mod

    def denied(pid, sig):
        raise PermissionError("not your process")

    monkeypatch.setattr(mod.os, "kill", denied)
    assert mod._default_owner_alive(4) is True


def test_default_owner_alive_reports_a_missing_process_as_gone(monkeypatch):
    """The converse, so the check is not just 'always alive': a pid that does not exist is gone,
    which is what makes a crashed bench's lock reclaimable."""
    import benny.sdlc.bench_ledger as mod

    def gone(pid, sig):
        raise ProcessLookupError()

    monkeypatch.setattr(mod.os, "kill", gone)
    assert mod._default_owner_alive(999999) is False


def test_a_reclaimed_then_reacquired_lock_is_not_deleted_by_the_first_owner(tmp_path):
    """THE REPRODUCED THEFT. A acquires; A is judged stale and reclaimed; B acquires with a
    different token. A.release() must NOT delete B's lock — `_token` proves A ACQUIRED, not that it
    STILL holds, so release verifies the ON-DISK token before unlinking."""
    a = HostLock(tmp_path).acquire()
    lock_file = tmp_path / "bench.lock"
    # stand in for reclaim+reacquire: the file now carries B's ownership, not A's
    lock_file.write_text(json.dumps({"pid": os.getpid(), "token": "B-different-token"}), encoding="utf-8")
    a.release()  # A believes it holds; the on-disk token says otherwise
    assert lock_file.exists(), "A deleted B's lock — the theft race the fix removes"
    owner = json.loads(lock_file.read_text(encoding="utf-8"))
    assert owner["token"] == "B-different-token", "A overwrote B's ownership"


def test_a_lock_that_cannot_be_unlinked_is_tombstoned_so_it_is_reclaimable(tmp_path, monkeypatch):
    """BLOCKER #4. When unlink genuinely fails (a stuck Windows handle), the old code left a
    live-pid lock and claimed 'the stale check will reclaim it' — false, because the pid is alive.
    Release now writes a `released` tombstone that the stale check DOES reclaim."""
    import benny.sdlc.bench_ledger as mod

    a = HostLock(tmp_path).acquire()
    real = mod._retry_on_sharing_violation

    def fail_only_unlink(action, *, what):
        if what == "host lock release":
            raise PermissionError("stuck handle")
        return real(action, what=what)

    monkeypatch.setattr(mod, "_retry_on_sharing_violation", fail_only_unlink)
    a.release()  # unlink fails -> tombstone written
    owner = json.loads((tmp_path / "bench.lock").read_text(encoding="utf-8"))
    assert owner == {"released": True}, owner
    # the tombstoned lock is reclaimable by the next acquirer (real retry restored)
    monkeypatch.setattr(mod, "_retry_on_sharing_violation", real)
    b = HostLock(tmp_path).acquire()
    b.release()


def test_a_released_tombstone_is_reclaimed_by_a_fresh_acquirer(tmp_path):
    (tmp_path / "bench.lock").write_text(json.dumps({"released": True}), encoding="utf-8")
    lock = HostLock(tmp_path).acquire()  # must not raise LockHeld
    lock.release()


def test_boolean_resource_values_are_not_numbers_and_read_UNKNOWN():
    """The verifier's second vacuous fixture used `in (UNKNOWN, WEDGED)` — wide enough that removing
    the boolean guard (bool lands on WEDGED, also permitted) survived. This pins the boolean case to
    UNKNOWN specifically, so dropping the guard turns it red."""
    assert classify_liveness([
        {"t": 0, "cpu_seconds": True, "artifact_mtime": 1.0},
        {"t": 60, "cpu_seconds": False, "artifact_mtime": 1.0},
    ]) == UNKNOWN


# --- the parts are WIRED: they compose into one governed run -----------------


def test_governed_bench_ledgers_serialises_and_emits_end_to_end(tmp_path):
    """BLOCKER #5 — 'nothing is wired'. governed_bench is the single call a live bench makes; here
    two subjects run through the whole pipeline and each ends up in the register with a real lineage
    event, on the real emit signature (injected recorders carry the parsed-from-source arity)."""
    reg = tmp_path / "execution_register.json"
    started, completed = [], []

    def body(subject):
        return f"run-{subject}", {"iteration_latency_ms_p95": 120.0}

    def topo(subject):
        return {"endpoint": "http://localhost:1234", "quantisation": "q4_k_m"}

    out = governed_bench(
        ["a", "b"], body, lock_dir=tmp_path, register_path=reg, workspace="bench_ws",
        rubric_hash="fnv1a:dead", topology_of=topo,
        emitter=lambda: (_recorder("track_workflow_start", started),
                         _recorder("track_workflow_complete", completed)),
    )
    assert [r["subject"] for r in out] == ["a", "b"]
    assert all(r["error"] is None for r in out), out
    assert all(r["lineage"]["emitted"] is True for r in out), out
    # every subject is in the ledger — a bench not in the ledger did not happen
    assert {e["run_id"] for e in read_register(reg)} == {"run-a", "run-b"}
    # the lineage carried the real workflow ids and the workspace, twice
    assert {c["workflow_id"] for c in started} == {"run-a", "run-b"}
    assert all(c["workspace"] == "bench_ws" for c in started + completed)


def test_governed_bench_isolates_a_failing_subject(tmp_path):
    """A subject whose body raises yields an error record and does not stop the others — and the
    survivor is still ledgered."""
    reg = tmp_path / "execution_register.json"

    def body(subject):
        if subject == "boom":
            raise RuntimeError("endpoint refused")
        return f"run-{subject}", {"iteration_latency_ms_p95": 120.0}

    out = governed_bench(
        ["ok", "boom"], body, lock_dir=tmp_path, register_path=reg, workspace="w",
        rubric_hash="h", topology_of=lambda s: {"endpoint": "e", "quantisation": "q8_0"},
        emitter=lambda: (_recorder("track_workflow_start", []),
                         _recorder("track_workflow_complete", [])),
    )
    by = {r["subject"]: r for r in out}
    assert by["ok"]["error"] is None and by["ok"]["run_id"] == "run-ok"
    assert by["boom"]["error"] and "endpoint refused" in by["boom"]["error"]
    assert {e["run_id"] for e in read_register(reg)} == {"run-ok"}
