"""AOS-001 Phase 5 — AOS-F19: Per-dispatch iteration budget enforcement.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/worker_pool.py
is implemented.

F19: WorkerPool.dispatch_with_budget() calls check_iteration_budget() *before*
     enqueueing the task.  When iterations_used >= iteration_budget the call
     raises IterationBudgetExceededError and the task fn is never invoked.
"""

import pytest

from benny.sdlc.checkpoint import IterationBudgetExceededError, RunCheckpoint
from benny.sdlc.worker_pool import VramPool, WorkerPool


def _make_worker(vram_slots: int = 4, max_queue: int = 10) -> WorkerPool:
    pool = VramPool(vram_budget_mb=vram_slots * 1024, task_vram_mb=1024)
    return WorkerPool(vram_pool=pool, max_queue_depth=max_queue)


class TestIterationBudgetRaises:
    """AOS-F19: Iteration cap is enforced at the worker-pool dispatch boundary."""

    def test_aos_f19_iteration_budget_raises(self):
        """F19 primary: dispatch_with_budget raises when iterations_used >= budget."""
        worker = _make_worker()
        checkpoint = RunCheckpoint(
            run_id="test-f19-run",
            iteration_budget=3,
            iterations_used=3,  # already fully exhausted
        )
        with pytest.raises(IterationBudgetExceededError):
            worker.dispatch_with_budget(checkpoint, lambda: "should not run")

    def test_f19_budget_not_raised_when_under_limit(self):
        """dispatch_with_budget succeeds when iterations_used < iteration_budget."""
        worker = _make_worker()
        checkpoint = RunCheckpoint(
            run_id="test-f19-run",
            iteration_budget=5,
            iterations_used=2,
        )
        result = worker.dispatch_with_budget(checkpoint, lambda: "ok")
        assert result == "ok"

    def test_f19_no_budget_set_never_raises(self):
        """dispatch_with_budget with iteration_budget=None never raises."""
        worker = _make_worker()
        checkpoint = RunCheckpoint(run_id="test-f19-run")  # no budget
        result = worker.dispatch_with_budget(checkpoint, lambda: 99)
        assert result == 99

    def test_f19_boundary_exactly_at_limit_raises(self):
        """iterations_used == iteration_budget is treated as exhausted."""
        worker = _make_worker()
        checkpoint = RunCheckpoint(
            run_id="test-f19-run",
            iteration_budget=1,
            iterations_used=1,
        )
        with pytest.raises(IterationBudgetExceededError):
            worker.dispatch_with_budget(checkpoint, lambda: None)

    def test_f19_one_below_limit_succeeds(self):
        """iterations_used = budget - 1 does not raise (boundary)."""
        worker = _make_worker()
        checkpoint = RunCheckpoint(
            run_id="test-f19-run",
            iteration_budget=5,
            iterations_used=4,
        )
        result = worker.dispatch_with_budget(checkpoint, lambda: "last")
        assert result == "last"

    def test_f19_fn_never_called_when_budget_exceeded(self):
        """The task fn is never invoked when the budget is exhausted."""
        worker = _make_worker()
        called = []
        checkpoint = RunCheckpoint(
            run_id="test-f19-run",
            iteration_budget=2,
            iterations_used=2,
        )
        with pytest.raises(IterationBudgetExceededError):
            worker.dispatch_with_budget(checkpoint, lambda: called.append(True))
        assert called == []  # fn was never called

    def test_f19_args_forwarded_to_fn(self):
        """Positional and keyword args are forwarded to the dispatched fn."""
        worker = _make_worker()
        checkpoint = RunCheckpoint(
            run_id="test-f19-run",
            iteration_budget=10,
            iterations_used=0,
        )
        result = worker.dispatch_with_budget(
            checkpoint, lambda x, y=0: x + y, 3, y=7
        )
        assert result == 10
