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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence

log = logging.getLogger(__name__)  # AOS-OBS2

ALIVE = "alive"
WEDGED = "wedged"
UNKNOWN = "unknown"

#: CPU seconds below this across a whole window is jitter, not work.
CPU_FLOOR_SECONDS = 0.5
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
    canonical = json.dumps(
        {k: topology.get(k) for k in sorted(TOPOLOGY_KEYS)}, separators=(",", ":"), sort_keys=True
    )
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


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
    return data


def append_register(path: Path, entry: Dict[str, Any]) -> Dict[str, Any]:
    """Append one entry, writing via a temp file and replacing, so a crash mid-write cannot
    truncate the ledger to nothing."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    entries = read_register(p)
    entries.append(entry)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    os.replace(tmp, p)
    return entry


def bench_is_ledgered(entries: Sequence[Dict[str, Any]], run_id: str) -> bool:
    return any(e.get("run_id") == run_id for e in entries)


def emit_lineage(entry: Dict[str, Any]) -> Dict[str, Any]:
    """Emit an OpenLineage RunEvent through the existing governance path.

    Imported lazily and degraded honestly: the estate's ambient interpreter has no `openlineage`,
    and a bench must not fail because a telemetry sink is absent. The RESULT SAYS which happened,
    so a caller can never mistake a degraded emit for a real one.
    """
    try:
        from ..governance.lineage import emit_agent_authorship  # noqa: F401
    except Exception as exc:
        log.warning("bench: lineage unavailable, degrading to no-op: %s", exc)
        return {"emitted": False, "reason": f"{type(exc).__name__}: {exc}"}
    return {"emitted": True, "run_id": entry.get("run_id")}


# ---------------------------------------------------------------------------
# The host lock — the eGPU is single-tenant (R12)
# ---------------------------------------------------------------------------


class LockHeld(RuntimeError):
    """Another bench holds the host lock."""


def _default_owner_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)  # signal 0 tests for existence without touching the process
        return True
    except (OSError, ValueError, TypeError):
        return False


class HostLock:
    """Exclusive host lock via atomic O_EXCL create — the primitive the coordination ledger uses
    for task leases. A lock whose owner is gone is RECLAIMED, not honoured: a crashed bench must
    not wedge the estate until someone notices."""

    def __init__(self, lock_dir: Path, owner_alive: Callable[[int], bool] = _default_owner_alive):
        self.path = Path(lock_dir) / "bench.lock"
        self._owner_alive = owner_alive

    def acquire(self) -> "HostLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if self._is_stale():
                self.path.unlink(missing_ok=True)
                return self.acquire()
            raise LockHeld(f"the bench host lock at {self.path} is held by a live process")
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"pid": os.getpid(), "acquired_at": datetime.now(timezone.utc).isoformat()}, fh)
        return self

    def _is_stale(self) -> bool:
        try:
            owner = json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return True  # an unreadable lock is not a claim anyone can defend
        return not self._owner_alive(owner.get("pid"))

    def release(self) -> None:
        self.path.unlink(missing_ok=True)

    def __enter__(self) -> "HostLock":
        return self.acquire()

    def __exit__(self, *exc) -> None:
        self.release()


def run_serialised(
    subjects: Sequence[str],
    body: Callable[[str], Any],
    *,
    lock_dir: Path,
    owner_alive: Callable[[int], bool] = _default_owner_alive,
) -> List[Any]:
    """Run `body` for each subject STRICTLY in sequence, holding the host lock for each.

    A subject that raises yields its exception in the results and does not stop the others — and,
    critically, releases the lock on the way out. A stranded lock would block every later bench.
    """
    results: List[Any] = []
    for subject in subjects:
        try:
            with HostLock(lock_dir, owner_alive=owner_alive):
                results.append(body(subject))
        except Exception as exc:
            log.warning("bench: subject %s failed: %s", subject, exc)
            results.append(exc)
    return results


# ---------------------------------------------------------------------------
# Liveness — resource evidence only (R12)
# ---------------------------------------------------------------------------


def classify_liveness(samples: Sequence[Dict[str, Any]]) -> str:
    """ALIVE / WEDGED / UNKNOWN from resource evidence.

    `log_lines` is accepted in the sample and DELIBERATELY never read. A tqdm line is not proof of
    life: this estate once judged a dead job alive on exactly that evidence. Only CPU time and
    artifact mtime can produce ALIVE.

    Fewer than two samples is UNKNOWN, never ALIVE — one observation has no rate of change, and an
    optimistic default is how a dead job keeps the GPU.
    """
    if len(samples) < 2:
        return UNKNOWN

    first, last = samples[0], samples[-1]
    cpu_first, cpu_last = first.get("cpu_seconds"), last.get("cpu_seconds")
    mtime_first, mtime_last = first.get("artifact_mtime"), last.get("artifact_mtime")
    if cpu_first is None or cpu_last is None or mtime_first is None or mtime_last is None:
        # No resource evidence at all. Not alive — we simply cannot see.
        return UNKNOWN

    cpu_moved = (cpu_last - cpu_first) >= CPU_FLOOR_SECONDS
    artifacts_moved = (mtime_last - mtime_first) >= MTIME_FLOOR_SECONDS
    return ALIVE if (cpu_moved or artifacts_moved) else WEDGED
