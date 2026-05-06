"""AOS-NFR4 — Diagram generation performance: ≤ 50 ms on a 50-task, 5-wave fixture.

Uses wall-clock time via time.perf_counter so the test is environment-sensitive.
On any modern laptop/CI box this should pass with headroom to spare.
"""
import time
import pytest

from benny.core.manifest import ManifestPlan, ManifestTask, ManifestEdge
from benny.sdlc.diagrams import to_mermaid, to_plantuml


_TASK_COUNT = 50
_WAVES = 5
_TASKS_PER_WAVE = _TASK_COUNT // _WAVES


def _make_large_plan() -> ManifestPlan:
    """Build a 50-task / 5-wave fixture with linear inter-wave edges."""
    tasks = [
        ManifestTask(id=f"task_{i:03d}", description=f"Task {i} description text")
        for i in range(_TASK_COUNT)
    ]
    waves: list[list[str]] = []
    edges: list[ManifestEdge] = []

    for w in range(_WAVES):
        wave_ids = [f"task_{w * _TASKS_PER_WAVE + j:03d}" for j in range(_TASKS_PER_WAVE)]
        waves.append(wave_ids)

    # Wire last task of each wave to first task of the next wave
    for w in range(_WAVES - 1):
        src = f"task_{(w + 1) * _TASKS_PER_WAVE - 1:03d}"
        tgt = f"task_{(w + 1) * _TASKS_PER_WAVE:03d}"
        edges.append(ManifestEdge(source=src, target=tgt))

    return ManifestPlan(tasks=tasks, edges=edges, waves=waves)


_LARGE_PLAN = _make_large_plan()
_BUDGET_MS = 50


def test_aos_nfr4_mermaid_perf():
    """to_mermaid() on a 50-task fixture must complete in ≤ 50 ms."""
    start = time.perf_counter()
    diagram = to_mermaid(_LARGE_PLAN)
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert elapsed_ms <= _BUDGET_MS, (
        f"to_mermaid() took {elapsed_ms:.1f} ms — exceeds {_BUDGET_MS} ms budget"
    )
    assert "graph TD" in diagram


def test_aos_nfr4_plantuml_perf():
    """to_plantuml() on a 50-task fixture must complete in ≤ 50 ms."""
    start = time.perf_counter()
    diagram = to_plantuml(_LARGE_PLAN)
    elapsed_ms = (time.perf_counter() - start) * 1000

    assert elapsed_ms <= _BUDGET_MS, (
        f"to_plantuml() took {elapsed_ms:.1f} ms — exceeds {_BUDGET_MS} ms budget"
    )
    assert "@startuml" in diagram
