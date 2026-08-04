"""P3 — a bench result not in the ledger did not happen.

Four guarantees, one module:

  1. **Ledger (R9).** Every bench emits an execution-register entry, and a lineage event through
     the existing governance path. A result with no entry is not a result.
  2. **Topology (R11).** Serving topology is fingerprinted per subject, because q4_k_m and q8 of
     the same weights are DIFFERENT subjects and the record must be able to prove which one ran.
  3. **Serialisation (R12).** The eGPU is single-tenant, so subjects run strictly in sequence under
     a host lock, and a subject that throws releases it.
  4. **Liveness (R12).** Wedge detection uses CPU-time and artifact mtime, **never a log line** —
     this estate once read an advancing tqdm line as proof of life for a dead job. `log_lines` is
     carried only so it can be shown to have no influence at any volume.

Placement: `benny.sdlc`, not `benny.governance` — that package's `__init__` imports `openlineage`
eagerly, so it is unimportable, and therefore untestable, wherever that dependency is absent. An
untestable ledger is not a ledger. The lineage emitter is imported lazily and reports whether it
actually emitted. (Same defect class as `benny.pypes`; both deserve their own contract.)

Design: architecture/SOLUTION-model-plurality.md §4.4. Contract: delivery/tasks/P3.md
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

log = logging.getLogger(__name__)  # AOS-OBS2

_LOCK_ATTEMPTS = 8

ALIVE = "alive"
WEDGED = "wedged"
UNKNOWN = "unknown"

#: Fraction of elapsed wall time the process must be on-CPU to count as working. A RATE, not an
#: absolute: an absolute floor judges a one-second window and a one-day window identically.
CPU_RATE_FLOOR = 0.01
#: Artifact mtime must move by at least this to count as progress.
MTIME_FLOOR_SECONDS = 1.0


# ---------------------------------------------------------------------------
# Topology — which engine actually ran (R11)
# ---------------------------------------------------------------------------

#: The fields that make two runs different subjects rather than two samples of one.
TOPOLOGY_KEYS = ("endpoint", "quantisation", "context_length", "model_id")


def topology_fingerprint(topology: Dict[str, Any]) -> str:
    """Stable, order-independent fingerprint of a serving topology.

    Canonicalised by sorting, so a dict written in a different order fingerprints the same and a
    changed quantisation does not.
    """
    # Unknown keys are REFUSED rather than dropped. Silently ignoring them let gpu_layers=99 and
    # gpu_layers=0 fingerprint identically — and on a single-tenant eGPU, layer offload IS serving
    # topology. A fingerprint whose job is to prove which engine ran must not quietly discard the
    # evidence that distinguishes them.
    unknown = sorted(set(topology or {}) - set(TOPOLOGY_KEYS))
    if unknown:
        raise ValueError(
            f"topology carries keys this fingerprint does not cover: {unknown}. Add them to "
            "TOPOLOGY_KEYS or drop them — silently ignoring them would make two different engines "
            "fingerprint the same"
        )
    canonical = json.dumps(
        {k: topology.get(k) for k in sorted(TOPOLOGY_KEYS)}, separators=(",", ":"), sort_keys=True
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _retry_on_sharing_violation(action: Callable[[], Any], *, what: str) -> None:
    """Windows raises WinError 32 when a contender has the file open for its staleness read.
    Giving up here strands a lock or loses a write, so retry briefly. Used by both the register
    replace and the lock unlink, which had the same loop twice."""
    for attempt in range(_LOCK_ATTEMPTS):
        try:
            action()
            return
        except PermissionError:
            if attempt == _LOCK_ATTEMPTS - 1:
                log.error("bench: %s still blocked after %d attempts", what, _LOCK_ATTEMPTS)
                raise
            time.sleep(0.02)


# ---------------------------------------------------------------------------
# The execution register (R9)
# ---------------------------------------------------------------------------


def register_entry(
    *,
    subject: str,
    run_id: str,
    topology: Dict[str, Any],
    rubric_hash: str,
    metrics: Dict[str, Any],
    roster_hash: Optional[str] = None,
    recorded_at: Optional[str] = None,
) -> Dict[str, Any]:
    """Build one execution-register entry. Fails closed on the fields that identify a run."""
    if not subject:
        raise ValueError("a register entry without a subject cannot be attributed to anything")
    if not run_id:
        raise ValueError("a register entry without a run_id cannot be traced back to its events")
    return {
        "kind": "bench_execution/1",
        "subject": subject,
        "run_id": run_id,
        "topology": dict(topology or {}),
        "topology_fingerprint": topology_fingerprint(topology or {}),
        "rubric_hash": rubric_hash,
        "roster_hash": roster_hash,
        "metrics": dict(metrics or {}),
        "recorded_at": recorded_at or datetime.now(timezone.utc).isoformat(),
    }


def read_register(path: Path) -> List[Dict[str, Any]]:
    """Read the register. A MISSING file is empty; a CORRUPT one raises — those are different
    answers, and treating an unreadable ledger as empty would let a bench look unledgered when in
    truth we cannot tell."""
    p = Path(path)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"execution register at {p} is corrupt: {exc}") from exc
    if not isinstance(data, list):
        raise ValueError(f"execution register at {p} is not a list of entries")
    if any(not isinstance(e, dict) for e in data):
        raise ValueError(f"execution register at {p} contains entries that are not objects")
    return data


def append_register(path: Path, entry: Dict[str, Any], *, timeout: float = 60.0) -> Dict[str, Any]:
    """Append one entry. Crash-atomic AND concurrency-safe.

    The first version used one temp filename for every writer and an unguarded read-modify-write.
    Under 40 concurrent appends, three writers were handed a SUCCESS return for entries that never
    reached disk — the precise inversion of "a bench not in the ledger did not happen". The temp
    name is now per-process-and-thread, and the whole read-modify-write is serialised by the same
    host lock the bench runner uses.
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    # WAIT for the register lock rather than raising: a concurrent writer must be queued, not
    # dropped. Using the raising lock here would have reintroduced the same lost-write defect in a
    # second place — one writer told it succeeded while its entry never reached disk.
    lock = acquire_blocking(p.parent, name="register.lock", timeout=timeout)
    try:
        entries = read_register(p)
        entries.append(entry)
        tmp = p.with_suffix(f"{p.suffix}.{os.getpid()}.{threading.get_ident()}.tmp")
        tmp.write_text(json.dumps(entries, indent=2), encoding="utf-8")
        _retry_on_sharing_violation(lambda: os.replace(tmp, p), what="register replace")
    finally:
        lock.release()
    return entry


