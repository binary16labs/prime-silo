"""AOS-001 Phase 5 — AOS-F18: Backpressure blocks the dispatcher.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/worker_pool.py
is implemented.

F18: When pool.queue_depth reaches max_queue_depth, dispatch() raises
     QueueDepthExceededError *immediately* — no blocking wait, no enqueue.
     queue_depth = number of tasks currently in-flight (waiting for a VRAM
     slot OR actively executing).
"""

import threading
import time

import pytest

from benny.sdlc.worker_pool import (  # noqa: F401
    QueueDepthExceededError,
    VramPool,
    WorkerPool,
)


class TestBackpressureBlocksDispatcher:
    """AOS-F18: Queue-depth ceiling triggers immediate rejection."""

    def test_aos_f18_backpressure_blocks_dispatcher(self):
        """F18 primary: 3rd in-flight task raises QueueDepthExceededError (max=2).

        Setup:
          - 1 VRAM slot (capacity=1)
          - max_queue_depth=2

        Sequence:
          1. t1 enters dispatch → queue_depth=1, acquires the VRAM slot, runs slow_task
          2. t2 enters dispatch → queue_depth=2, blocks on VRAM acquire (slot taken)
          3. main thread: dispatch → queue_depth would be 3 > max(2) → raises immediately
          4. gate.set() unblocks t1; t2 gets VRAM and completes.
        """
        pool = VramPool(vram_budget_mb=1024, task_vram_mb=1024)  # 1 VRAM slot
        worker = WorkerPool(vram_pool=pool, max_queue_depth=2)

        gate = threading.Event()

        def slow_task():
            gate.wait(timeout=5.0)
            return "done"

        # Task 1: gets the single VRAM slot, blocks on gate
        t1 = threading.Thread(target=lambda: worker.dispatch(slow_task), daemon=True)
        t1.start()
        time.sleep(0.05)  # let t1 increment queue_depth and acquire the VRAM slot

        # Task 2: increments queue_depth to 2, then blocks waiting for VRAM slot
        t2 = threading.Thread(target=lambda: worker.dispatch(slow_task), daemon=True)
        t2.start()
        time.sleep(0.05)  # let t2 increment queue_depth to 2

        # Task 3: queue_depth would be 3 > max(2) → must raise immediately
        with pytest.raises(QueueDepthExceededError):
            worker.dispatch(slow_task)

        # Clean up: release the gate so threads finish
        gate.set()
        t1.join(timeout=2.0)
        t2.join(timeout=2.0)

    def test_f18_queue_depth_decrements_after_completion(self):
        """queue_depth returns to 0 after all tasks complete."""
        pool = VramPool(vram_budget_mb=4096, task_vram_mb=1024)
        worker = WorkerPool(vram_pool=pool, max_queue_depth=10)
        for _ in range(5):
            worker.dispatch(lambda: "ok")
        assert worker.queue_depth == 0

    def test_f18_backpressure_at_max_one(self):
        """max_queue_depth=1: a second concurrent dispatch raises immediately."""
        pool = VramPool(vram_budget_mb=1024, task_vram_mb=1024)
        worker = WorkerPool(vram_pool=pool, max_queue_depth=1)
        gate = threading.Event()

        t = threading.Thread(
            target=lambda: worker.dispatch(lambda: gate.wait(timeout=5.0)),
            daemon=True,
        )
        t.start()
        time.sleep(0.05)  # let t increment queue_depth to 1

        with pytest.raises(QueueDepthExceededError):
            worker.dispatch(lambda: "second")

        gate.set()
        t.join(timeout=2.0)

    def test_f18_nested_fanout_does_not_deadlock(self):
        """Nested dispatch (outer task dispatches inner) succeeds when capacity allows.

        This covers the R6 nested fan-out fixture in the risk register.
        With 4 VRAM slots and max_queue_depth=10, both outer and inner can
        acquire slots concurrently.
        """
        pool = VramPool(vram_budget_mb=4096, task_vram_mb=1024)  # 4 slots
        worker = WorkerPool(vram_pool=pool, max_queue_depth=10)

        def outer_task():
            # dispatch an inner task while holding a VRAM slot
            return worker.dispatch(lambda: "inner_result")

        result = worker.dispatch(outer_task)
        assert result == "inner_result"
        assert worker.queue_depth == 0

    def test_f18_error_message_mentions_limit(self):
        """QueueDepthExceededError message includes the configured limit."""
        pool = VramPool(vram_budget_mb=1024, task_vram_mb=1024)
        worker = WorkerPool(vram_pool=pool, max_queue_depth=0)  # always full
        with pytest.raises(QueueDepthExceededError, match="0"):
            worker.dispatch(lambda: None)
