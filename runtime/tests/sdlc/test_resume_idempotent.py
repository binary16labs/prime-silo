"""AOS-F14 — Durable resume: idempotency and no redundant task re-execution.

test_aos_f14_resume_from_checkpoint — resumed manifest marks completed tasks as COMPLETED
test_aos_f14_no_redundant_tasks     — completed tasks do NOT appear as PENDING after resume
"""
from __future__ import annotations

import pytest

from benny.sdlc.checkpoint import RunCheckpoint, load_checkpoint, resume_run, save_checkpoint
from benny.core.manifest import ManifestPlan, ManifestTask, SwarmManifest, TaskStatus


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_manifest(n_tasks: int = 3) -> SwarmManifest:
    tasks = [
        ManifestTask(id=f"task-{i}", description=f"Task {i}", status=TaskStatus.PENDING)
        for i in range(n_tasks)
    ]
    return SwarmManifest(
        id="manifest-test",
        name="test",
        plan=ManifestPlan(
            tasks=tasks,
            waves=[[f"task-{i}" for i in range(n_tasks)]],
        ),
    )


# ---------------------------------------------------------------------------
# AOS-F14: resume_from_checkpoint
# ---------------------------------------------------------------------------


def test_aos_f14_resume_from_checkpoint(tmp_path):
    """Resumed manifest pre-marks completed tasks; remaining tasks stay PENDING."""
    manifest = _make_manifest(3)
    checkpoint = RunCheckpoint(
        run_id="run-f14-a",
        completed_tasks=["task-0", "task-1"],
        task_states={
            "task-0": "completed",
            "task-1": "completed",
            "task-2": "pending",
        },
    )
    save_checkpoint("run-f14-a", checkpoint, tmp_path)
    loaded = load_checkpoint("run-f14-a", tmp_path)

    resumed = resume_run(manifest, loaded)

    completed = [t for t in resumed.plan.tasks if t.status == TaskStatus.COMPLETED]
    pending = [t for t in resumed.plan.tasks if t.status == TaskStatus.PENDING]

    assert len(completed) == 2, f"Expected 2 completed tasks, got {len(completed)}"
    assert len(pending) == 1, f"Expected 1 pending task, got {len(pending)}"
    assert pending[0].id == "task-2"


# ---------------------------------------------------------------------------
# AOS-F14: no_redundant_tasks
# ---------------------------------------------------------------------------


def test_aos_f14_no_redundant_tasks(tmp_path):
    """Completed task IDs must not appear as PENDING after resume."""
    manifest = _make_manifest(4)
    checkpoint = RunCheckpoint(
        run_id="run-f14-b",
        completed_tasks=["task-0", "task-2"],
        task_states={
            "task-0": "completed",
            "task-1": "pending",
            "task-2": "completed",
            "task-3": "pending",
        },
    )
    save_checkpoint("run-f14-b", checkpoint, tmp_path)
    loaded = load_checkpoint("run-f14-b", tmp_path)
    resumed = resume_run(manifest, loaded)

    pending_ids = {t.id for t in resumed.plan.tasks if t.status == TaskStatus.PENDING}
    completed_ids = {t.id for t in resumed.plan.tasks if t.status == TaskStatus.COMPLETED}

    assert "task-0" not in pending_ids
    assert "task-2" not in pending_ids
    assert "task-0" in completed_ids
    assert "task-2" in completed_ids
    assert "task-1" in pending_ids
    assert "task-3" in pending_ids


def test_f14_interrupted_running_task_becomes_pending(tmp_path):
    """A task that was RUNNING when the run died must be re-queued as PENDING."""
    manifest = _make_manifest(3)
    checkpoint = RunCheckpoint(
        run_id="run-f14-c",
        completed_tasks=["task-0"],
        task_states={
            "task-0": "completed",
            "task-1": "running",   # interrupted mid-flight
            "task-2": "pending",
        },
    )
    save_checkpoint("run-f14-c", checkpoint, tmp_path)
    loaded = load_checkpoint("run-f14-c", tmp_path)
    resumed = resume_run(manifest, loaded)

    task_1 = next(t for t in resumed.plan.tasks if t.id == "task-1")
    assert task_1.status == TaskStatus.PENDING, (
        "Interrupted RUNNING task must be re-queued as PENDING"
    )


def test_f14_save_load_roundtrip(tmp_path):
    """Checkpoint save+load preserves all fields."""
    ckpt = RunCheckpoint(
        run_id="run-f14-rt",
        completed_tasks=["task-a", "task-b"],
        task_states={"task-a": "completed", "task-b": "completed", "task-c": "pending"},
        artifact_refs={"task-a": "artifact://sha256:deadbeef"},
        iterations_used=3,
    )
    save_checkpoint("run-f14-rt", ckpt, tmp_path)
    loaded = load_checkpoint("run-f14-rt", tmp_path)

    assert loaded.run_id == ckpt.run_id
    assert loaded.completed_tasks == ckpt.completed_tasks
    assert loaded.task_states == ckpt.task_states
    assert loaded.artifact_refs == ckpt.artifact_refs
    assert loaded.iterations_used == ckpt.iterations_used


def test_f14_atomic_write_leaves_no_tmp(tmp_path):
    """After save, no .tmp file should remain in the checkpoint directory."""
    ckpt = RunCheckpoint(run_id="run-f14-atm", completed_tasks=["task-0"])
    save_checkpoint("run-f14-atm", ckpt, tmp_path)

    tmp_files = list(tmp_path.glob("*.tmp"))
    assert tmp_files == [], f"Leftover tmp files: {tmp_files}"


def test_f14_corrupted_checkpoint_raises(tmp_path):
    """A tampered checkpoint file must raise on load (HMAC mismatch)."""
    ckpt = RunCheckpoint(run_id="run-f14-tamper", completed_tasks=["task-0"])
    path = save_checkpoint("run-f14-tamper", ckpt, tmp_path)

    # Tamper with the file content
    data = path.read_text(encoding="utf-8")
    tampered = data.replace('"task-0"', '"task-EVIL"')
    path.write_text(tampered, encoding="utf-8")

    with pytest.raises(Exception, match="[Hh][Mm][Aa][Cc]|[Ii]ntegrity|[Tt]amper"):
        load_checkpoint("run-f14-tamper", tmp_path)
