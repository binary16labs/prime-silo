"""Phase 1a — AC-FR1..5-c: structural parity between app and native profiles.

The two profiles must share the same data layout and the same config surface.
Only the profile-specific subtree (`app/` vs `runtime/`) may differ.
"""
from __future__ import annotations

from pathlib import Path

from benny.portable import home as home_mod


SHARED_PATHS = (
    "bin",
    "config",
    "data/runs",
    "data/lineage",
    "data/vector",
    "data/graph",
    "workspaces",
    "models",
    "logs",
    "tmp",
    "state",
)


def _layout_signature(root: Path) -> set[str]:
    return {p for p in SHARED_PATHS if (root / p).is_dir()}


def test_shared_layout_is_identical(tmp_path: Path) -> None:
    app_root = tmp_path / "opt_app"
    nat_root = tmp_path / "opt_nat"
    home_mod.init(app_root, profile="app")
    home_mod.init(nat_root, profile="native")

    assert _layout_signature(app_root) == _layout_signature(nat_root)


def test_profile_specific_subtrees_are_exclusive(tmp_path: Path) -> None:
    app_root = tmp_path / "opt_app"
    nat_root = tmp_path / "opt_nat"
    home_mod.init(app_root, profile="app")
    home_mod.init(nat_root, profile="native")

    assert (app_root / "app").is_dir()
    assert not (app_root / "runtime").exists()

    assert (nat_root / "runtime").is_dir()
    assert not (nat_root / "app").exists()


def test_shared_config_files_match_across_profiles(tmp_path: Path) -> None:
    """voices.json and server_ops_allowlist.json must be identical templates."""
    app_root = tmp_path / "opt_app"
    nat_root = tmp_path / "opt_nat"
    home_mod.init(app_root, profile="app")
    home_mod.init(nat_root, profile="native")

    for shared in ("voices.json", "server_ops_allowlist.json"):
        a = (app_root / "config" / shared).read_text(encoding="utf-8")
        n = (nat_root / "config" / shared).read_text(encoding="utf-8")
        assert a == n, f"{shared} diverged between profiles"
