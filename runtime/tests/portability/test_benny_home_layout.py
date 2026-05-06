"""Phase 1a — FR-1: $BENNY_HOME layout is created and validated.

Covers the concrete shape declared in PBR-001 §4.1.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from benny.portable import home as home_mod


@pytest.fixture
def fresh_home(tmp_path: Path) -> Path:
    return tmp_path / "optimus"


@pytest.mark.parametrize("profile", ["app", "native"])
def test_init_creates_required_layout(fresh_home: Path, profile: str) -> None:
    bh = home_mod.init(fresh_home, profile=profile)
    # Shared top-level dirs (both profiles)
    for rel in (
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
    ):
        assert (fresh_home / rel).is_dir(), f"missing required dir: {rel}"

    # Profile-specific branch
    if profile == "app":
        assert (fresh_home / "app").is_dir()
        assert not (fresh_home / "runtime").exists()
    else:
        assert (fresh_home / "runtime").is_dir()
        assert not (fresh_home / "app").exists()

    # State files
    assert (fresh_home / "state" / "device-id").is_file()
    assert (fresh_home / "state" / "schema-version").is_file()
    assert (fresh_home / "state" / "profile-lock").read_text(encoding="utf-8").strip() == profile

    # Config files that ship with a fresh init
    assert (fresh_home / "config" / "benny.toml").is_file()
    assert (fresh_home / "config" / "profile").read_text(encoding="utf-8").strip() == profile
    assert (fresh_home / "config" / "voices.json").is_file()
    assert (fresh_home / "config" / "server_ops_allowlist.json").is_file()

    # Returned object is consistent
    assert bh.root == fresh_home
    assert bh.profile == profile


def test_init_is_idempotent(fresh_home: Path) -> None:
    bh1 = home_mod.init(fresh_home, profile="native")
    device_id_1 = (fresh_home / "state" / "device-id").read_text(encoding="utf-8")
    bh2 = home_mod.init(fresh_home, profile="native")
    device_id_2 = (fresh_home / "state" / "device-id").read_text(encoding="utf-8")
    assert bh1.root == bh2.root
    assert device_id_1 == device_id_2, "device-id must be stable across re-init"


def test_init_refuses_profile_switch(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="app")
    with pytest.raises(home_mod.PortableHomeError, match="profile"):
        home_mod.init(fresh_home, profile="native")


def test_validate_reports_clean_home(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="native")
    report = home_mod.validate(fresh_home)
    assert report.ok, f"fresh home should validate clean, got: {report.problems}"


def test_validate_reports_missing_dirs(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="native")
    # Break the layout.
    (fresh_home / "data" / "runs").rmdir()
    report = home_mod.validate(fresh_home)
    assert not report.ok
    assert any("data/runs" in p for p in report.problems)


def test_home_paths_are_ssd_relative(fresh_home: Path) -> None:
    bh = home_mod.init(fresh_home, profile="native")
    # Relative accessors return paths under root, nothing outside.
    for p in (bh.data_dir, bh.workspaces_dir, bh.models_dir, bh.config_dir):
        assert p.is_relative_to(bh.root), f"{p} escaped $BENNY_HOME"
