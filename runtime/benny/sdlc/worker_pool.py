"""AOS-001 Phase 5 — VRAM-aware worker pool with backpressure.

Public API
----------
  vram_available_mb()                         Returns VRAM budget in MB (mockable).
  VramPool(vram_budget_mb, task_vram_mb)       Counting semaphore bounded by VRAM.
  WorkerPool(vram_pool, max_queue_depth)       Dispatcher with backpressure gate.
  QueueDepthExceededError                      Raised when the queue ceiling is hit.

AOS requirements covered
------------------------
  F17   VRAM-aware capacity: capacity = floor(vram_budget_mb / task_vram_mb) ≥ 1.
        The semaphore prevents more than ``capacity`` tasks from holding VRAM
        simultaneously → primary OOM guard.
  F18   Backpressure: dispatch() raises QueueDepthExceededError *immediately*
        when queue_depth reaches max_queue_depth.  No blocking wait is inserted;
        the caller is responsible for retry or back-off.
  F19   Iteration budget: dispatch_with_budget() calls check_iteration_budget()
        before enqueueing; raises IterationBudgetExceededError when exhausted.
  NFR5  OOM-free reference fixture: the semaphore enforces the cap, ensuring no
        more than ``capacity`` concurrent VRAM consumers exist at any time.

Placement note
--------------
This module lives in ``benny/sdlc/`` (not ``benny/graph/``) because
``benny/graph/__init__.py`` eagerly imports ``langgraph`` which is not installed
in the test environment.  All Phase 5–10 AOS modules follow this pattern.

Dependencies: stdlib only (os, subprocess, threading) + benny.sdlc.checkpoint.
No new top-level package dependency is introduced.
"""

from __future__ import annotations

import os
import subprocess
import threading
from typing import Any, Callable, Optional

from benny.sdlc.checkpoint import RunCheckpoint, check_iteration_budget


# ---------------------------------------------------------------------------
# VRAM introspection (mockable via BENNY_VRAM_BUDGET_MB env var)
# ---------------------------------------------------------------------------

def vram_available_mb() -> int:
    """Return the available VRAM budget in MB.

    Resolution order
    ~~~~~~~~~~~~~~~~
    1. ``BENNY_VRAM_BUDGET_MB`` environment variable (integer MB).
       Set this in tests via ``monkeypatch.setenv`` for deterministic results.
    2. ``nvidia-smi --query-gpu=memory.free`` (first GPU, exit 0 required).
    3. Fallback: 8 192 MB — a conservative default that supports eight 1-GB
       workers without risking OOM on a typical 16-GB dev GPU.

    Returns
    -------
    int
        Available VRAM in megabytes.
    """
    env_val = os.environ.get("BENNY_VRAM_BUDGET_MB")
    if env_val is not None:
        return int(env_val)

    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=memory.free",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            timeout=2,
        )
        if result.returncode == 0:
            first_line = result.stdout.strip().split("\n")[0]
            return int(first_line)
    except Exception:
        pass

    return 8192


# ---------------------------------------------------------------------------
# Custom exceptions
# ---------------------------------------------------------------------------

class QueueDepthExceededError(RuntimeError):
    """Raised when WorkerPool.dispatch() is called while the queue is full.

    This is the backpressure signal (AOS-F18).  Callers should either:
    - Wait and retry once existing tasks complete, or
    - Raise the error to the orchestrator so it can apply flow control.

    The error is raised *immediately* — no task is enqueued and no VRAM slot
    is acquired before raising.
    """


# ---------------------------------------------------------------------------
# VramPool
# ---------------------------------------------------------------------------

