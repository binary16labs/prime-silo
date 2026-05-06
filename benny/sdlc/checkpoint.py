"""AOS-001 Phase 4 — Atomic checkpoint persistence for durable resume.

Public API
----------
  RunCheckpoint                   Pydantic snapshot of a run's progress.
  save_checkpoint(run_id, ckpt, dir) → Path   atomic write with HMAC envelope.
  load_checkpoint(run_id, dir)    → RunCheckpoint   verify HMAC then deserialise.
  write_pause(run_id, ckpt, dir)  → Path   HITL pause: writes pause.json.
  resume_run(manifest, ckpt)      → SwarmManifest  re-enter without re-running done tasks.
  check_time_budget(ckpt)         raises TimeBudgetExceededError if elapsed ≥ limit.
  check_iteration_budget(ckpt)    raises IterationBudgetExceededError if used ≥ limit.

Security (R5 mitigation, RPN 225)
----------------------------------
  Checkpoints are written atomically via tmp-file + os.replace so a crash during
  write leaves the prior checkpoint intact.  An HMAC-SHA256 tag over the JSON
  payload detects bit-rot or tampering before any state is hydrated.

  Key resolution: BENNY_HMAC_KEY env var (hex-encoded 32-byte secret) → fallback
  hard-coded development key.  Production deployments MUST set BENNY_HMAC_KEY.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Dict, List, Optional

from pydantic import BaseModel, Field

if TYPE_CHECKING:
    from benny.core.manifest import SwarmManifest


# ---------------------------------------------------------------------------
# HMAC helpers
# ---------------------------------------------------------------------------

_DEFAULT_KEY = b"benny-aos-dev-hmac-key-do-not-use-in-prod-000"


def _get_hmac_key() -> bytes:
    raw = os.environ.get("BENNY_HMAC_KEY", "")
    if raw:
        try:
            return bytes.fromhex(raw)
        except ValueError:
            pass
    return _DEFAULT_KEY


def _hmac_sign(payload: str) -> str:
    key = _get_hmac_key()
    tag = hmac.new(key, payload.encode("utf-8"), hashlib.sha256).hexdigest()
    return f"sha256:{tag}"


def _hmac_verify(payload: str, expected: str) -> None:
    computed = _hmac_sign(payload)
    if not hmac.compare_digest(computed, expected):
        raise HmacIntegrityError(
            f"HMAC mismatch: checkpoint appears tampered or corrupted. "
            f"expected={expected!r} computed={computed!r}"
        )


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class HmacIntegrityError(ValueError):
    """Raised when a checkpoint's HMAC tag does not match its payload."""


class TimeBudgetExceededError(RuntimeError):
    """Raised when a run's wall-clock budget has been exceeded."""


class IterationBudgetExceededError(RuntimeError):
    """Raised when a run's iteration count has reached or exceeded its limit."""


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


class RunCheckpoint(BaseModel):
    """Snapshot of a run's progress, persisted for atomic durable resume."""

    run_id: str
    saved_at: str = Field(default_factory=lambda: datetime.utcnow().isoformat())
    completed_tasks: List[str] = Field(default_factory=list)
    task_states: Dict[str, str] = Field(default_factory=dict)
    artifact_refs: Dict[str, str] = Field(default_factory=dict)

    time_budget_s: Optional[float] = None
    started_at: Optional[str] = None

    iteration_budget: Optional[int] = None
    iterations_used: int = 0

    is_pause: bool = False


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------


def _to_envelope(checkpoint: RunCheckpoint) -> str:
    payload_dict = checkpoint.model_dump()
    payload_str = json.dumps(payload_dict, sort_keys=True, ensure_ascii=True)
    sig = _hmac_sign(payload_str)
    return json.dumps({"payload": payload_dict, "hmac": sig}, ensure_ascii=True)


def _from_envelope(raw: str) -> RunCheckpoint:
    outer = json.loads(raw)
    payload_dict = outer["payload"]
    sig = outer["hmac"]
    payload_str = json.dumps(payload_dict, sort_keys=True, ensure_ascii=True)
    _hmac_verify(payload_str, sig)
    return RunCheckpoint(**payload_dict)


# ---------------------------------------------------------------------------
# Public API — save / load
# ---------------------------------------------------------------------------


