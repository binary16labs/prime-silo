"""AOS-001 Phase 5 — AOS-F17 / AOS-NFR5: VRAM-aware worker pool capacity.

Red tests — will fail with ModuleNotFoundError until benny/sdlc/worker_pool.py
is implemented.

F17: VramPool capacity = floor(vram_budget_mb / task_vram_mb), minimum 1.
     The semaphore refuses to issue more slots than capacity allows, so at most
     ``capacity`` tasks can hold VRAM concurrently → OOM guard.

NFR5: A reference fixture of 20 sequential tasks completes without raising
      MemoryError through a 2-slot pool (mocked VRAM via env var).
"""

import pytest

from benny.sdlc.worker_pool import VramPool, WorkerPool, vram_available_mb  # noqa: F401


class TestVramAwareCapacity:
    """AOS-F17: VRAM budget drives maximum concurrency."""

    def test_aos_f17_vram_aware_capacity(self):
        """F17 primary: 4096 MB budget / 1024 MB per task → capacity 4."""
        pool = VramPool(vram_budget_mb=4096, task_vram_mb=1024)
        assert pool.capacity == 4

    def test_f17_capacity_rounds_down(self):
        """capacity = floor(budget / per_task) — no fractional workers."""
        pool = VramPool(vram_budget_mb=3000, task_vram_mb=1024)
        assert pool.capacity == 2

    def test_f17_capacity_minimum_one(self):
        """If task_vram > budget, capacity is still 1 — never deadlock."""
        pool = VramPool(vram_budget_mb=512, task_vram_mb=1024)
        assert pool.capacity >= 1

    def test_f17_acquire_returns_true_when_slot_free(self):
        """acquire(timeout=0.0) returns True while at least one slot is free."""
        pool = VramPool(vram_budget_mb=2048, task_vram_mb=1024)
        ok = pool.acquire(timeout=0.0)
        assert ok is True
        pool.release()  # restore the slot

    def test_f17_acquire_returns_false_when_full(self):
        """acquire(timeout=0.0) returns False when all capacity slots are taken."""
        pool = VramPool(vram_budget_mb=1024, task_vram_mb=1024)
        assert pool.capacity == 1
        assert pool.acquire(timeout=0.0) is True   # grab the one slot
        assert pool.acquire(timeout=0.0) is False  # all full → False
        pool.release()

    def test_f17_vram_env_mock(self, monkeypatch):
        """vram_available_mb() reads BENNY_VRAM_BUDGET_MB env var for test mocking."""
        monkeypatch.setenv("BENNY_VRAM_BUDGET_MB", "3000")
        assert vram_available_mb() == 3000

    def test_f17_vram_pool_seeded_from_env(self, monkeypatch):
        """VramPool can be constructed from vram_available_mb() env-mock value."""
        monkeypatch.setenv("BENNY_VRAM_BUDGET_MB", "2048")
        budget = vram_available_mb()
        pool = VramPool(vram_budget_mb=budget, task_vram_mb=512)
        assert pool.capacity == 4


class TestNfr5OomFree:
    """AOS-NFR5: Reference fixture of 20 tasks completes OOM-free."""

    def test_aos_nfr5_oom_free_reference_fixture(self):
        """20 sequential tasks through a 2-slot pool all succeed (no MemoryError)."""
        pool = VramPool(vram_budget_mb=2048, task_vram_mb=1024)
        worker = WorkerPool(vram_pool=pool, max_queue_depth=20)
        results = []
        for _ in range(20):
            results.append(worker.dispatch(lambda: 42))
        assert len(results) == 20
        assert all(r == 42 for r in results)

    def test_nfr5_queue_depth_zero_after_run(self):
        """queue_depth resets to 0 after all dispatches complete."""
        pool = VramPool(vram_budget_mb=2048, task_vram_mb=1024)
        worker = WorkerPool(vram_pool=pool, max_queue_depth=10)
        for _ in range(5):
            worker.dispatch(lambda: None)
        assert worker.queue_depth == 0