class VramPool:
    """Counting semaphore bounded by VRAM budget / per-task VRAM requirement.

    This is the primary OOM guard (AOS-F17, AOS-NFR5): at most ``capacity``
    tasks may hold a VRAM slot simultaneously.  All other tasks block on
    :meth:`acquire` until a slot is released.

    Parameters
    ----------
    vram_budget_mb:
        Total VRAM available to the pool, in megabytes.
    task_vram_mb:
        Estimated VRAM consumed by a single task, in megabytes.
    """

    def __init__(self, vram_budget_mb: int, task_vram_mb: int) -> None:
        self._vram_budget_mb = vram_budget_mb
        self._task_vram_mb = task_vram_mb
        # floor division, minimum 1 to prevent deadlock when task > budget
        self._capacity = max(1, vram_budget_mb // task_vram_mb)
        self._sem = threading.Semaphore(self._capacity)

    @property
    def capacity(self) -> int:
        """Maximum number of concurrent VRAM slots this pool can issue."""
        return self._capacity

    def acquire(self, timeout: Optional[float] = None) -> bool:
        """Attempt to claim a VRAM slot.

        Parameters
        ----------
        timeout:
            How long to wait in seconds.
            ``None`` → block indefinitely until a slot is available.
            ``0.0``  → non-blocking (return immediately).
            ``t > 0``→ wait up to *t* seconds.

        Returns
        -------
        bool
            ``True`` if a slot was acquired, ``False`` if the wait timed out.
        """
        if timeout is None:
            return self._sem.acquire(blocking=True)
        return self._sem.acquire(blocking=True, timeout=timeout)

    def release(self) -> None:
        """Return a previously acquired VRAM slot to the pool."""
        self._sem.release()


# ---------------------------------------------------------------------------
# WorkerPool
# ---------------------------------------------------------------------------

class WorkerPool:
    """VRAM-aware task dispatcher with backpressure (AOS-F17, F18, F19, NFR5).

    Two-level flow control
    ~~~~~~~~~~~~~~~~~~~~~~
    1. **Backpressure (queue depth ceiling)**  — ``queue_depth`` tracks every
       task currently in flight (waiting for VRAM *or* actively executing).
       When ``queue_depth >= max_queue_depth``, :meth:`dispatch` raises
       :class:`QueueDepthExceededError` *immediately* without blocking.

    2. **VRAM semaphore (OOM guard)** — :class:`VramPool` limits simultaneous
       VRAM holders to ``vram_pool.capacity``.  Tasks that pass the backpressure
       gate but find all slots occupied will block inside :meth:`dispatch` until
       a running task releases its slot.

    Parameters
    ----------
    vram_pool:
        The :class:`VramPool` that controls VRAM concurrency.
    max_queue_depth:
        Maximum tasks allowed in flight (waiting + executing) at any moment.
        Once this limit is reached, further :meth:`dispatch` calls are rejected.
    """

    def __init__(self, vram_pool: VramPool, max_queue_depth: int = 8) -> None:
        self._vram_pool = vram_pool
        self._max_queue_depth = max_queue_depth
        self._queue_depth: int = 0
        self._lock = threading.Lock()

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def queue_depth(self) -> int:
        """Current number of tasks in flight (waiting for VRAM + executing)."""
        with self._lock:
            return self._queue_depth

    # ------------------------------------------------------------------
    # Dispatch
    # ------------------------------------------------------------------

    def dispatch(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        """Dispatch *fn* to the worker pool.

        Steps
        ~~~~~
        1. **Backpressure check** — if ``queue_depth >= max_queue_depth`` raise
           :class:`QueueDepthExceededError` immediately (F18).
        2. **Increment queue_depth** atomically (under the internal lock).
        3. **Acquire VRAM slot** — blocks until the :class:`VramPool` semaphore
           grants a slot (F17 / NFR5).
        4. **Execute** *fn* with the slot held.
        5. **Release VRAM slot** and **decrement queue_depth** in ``finally``
           blocks so they always fire, even on exception.

        Parameters
        ----------
        fn:
            Callable to execute.  Receives *args* and *kwargs*.
        *args, **kwargs:
            Forwarded verbatim to *fn*.

        Returns
        -------
        Any
            The return value of *fn*.

        Raises
        ------
        QueueDepthExceededError
            If the queue is already at ``max_queue_depth``.
        """
        # ── 1 & 2: backpressure gate (atomic) ────────────────────────────────
        with self._lock:
            if self._queue_depth >= self._max_queue_depth:
                raise QueueDepthExceededError(
                    f"Worker pool queue depth limit {self._max_queue_depth} reached; "
                    "task rejected (backpressure). Retry after existing tasks complete."
                )
            self._queue_depth += 1

        # ── 3, 4, 5: VRAM slot + execute + release ───────────────────────────
        try:
            self._vram_pool.acquire()   # blocks until a VRAM slot is free
            try:
                return fn(*args, **kwargs)
            finally:
                self._vram_pool.release()
        finally:
            with self._lock:
                self._queue_depth -= 1

    def dispatch_with_budget(
        self,
        checkpoint: RunCheckpoint,
        fn: Callable[..., Any],
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        """Dispatch with per-iteration budget enforcement (AOS-F19).

        Calls :func:`~benny.sdlc.checkpoint.check_iteration_budget` *before*
        entering the queue.  If the checkpoint's iteration budget is exhausted,
        raises :class:`~benny.sdlc.checkpoint.IterationBudgetExceededError`
        immediately and *fn* is never invoked.

        Parameters
        ----------
        checkpoint:
            The current :class:`~benny.sdlc.checkpoint.RunCheckpoint`.
            Its ``iteration_budget`` and ``iterations_used`` fields are
            inspected; this method does **not** mutate the checkpoint.
        fn:
            Callable to execute if the budget allows.
        *args, **kwargs:
            Forwarded verbatim to *fn* via :meth:`dispatch`.

        Returns
        -------
        Any
            The return value of *fn*.

        Raises
        ------
        IterationBudgetExceededError
            If ``checkpoint.iterations_used >= checkpoint.iteration_budget``.
        QueueDepthExceededError
            If the pool queue is full (propagated from :meth:`dispatch`).
        """
        check_iteration_budget(checkpoint)   # raises IterationBudgetExceededError if over
        return self.dispatch(fn, *args, **kwargs)
