"""Phase 1a — AC-FR1..5-d: `uninstall --keep-data` preserves workspaces."""
from __future__ import annotations

from pathlib import Path

from benny.portable import home as home_mod


def _seed_workspace(root: Path, name: str, body: str) -> Path:
    ws = root / "workspaces" / name
    ws.mkdir(parents=True)
    (ws / "manifest.yaml").write_text(body, encoding="utf-8")
    return ws


def test_uninstall_keep_data_preserves_workspaces(tmp_path: Path) -> None:
    root = tmp_path / "optimus"
    home_mod.init(root, profile="app")

    ws = _seed_workspace(root, "demo", "version: '1.0.0'\nname: demo\n")
    (root / "data" / "runs" / "run-123").mkdir(parents=True)
    (root / "models" / "qwen").mkdir()

    home_mod.uninstall(root, keep_data=True)

    # App boundary is gone.
    assert not (root / "app").exists()
    assert not (root / "runtime").exists()

    # Data that belongs to the user survives.
    assert ws.is_dir()
    assert (ws / "manifest.yaml").read_text(encoding="utf-8").startswith("version:")
    assert (root / "data" / "runs" / "run-123").is_dir()
    assert (root / "models" / "qwen").is_dir()

    # Re-init restores the app boundary without touching data.
    home_mod.init(root, profile="app")
    assert (root / "app").is_dir()
    assert ws.is_dir()


def test_uninstall_without_keep_data_removes_everything(tmp_path: Path) -> None:
    root = tmp_path / "optimus"
    home_mod.init(root, profile="native")
    _seed_workspace(root, "demo", "version: '1.0.0'\n")
    home_mod.uninstall(root, keep_data=False)
    assert not root.exists()
