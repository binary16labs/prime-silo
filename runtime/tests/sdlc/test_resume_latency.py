"""AOS-NFR2 — Resume latency: p95 of save+load+resume cycle ≤ 5 s.

test_aos_nfr2_resume_p95 — runs 20 iterations, measures p95 wall time.
"""
from __future__ import annotations

import time

import pytest

from benny.sdlc.checkpoint import RunCheckpoint, load_checkpoint, resume_run, save_checkpoint
from benny.core.manifest import ManifestPlan, ManifestTask, SwarmManifest, TaskStatus

_TASK_COUNT = 20
_ITERATIONS = 20
_BUDGET_S = 5.0


def _make_manifest() -> SwarmManifest:
    tasks = [
        ManifestTask(id=f"task-{i:03d}", description=f"Task {i}", status=TaskStatus.PENDING)
        for i in range(_TASK_COUNT)
    ]
    return SwarmManifest(
        id="manifest-nfr2",
        name="nfr2-fixture",
        plan=ManifestPlan(
            tasks=tasks,
            waves=[[f"task-{i:03d}" for i in range(_TASK_COUNT)]],
        ),
    )


def _make_checkpoint(run_id: str) -> RunCheckpoint:
    half = _TASK_COUNT // 2
    return RunCheckpoint(
        run_id=run_id,
        completed_tasks=[f"task-{i:03d}" for i in range(half)],
        task_states={
            **{f"task-{i:03d}": "completed" for i in range(half)},
            **{f"task-{i:03d}": "pending" for i in range(half, _TASK_COUNT)},
        },
        artifact_refs={f"task-{i:03d}": f"artifact://sha256:{i:064x}" for i in range(half)},
        iterations_used=half,
    )


# ---------------------------------------------------------------------------
# AOS-NFR2: p95 ≤ 5 s
# ---------------------------------------------------------------------------


def test_aos_nfr2_resume_p95(tmp_path):
    """p95 latency of the full save+load+resume cycle must be ≤ 5 s."""
    manifest = _make_manifest()
    latencies: list[float] = []

    for i in range(_ITERATIONS):
        run_id = f"nfr2-run-{i:04d}"
        ckpt = _make_checkpoint(run_id)

        t0 = time.perf_counter()
        save_checkpoint(run_id, ckpt, tmp_path)
        loaded = load_checkpoint(run_id, tmp_path)
        resume_run(manifest, loaded)
        latencies.append(time.perf_counter() - t0)

    latencies.sort()
    p95_idx = max(0, int(len(latencies) * 0.95) - 1)
    p95 = latencies[p95_idx]

    assert p95 < _BUDGET_S, (
        f"AOS-NFR2: p95 resume latency {p95*1000:.1f} ms exceeds {_BUDGET_S*1000:.0f} ms budget"
    )


def test_nfr2_single_cycle_well_under_budget(tmp_path):
    """A single save+load+resume round-trip must complete in well under 5 s."""
    manifest = _make_manifest()
    ckpt = _make_checkpoint("nfr2-single")

    t0 = time.perf_counter()
    save_checkpoint("nfr2-single", ckpt, tmp_path)
    loaded = load_checkpoint("nfr2-single", tmp_path)
    resume_run(manifest, loaded)
    elapsed = time.perf_counter() - t0

    assert elapsed < _BUDGET_S, (
        f"Single cycle took {elapsed*1000:.1f} ms (budget: {_BUDGET_S*1000:.0f} ms)"
    )
