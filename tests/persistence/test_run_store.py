import pytest
from pathlib import Path
from unittest.mock import patch
from benny.persistence.run_store import (
    save_manifest, get_manifest, list_manifests, delete_manifest,
    save_run, get_run, list_runs, update_run_status
)
from benny.core.manifest import SwarmManifest, RunRecord, RunStatus, TaskStatus

@pytest.fixture(autouse=True)
def mock_store(tmp_path, monkeypatch):
    root = (tmp_path / "manifests").resolve()
    root.mkdir()
    runs = root / "runs"
    runs.mkdir()
    monkeypatch.setattr("benny.persistence.run_store._STORE_ROOT", root)
    monkeypatch.setattr("benny.persistence.run_store._MANIFEST_DIR", root)
    monkeypatch.setattr("benny.persistence.run_store._RUNS_DIR", runs)
    return root, runs

def test_manifest_crud():
    # SwarmManifest requires id and name
    m = SwarmManifest(id="m1", name="Test Manifest")
    save_manifest(m)
    assert get_manifest("m1").id == "m1"
    assert get_manifest("m1").name == "Test Manifest"
    assert len(list_manifests()) == 1
    delete_manifest("m1")
    assert get_manifest("m1") is None

def test_run_crud():
    r = RunRecord(run_id="r1", manifest_id="m1", workspace="default")
    save_run(r)
    assert get_run("r1") is not None
    assert len(list_runs()) == 1

def test_update_run_status_complex():
    r = RunRecord(run_id="r_complex", manifest_id="m1", workspace="w1")
    save_run(r)
    
    node_states = {
        "node1": "completed",
        "node2": TaskStatus.FAILED,
        "node3": "invalid_status"
    }
    
    updated = update_run_status(
        "r_complex", 
        RunStatus.PARTIAL_SUCCESS, 
        node_states=node_states,
        errors=["small error"],
        artifact_paths=["/path/to/art"]
    )
    
    assert updated.status == RunStatus.PARTIAL_SUCCESS
    assert updated.node_states["node1"] == TaskStatus.COMPLETED
    assert updated.node_states["node3"] == TaskStatus.PENDING

def test_list_runs_limit():
    for i in range(5):
        save_run(RunRecord(run_id=f"run{i}", manifest_id="m1", workspace="w1"))
    assert len(list_runs(limit=2)) == 2

def test_corrupt_data(mock_store):
    root, runs = mock_store
    (root / "fail.json").write_text("{", encoding="utf-8")
    assert get_manifest("fail") is None
    assert list_manifests() == []
    
    (runs / "fail_run.json").write_text("invalid", encoding="utf-8")
    assert get_run("fail_run") is None
    assert list_runs() == []