def save_checkpoint(run_id: str, checkpoint: RunCheckpoint, directory: Path) -> Path:
    """Atomically write *checkpoint* to *directory*/<run_id>.checkpoint.json.

    Uses tmp-file + os.replace for crash safety (R5 mitigation).
    Returns the final checkpoint path.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    target = directory / f"{run_id}.checkpoint.json"
    tmp = directory / f"{run_id}.checkpoint.json.tmp"

    tmp.write_text(_to_envelope(checkpoint), encoding="utf-8")
    os.replace(tmp, target)
    return target


def load_checkpoint(run_id: str, directory: Path) -> RunCheckpoint:
    """Load and HMAC-verify the checkpoint for *run_id*.

    Prefers pause.json (HITL pause handoff) over the regular checkpoint file.
    Raises FileNotFoundError if neither exists, HmacIntegrityError on corruption.
    """
    directory = Path(directory)
    pause_path = directory / "pause.json"
    ckpt_path = directory / f"{run_id}.checkpoint.json"

    for candidate in (pause_path, ckpt_path):
        if candidate.exists():
            return _from_envelope(candidate.read_text(encoding="utf-8"))

    raise FileNotFoundError(
        f"No checkpoint found for run {run_id!r} in {directory!r}"
    )


def write_pause(run_id: str, checkpoint: RunCheckpoint, directory: Path) -> Path:
    """Write a HITL pause marker as pause.json (atomic, HMAC-signed).

    The loaded RunCheckpoint will have is_pause=True so the resume path
    can detect it was paused intentionally rather than having crashed.
    Returns the path to pause.json.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)

    paused = checkpoint.model_copy(update={"is_pause": True})
    target = directory / "pause.json"
    tmp = directory / f"{run_id}.pause.json.tmp"

    tmp.write_text(_to_envelope(paused), encoding="utf-8")
    os.replace(tmp, target)
    return target


# ---------------------------------------------------------------------------
# Public API — resume
# ---------------------------------------------------------------------------


def resume_run(manifest: "SwarmManifest", checkpoint: RunCheckpoint) -> "SwarmManifest":
    """Return a deep copy of *manifest* with task statuses overlaid from *checkpoint*.

    Mapping:
      checkpoint  task_states[id] == "completed"  →  TaskStatus.COMPLETED
      checkpoint  task_states[id] == "running"    →  TaskStatus.PENDING   (re-queue)
      anything else / absent                      →  TaskStatus.PENDING
    """
    from benny.core.manifest import TaskStatus

    resumed = manifest.model_copy(deep=True)
    for task in resumed.plan.tasks:
        state = checkpoint.task_states.get(task.id, "pending")
        if state == "completed":
            task.status = TaskStatus.COMPLETED
        else:
            task.status = TaskStatus.PENDING
    resumed.touch()
    return resumed


# ---------------------------------------------------------------------------
# Public API — budget checks
# ---------------------------------------------------------------------------


def check_time_budget(checkpoint: RunCheckpoint) -> None:
    """Raise TimeBudgetExceededError if the wall-clock budget has been exhausted.

    No-op when time_budget_s or started_at is None.
    """
    if checkpoint.time_budget_s is None or checkpoint.started_at is None:
        return
    elapsed = (
        datetime.utcnow() - datetime.fromisoformat(checkpoint.started_at)
    ).total_seconds()
    if elapsed >= checkpoint.time_budget_s:
        raise TimeBudgetExceededError(
            f"Time budget {checkpoint.time_budget_s:.1f}s exceeded "
            f"(elapsed {elapsed:.1f}s) for run {checkpoint.run_id!r}"
        )


def check_iteration_budget(checkpoint: RunCheckpoint) -> None:
    """Raise IterationBudgetExceededError if the iteration count is at or over the limit.

    No-op when iteration_budget is None.
    """
    if checkpoint.iteration_budget is None:
        return
    if checkpoint.iterations_used >= checkpoint.iteration_budget:
        raise IterationBudgetExceededError(
            f"Iteration budget {checkpoint.iteration_budget} exhausted "
            f"(used {checkpoint.iterations_used}) for run {checkpoint.run_id!r}"
        )


__all__ = [
    "RunCheckpoint",
    "HmacIntegrityError",
    "TimeBudgetExceededError",
    "IterationBudgetExceededError",
    "save_checkpoint",
    "load_checkpoint",
    "write_pause",
    "resume_run",
    "check_time_budget",
    "check_iteration_budget",
]