class UnledgeredBench(RuntimeError):
    """A bench that emitted no execution-register entry. It did not happen."""


def require_ledgered(entries: Sequence[Dict[str, Any]], run_id: str) -> None:
    """REFUSE an unledgered bench. Scenario 1's Then clause says "it fails", and a read-only
    predicate cannot fail anything — the first version delivered the ability to notice."""
    if not bench_is_ledgered(entries, run_id):
        raise UnledgeredBench(
            f"bench {run_id!r} has no execution-register entry — an unledgered bench did not "
            "happen (R9), and its numbers may not be reported"
        )


def bench_is_ledgered(entries: Sequence[Dict[str, Any]], run_id: str) -> bool:
    return any(e.get("run_id") == run_id for e in entries)


def _default_lineage_emitter():
    """The real RunEvent emitters, imported lazily. Raises if the governance path is unavailable."""
    from ..governance.lineage import track_workflow_complete, track_workflow_start

    return track_workflow_start, track_workflow_complete


def emit_lineage(entry: Dict[str, Any], *, emitter: Optional[Callable[[], Any]] = None) -> Dict[str, Any]:
    """Emit an OpenLineage RunEvent for a bench, through the existing governance path.

    The previous version IMPORTED a symbol and never called it, then returned ``emitted: True``.
    Where `openlineage` is absent the import failed and it reported False, which is exactly why it
    looked correct — but on any machine with the dependency installed it claimed a successful emit
    having emitted nothing. `emitted` is now set from whether the CALL ran, never from whether an
    import succeeded, and a sink that is present but failing reports False with its reason.

    `emitter` is injectable so the claim is testable on an interpreter without `openlineage` — the
    contract requires that a RunEvent is emitted per bench, not that this file can import.
    """
    try:
        start, complete = (emitter or _default_lineage_emitter)()
    except Exception as exc:
        log.warning("bench: lineage unavailable, degrading to no-op: %s", exc)
        return {"emitted": False, "reason": f"{type(exc).__name__}: {exc}"}

    run_id = entry.get("run_id")
    try:
        start(run_id, entry)
        complete(run_id, entry)
    except Exception as exc:
        log.warning("bench: lineage emit failed for %s: %s", run_id, exc)
        return {"emitted": False, "reason": f"{type(exc).__name__}: {exc}"}
    return {"emitted": True, "run_id": run_id}


