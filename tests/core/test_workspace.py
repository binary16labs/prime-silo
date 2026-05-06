import pytest
import os
from pathlib import Path
from unittest.mock import patch, MagicMock
from benny.core.workspace import (
    get_workspace_path, 
    ensure_workspace_structure, 
    load_manifest, 
    save_manifest, 
    update_manifest,
    list_workspaces,
    get_workspace_files,
    smart_output,
    WORKSPACE_ROOT
)

@pytest.fixture
def clean_workspace_root(tmp_path, monkeypatch):
    root = (tmp_path / "workspace").resolve()
    root.mkdir()
    monkeypatch.setattr("benny.core.workspace.WORKSPACE_ROOT", root)
    return root

def test_get_workspace_path_traversal(clean_workspace_root):
    with pytest.raises(PermissionError):
        get_workspace_path("..", "passwd")

def test_ensure_workspace_structure(clean_workspace_root):
    result = ensure_workspace_structure("my_ws")
    assert result["status"] == "ready"
    assert (clean_workspace_root / "my_ws" / "manifest.yaml").exists()

def test_manifest_crud(clean_workspace_root):
    ws = "test_crud"
    ensure_workspace_structure(ws)
    update_manifest(ws, {"version": "2.0.0"})
    assert load_manifest(ws).version == "2.0.0"

def test_load_manifest_corrupt(clean_workspace_root):
    ws = "corrupt_ws"
    ensure_workspace_structure(ws)
    path = clean_workspace_root / ws / "manifest.yaml"
    path.write_text("!!invalid yaml", encoding="utf-8")
    m = load_manifest(ws)
    assert m.version == "1.0.0" # Default

def test_list_workspaces(clean_workspace_root):
    ensure_workspace_structure("ws1")
    workspaces = list_workspaces()
    assert len(workspaces) == 1

def test_get_workspace_files(clean_workspace_root):
    ensure_workspace_structure("ws1")
    data_out = get_workspace_path("ws1", "data_out")
    (data_out / "f1.txt").write_text("c1")
    files = get_workspace_files("ws1", "data_out")
    assert len(files) == 1

def test_smart_output(clean_workspace_root, monkeypatch):
    monkeypatch.setattr("benny.core.workspace.PASS_BY_REFERENCE_THRESHOLD", 10)
    out = smart_output("long content", "l.txt", "ws1", server_url="http://test")
    assert "http://test/api/files/ws1/l.txt" in out

def test_create_default_manual_error(clean_workspace_root):
    from benny.core.workspace import _create_default_manual
    with patch("pathlib.Path.write_text", side_effect=Exception("Disk Full")):
        _create_default_manual(clean_workspace_root / "fail.md", "content")
        # Should catch and log error without crashing
