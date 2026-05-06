"""AOS-F15 — HITL pause/resume across hosts (mocked directory handoff).

test_aos_f15_pause_resume_across_hosts — pause.json written on pause; artifact refs
  survive the "host move" (simulated via tmp_path directory reuse).
"""
from __future__ import annotations

import json

import pytest

from benny.sdlc.checkpoint import RunCheckpoint, load_checkpoint, write_pause
from benny.core.manifest import ManifestPlan, ManifestTask, SwarmManifest, TaskStatus


# ---------------------------------------------------------------------------
# AOS-F15: pause_resume_across_hosts
# ---------------------------------------------------------------------------


def test_aos_f15_pause_resume_across_hosts(tmp_path):
    """Pause on host A; resume on host B (same dir = mocked move).

    Verifies: pause.json written, artifact refs hydrated, completed tasks retained.
    """
    artifact_ref = "artifact://sha256:cafebabe0000"
    checkpoint = RunCheckpoint(
        run_id="run-f15",
        completed_tasks=["task-0"],
        task_states={
            "task-0": "completed",
            "task-1": "pending",
        },
        artifact_refs={"task-0": artifact_ref},
    )

    # Host A: write pause
    pause_path = write_pause("run-f15", checkpoint, tmp_path)
    assert pause_path.name == "pause.json", (
        f"pause file must be named pause.json, got {pause_path.name!r}"
    )
    assert pause_path.exists()

    # Host B: load from same directory (mocked move)
    loaded = load_checkpoint("run-f15", tmp_path)

    assert "task-0" in loaded.completed_tasks
    assert loaded.artifact_refs.get("task-0") == artifact_ref


def test_f15_pause_json_is_valid_json(tmp_path):
    """pause.json content must be valid JSON."""
    ckpt = RunCheckpoint(
        run_id="run-f15-json",
        completed_tasks=["task-x"],
    )
    pause_path = write_pause("run-f15-json", ckpt, tmp_path)
    raw = pause_path.read_text(encoding="utf-8")
    parsed = json.loads(raw)   # must not raise
    assert "payload" in parsed
    assert "hmac" in parsed


def test_f15_pause_flag_is_set(tmp_path):
    """Loaded checkpoint from pause.json must have is_pause=True."""
    ckpt = RunCheckpoint(run_id="run-f15-flag", completed_tasks=[])
    write_pause("run-f15-flag", ckpt, tmp_path)
    loaded = load_checkpoint("run-f15-flag", tmp_path)
    assert loaded.is_pause is True


def test_f15_pause_atomic_no_tmp(tmp_path):
    """write_pause must not leave .tmp files behind."""
    ckpt = RunCheckpoint(run_id="run-f15-atm", completed_tasks=[])
    write_pause("run-f15-atm", ckpt, tmp_path)

    tmp_files = list(tmp_path.glob("*.tmp"))
    assert tmp_files == [], f"Leftover tmp files: {tmp_files}"


def test_f15_pause_overwritten_by_second_call(tmp_path):
    """Calling write_pause twice must produce one file (idempotent overwrite)."""
    for i in range(2):
        ckpt = RunCheckpoint(
            run_id=f"run-f15-idem",
            completed_tasks=[f"task-{i}"],
        )
        write_pause("run-f15-idem", ckpt, tmp_path)

    pause_files = list(tmp_path.glob("pause.json"))
    assert len(pause_files) == 1, "There must be exactly one pause.json"
