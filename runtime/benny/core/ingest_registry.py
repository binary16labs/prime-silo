"""
Ingest run registry — cooperative cancellation + liveness for long ingest loops.

Why this exists (2026-07-15 incident): POST /api/rag/ingest with deep_synthesis
keeps issuing one LLM call per document long after the requesting client is
gone — a killed runner left the server grinding through ~188 documents for
hours, re-flooding the LAN LM Studio host after every restart. The HTTP
request cannot serve as the lifetime signal (the response only returns once
the whole loop is done), so cancellation has to be an explicit out-of-band
flag that the per-document loop polls.
"""

import threading
from datetime import datetime
from typing import Any, Dict, List, Tuple


class _IngestRun:
    __slots__ = ("run_id", "started_at", "docs_total", "docs_done", "cancel_event")

    def __init__(self, run_id: str, docs_total: int):
        self.run_id = run_id
        self.started_at = datetime.now().isoformat()
        self.docs_total = docs_total
        self.docs_done = 0
        # threading.Event (not asyncio.Event): the cancel request arrives on a
        # different task/thread than the loop, and Event.set()/is_set() are
        # safe across both without needing the loop handle.
        self.cancel_event = threading.Event()


class IngestRegistry:
    """Module-level map of run_id → in-flight ingest state."""

    def __init__(self):
        self._runs: Dict[str, _IngestRun] = {}
        self._lock = threading.Lock()

    def register(self, run_id: str, docs_total: int) -> None:
        with self._lock:
            # Re-registering the same run_id (client retry) gets a fresh flag —
            # a stale cancel from a previous attempt must not kill the new run.
            self._runs[run_id] = _IngestRun(run_id, docs_total)

    def progress(self, run_id: str, docs_done: int) -> None:
        with self._lock:
            run = self._runs.get(run_id)
            if run:
                run.docs_done = docs_done

    def cancel(self, run_id: str) -> Tuple[bool, bool]:
        """Set the cancel flag. Returns (known, cancelled)."""
        with self._lock:
            run = self._runs.get(run_id)
            if not run:
                return False, False
            run.cancel_event.set()
            return True, True

    def is_cancelled(self, run_id: str) -> bool:
        with self._lock:
            run = self._runs.get(run_id)
            return bool(run and run.cancel_event.is_set())

    def finish(self, run_id: str) -> None:
        """Remove a run however it ended; safe to call for unknown ids."""
        with self._lock:
            self._runs.pop(run_id, None)

    def active(self) -> List[Dict[str, Any]]:
        with self._lock:
            return [
                {
                    "run_id": r.run_id,
                    "started_at": r.started_at,
                    "docs_done": r.docs_done,
                    "docs_total": r.docs_total,
                }
                for r in self._runs.values()
            ]


# Global instance (mirrors core.task_manager.task_manager)
ingest_registry = IngestRegistry()
