"""Tests for the unified run-event stream (G0).

Scenario names map 1:1 to `delivery/tasks/G0.md` Acceptance section.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import pytest

from benny.pypes.events import (
    RunEventStream,
    UnknownNodeError,
    fold_lineage,
)
from benny.pypes.models import PypesManifest
from benny.pypes.orchestrator import Orchestrator

REPO = Path(__file__).resolve().parents[2]
DEMO_MANIFEST = REPO / "manifests" / "templates" / "financial_risk_pipeline.json"


@pytest.fixture
def manifest():
    return PypesManifest.model_validate_json(DEMO_MANIFEST.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# Scenario: the DAG is frozen at run start
# ---------------------------------------------------------------------------


def test_dag_is_frozen_at_run_start(tmp_path):
    stream = RunEventStream(run_id="r1", root=tmp_path)
    stream.run_started(manifest_id="m1", manifest_hash="deadbeef", nodes=["a", "b", "c"], edges=[])

    # An event referencing a known node validates fine.
    stream.node_started(node_id="a", attempt=1)

    # An event referencing an unknown node id is rejected.
    with pytest.raises(UnknownNodeError):
        stream.node_started(node_id="d", attempt=1)


def test_events_file_contains_frozen_header_first(tmp_path):
    stream = RunEventStream(run_id="r1", root=tmp_path)
    stream.run_started(
        manifest_id="m1", manifest_hash="deadbeef", nodes=["a", "b"], edges=[["a", "b"]]
    )
    stream.node_started(node_id="a", attempt=1)

    events_path = tmp_path / "runs" / "r1" / "events.jsonl"
    lines = events_path.read_text(encoding="utf-8").splitlines()
    header = json.loads(lines[0])
    assert header["event"] == "run_started"
    assert header["nodes"] == ["a", "b"]
    assert header["edges"] == [["a", "b"]]


# ---------------------------------------------------------------------------
# Scenario: lineage is a fold, not a second system
# ---------------------------------------------------------------------------


def test_fold_lineage_from_completed_example_run(tmp_path, manifest, monkeypatch):
    # PRIME_SILO_HOME governs where events.jsonl lands (contract storage
    # rule); BENNY_HOME still governs pypes workspace/checkpoint resolution
    # for the demo CSV fixtures.
    monkeypatch.setenv("BENNY_HOME", str(REPO))
    monkeypatch.setenv("PRIME_SILO_HOME", str(tmp_path))
    receipt = Orchestrator(workspace_root=tmp_path / "ws").run(manifest, run_id="fold-test")

    events_path = tmp_path / "runs" / "fold-test" / "events.jsonl"
    assert events_path.exists()
    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]

    lineage = fold_lineage(events)

    # Every checkpointed step is the producer of at least one artifact in
    # the fold — i.e. the fold reproduces what the receipt/checkpoint store
    # (today's `benny runs inspect`-equivalent for pypes) already knows:
    # which node produced which named output.
    checkpointed_steps = {ckpt.step_id for ckpt in receipt.checkpoints}
    producing_nodes = {info["produced_by"] for info in lineage.values()}
    assert checkpointed_steps <= producing_nodes

    # And the manifest's own declared step -> output edges match the fold
    # exactly (this is the "reproduces what inspect reports today" check).
    for step in manifest.steps:
        for out_name in step.outputs or [step.id]:
            assert lineage[out_name]["produced_by"] == step.id
    # Downstream consumption edges are present too (artifact_consumed).
    assert "raw_trades" in lineage
    assert "silver_trades" in lineage["raw_trades"]["consumed_by"]


# ---------------------------------------------------------------------------
# Scenario: in-flight nodes emit heartbeats
# ---------------------------------------------------------------------------


def test_node_heartbeat_carries_phase_and_tokens(tmp_path):
    stream = RunEventStream(run_id="r1", root=tmp_path)
    stream.run_started(manifest_id="m1", manifest_hash="x", nodes=["a"], edges=[])
    stream.node_started(node_id="a", attempt=1)
    stream.node_heartbeat(
        node_id="a", attempt=1, phase="generating", tokens_so_far=42, compute_busy=True
    )
    stream.node_heartbeat(
        node_id="a", attempt=1, phase="assembling", tokens_so_far=100, compute_busy=False
    )
    stream.node_finished(node_id="a", attempt=1)

    events_path = tmp_path / "runs" / "r1" / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
    heartbeats = [e for e in events if e["event"] == "node_heartbeat"]
    assert len(heartbeats) == 2
    assert heartbeats[0]["phase"] == "generating"
    assert heartbeats[0]["tokens_so_far"] == 42
    assert heartbeats[0]["compute_busy"] is True
    assert heartbeats[1]["phase"] == "assembling"

    # A consumer tailing the file can distinguish "alive but silent between
    # artifacts" from "stalled" purely by the presence of heartbeats between
    # node_started and node_finished.
    started_idx = next(i for i, e in enumerate(events) if e["event"] == "node_started")
    finished_idx = next(i for i, e in enumerate(events) if e["event"] == "node_finished")
    heartbeat_idxs = [i for i, e in enumerate(events) if e["event"] == "node_heartbeat"]
    assert all(started_idx < i < finished_idx for i in heartbeat_idxs)


# ---------------------------------------------------------------------------
# Scenario: event emission never blocks execution
# ---------------------------------------------------------------------------


def test_emission_failure_degrades_and_is_logged(tmp_path, caplog):
    stream = RunEventStream(run_id="r1", root=tmp_path)
    stream.run_started(manifest_id="m1", manifest_hash="x", nodes=["a"], edges=[])

    # Simulate an unwritable events file by closing the underlying handle
    # and pointing it at a directory (a guaranteed write failure) instead of
    # touching real OS permissions (keeps the test hermetic on Windows).
    stream._path = tmp_path / "runs" / "r1"  # a directory, not a file

    with caplog.at_level(logging.WARNING):
        # Must not raise.
        stream.node_started(node_id="a", attempt=1)

    assert any("events" in rec.message.lower() for rec in caplog.records)


def test_orchestrator_step_succeeds_even_if_events_dir_unwritable(tmp_path, manifest, monkeypatch):
    os.environ["BENNY_HOME"] = str(REPO)
    # Force the events root to an unwritable location: a file where a
    # directory is expected, so `mkdir` fails inside the stream.
    bogus_root = tmp_path / "not_a_dir"
    bogus_root.write_text("not a directory", encoding="utf-8")
    monkeypatch.setenv("PRIME_SILO_HOME", str(bogus_root))

    receipt = Orchestrator(workspace_root=tmp_path / "ws").run(manifest, run_id="degrade-test")
    # The run must still complete and produce a normal receipt — event
    # stream failures never fail a step.
    assert receipt.run_id == "degrade-test"
    assert receipt.status in {"SUCCESS", "PARTIAL"}


# ---------------------------------------------------------------------------
# Scenario: dead Marquez cannot wedge the run
# ---------------------------------------------------------------------------


def test_lineage_enabled_with_no_marquez_stays_within_wall_time_budget(
    tmp_path, manifest, monkeypatch
):
    """BENNY_LINEAGE_ENABLED=1 with nothing listening on Marquez must not
    inflate per-step wall time — the event stream never makes an inline
    HTTP call (it is a local file writer only; any OpenLineage emission
    stays inside the existing best-effort `pypes/lineage.py` emitter, which
    already no-ops network failures)."""
    monkeypatch.setenv("BENNY_HOME", str(REPO))
    monkeypatch.setenv("PRIME_SILO_HOME", str(tmp_path / "psh"))
    monkeypatch.setenv("BENNY_LINEAGE_ENABLED", "1")
    monkeypatch.setenv("MARQUEZ_URL", "http://127.0.0.1:1")  # nothing listens here

    import time

    baseline_start = time.time()
    Orchestrator(workspace_root=tmp_path / "baseline").run(manifest, run_id="baseline-run")
    baseline_elapsed = time.time() - baseline_start

    lineage_start = time.time()
    Orchestrator(workspace_root=tmp_path / "lineage").run(manifest, run_id="lineage-run")
    lineage_elapsed = time.time() - lineage_start

    # Generous ceiling for a hermetic CI box: within 5x baseline (the wedge
    # bug this guards against is *seconds* of retry per HTTP call across
    # multiple steps, not a few extra ms of JSON writing).
    assert lineage_elapsed <= max(baseline_elapsed * 5, 2.0)