# ---------------------------------------------------------------------------
# The host lock — the eGPU is single-tenant (R12)
# ---------------------------------------------------------------------------


class LockHeld(RuntimeError):
    """Another bench holds the host lock."""


def _default_owner_alive(pid: int) -> bool:
    """True when the owning process still exists. A pid we are not PERMITTED to probe is ALIVE —
    reading it as dead let a privileged or other-user process have its lock stolen."""
    if not isinstance(pid, int) or isinstance(pid, bool):
        return True  # an unreadable claim is not proof the owner is gone
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except (OSError, ValueError, TypeError):
        return False


class HostLock:
    """Exclusive host lock via atomic O_EXCL create — the primitive the coordination ledger uses
    for task leases. A lock whose owner is gone is RECLAIMED, not honoured: a crashed bench must
    not wedge the estate until someone notices."""

    def __init__(
        self,
        lock_dir: Path,
        owner_alive: Callable[[int], bool] = _default_owner_alive,
        name: str = "bench.lock",
    ):
        self.path = Path(lock_dir) / name
        self._owner_alive = owner_alive
        self._token: Optional[str] = None

    def acquire(self) -> "HostLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(_LOCK_ATTEMPTS):
            token = uuid.uuid4().hex
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                if self._is_stale():
                    self.path.unlink(missing_ok=True)
                    continue
                raise LockHeld(f"the bench host lock at {self.path} is held by a live process")
            except PermissionError:
                # Windows reports a locked or half-created file this way. Contention, not failure.
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(
                    {"pid": os.getpid(), "token": token,
                     "acquired_at": datetime.now(timezone.utc).isoformat()},
                    fh,
                )
            self._token = token
            return self
        raise LockHeld(f"could not acquire {self.path} after {_LOCK_ATTEMPTS} attempts")

    def _is_stale(self) -> bool:
        """A lock is stale ONLY when its owner is demonstrably gone.

        The previous version returned True on any read failure, so a lock that was empty, truncated
        or not JSON was stolen from an owner that might well be alive — including the 0-byte window
        a contender saw mid-acquire. Unreadable now means UNKNOWN, and unknown means keep out.
        """
        try:
            owner = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return False
        if not isinstance(owner, dict) or "pid" not in owner:
            return False
        return not self._owner_alive(owner.get("pid"))

    def release(self) -> None:
        """Release only a lock THIS instance holds. Previously any object pointing at the path
        could unlink someone else's lock, and a third party could then acquire while the real
        owner still believed it held the host."""
        if self._token is None:
            return  # we never held it, so it is not ours to free
        try:
            owner = json.loads(self.path.read_text(encoding="utf-8"))
            mine = owner.get("token") == self._token
        except Exception:
            # A transient read failure must NOT strand the lock. `_token` is set only on a
            # successful acquire, so we do hold it; refusing to unlink here livelocked every
            # waiting contender until their timeout (3 of 5 runs, at exactly 60s).
            mine = True
        if mine:
            # Measured: a give-up here stranded the lock and lost 7 of 12 concurrent writers.
            try:
                _retry_on_sharing_violation(
                    lambda: self.path.unlink(missing_ok=True), what="host lock release"
                )
            except PermissionError:
                pass  # release must never raise; the stale check will reclaim it
        self._token = None

    def __enter__(self) -> "HostLock":
        return self.acquire()

    def __exit__(self, *exc) -> None:
        self.release()


