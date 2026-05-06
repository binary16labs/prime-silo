import json
import pytest
from pathlib import Path
from benny.migrate.importer import MigrationEngine
from benny.core.manifest import SwarmManifest

def test_path_rewriting(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    engine = MigrationEngine(home)
    
    # Path inside home
    # Use forward slashes for cross-platform matching
    inside = home / "workspaces/default/data_in/test.txt"
    outside = tmp_path / "other/file.txt"
    
    content = f"Files are at {inside} and {outside}"
    rewritten, count = engine.rewrite_paths(content)
    
    # Replace backslashes for easy comparison
    rewritten_flat = rewritten.replace("\\", "/")
    assert "${BENNY_HOME}/workspaces/default/data_in/test.txt" in rewritten_flat
    assert count == 1

def test_migrate_manifest_signs_correctly(tmp_path):
    home = (tmp_path / "home").absolute()
    home.mkdir()
    engine = MigrationEngine(home)
    
    # Old legacy JSON (simplified)
    legacy = {
        "id": "old-guid",
        "name": "Legacy Test",
        "requirement": "do stuff",
        "workspace": "default",
        "plan": {"tasks": [{"id": "t1", "description": f"work at {home.as_posix()}/data"}]}
    }
    
    manifest_path = tmp_path / "legacy.json"
    manifest_path.write_text(json.dumps(legacy))
    
    # Returns (manifest, rewrites)
    m, r = engine.migrate_manifest(manifest_path, dry_run=True)
    assert m is not None
    assert r >= 1
    assert m.schema_version == "1.0"
    assert m.content_hash is not None
    assert m.signature is not None
    assert "${BENNY_HOME}" in m.plan.tasks[0].description
    
    # Verify file wasn't changed in dry-run
    with open(manifest_path, "r") as f:
        data = json.load(f)
        assert data["id"] == "old-guid"

def test_migrate_workspace_flow(tmp_path):
    source = (tmp_path / "source").absolute()
    source.mkdir()
    target = (tmp_path / "target").absolute()
    target.mkdir()
    
    # Create valid manifest
    (source / "m1.json").write_text(json.dumps({"id": "m1", "plan": {"tasks": []}}))
    # Create invalid manifest 
    (source / "not_a_manifest.json").write_text(json.dumps({"foo": "bar"}))
    
    engine = MigrationEngine(target)
    report = engine.migrate_workspace(source, target, dry_run=False)
    
    assert len(report.transforms) == 1
    assert (target / "m1.json").exists()
    assert not (target / "not_a_manifest.json").exists()
    
    with open(target / "m1.json", "r") as f:
        data = json.load(f)
        assert "signature" in data