def acquire_blocking(
    lock_dir: Path,
    *,
    name: str = "bench.lock",
    owner_alive: Callable[[int], bool] = _default_owner_alive,
    timeout: float = 300.0,
    poll: float = 0.05,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> HostLock:
    """WAIT for the host lock rather than failing on contention.

    `run_serialised` previously let `LockHeld` fall into its blanket `except`, so a contended
    subject was DROPPED and recorded indistinguishably from an endpoint failure. "Subjects run
    strictly in sequence" means the second one waits; a sweep that silently loses subjects and
    reports them as failures is worse than one that takes longer.
    """
    deadline = now() + timeout
    while True:
        try:
            return HostLock(lock_dir, owner_alive=owner_alive, name=name).acquire()
        except (LockHeld, PermissionError):
            if now() >= deadline:
                raise
            sleep(poll)


def run_serialised(
    subjects: Sequence[str],
    body: Callable[[str], Any],
    *,
    lock_dir: Path,
    owner_alive: Callable[[int], bool] = _default_owner_alive,
    timeout: float = 300.0,
) -> List[Any]:
    """Run `body` for each subject STRICTLY in sequence, holding the host lock for each.

    A subject that raises yields its exception in the results and does not stop the others — and
    releases the lock on the way out, because a stranded lock would block every later bench.
    Contenders from another process WAIT instead of being dropped.
    """
    results: List[Any] = []
    for subject in subjects:
        lock = None
        try:
            lock = acquire_blocking(lock_dir, owner_alive=owner_alive, timeout=timeout)
            results.append(body(subject))
        except Exception as exc:
            log.warning("bench: subject %s failed: %s", subject, exc)
            results.append(exc)
        finally:
            if lock is not None:
                lock.release()
    return results


# ---------------------------------------------------------------------------
# Liveness — resource evidence only (R12)
# ---------------------------------------------------------------------------


def _num(value: Any) -> Optional[float]:
    """A real number, or None. Booleans are not numbers here, and NaN is not evidence."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    f = float(value)
    return None if f != f else f  # NaN != NaN


def classify_liveness(samples: Sequence[Dict[str, Any]]) -> str:
    """ALIVE / WEDGED / UNKNOWN from resource evidence.

    `log_lines` is accepted in the sample and DELIBERATELY never read. A tqdm line is not proof of
    life: this estate once judged a dead job alive on exactly that evidence. Only CPU time and
    artifact mtime can produce ALIVE.

    Two corrections after review:

    * **The most recent consecutive pair decides**, not first-vs-last. Comparing the ends meant a
      job that worked for one minute and then died for an hour read ALIVE forever — the same R12
      failure the log rule exists to prevent, reached through a different door. Any monitor that
      appends to a growing list would have latched ALIVE permanently on one good delta.
    * **Thresholds are RATES over elapsed time**, not absolute deltas. Absolute floors judged a
      1-second window and a 24-hour window identically: 0.5 CPU-seconds over a day read ALIVE while
      98% busy over half a second read WEDGED. `t` was carried in every sample and read nowhere.

    Fewer than two samples, unusable evidence, or a non-positive elapsed time is UNKNOWN — never
    ALIVE. An optimistic default is how a dead job keeps the GPU.
    """
    usable = [s for s in samples if isinstance(s, dict) and _num(s.get("t")) is not None]
    if len(usable) < 2:
        return UNKNOWN
    # Out-of-order samples previously produced a false WEDGED on a live job.
    usable.sort(key=lambda s: _num(s["t"]))
    prev, last = usable[-2], usable[-1]

    elapsed = _num(last["t"]) - _num(prev["t"])
    if elapsed <= 0:
        return UNKNOWN  # no window, so no rate — progress out of zero elapsed time is not evidence

    cpu_prev, cpu_last = _num(prev.get("cpu_seconds")), _num(last.get("cpu_seconds"))
    mt_prev, mt_last = _num(prev.get("artifact_mtime")), _num(last.get("artifact_mtime"))
    if cpu_prev is None or cpu_last is None or mt_prev is None or mt_last is None:
        return UNKNOWN  # no resource evidence at all. Not alive — we simply cannot see.

    cpu_busy = (cpu_last - cpu_prev) / elapsed >= CPU_RATE_FLOOR
    artifacts_moved = (mt_last - mt_prev) >= MTIME_FLOOR_SECONDS
    return ALIVE if (cpu_busy or artifacts_moved) else WEDGED
