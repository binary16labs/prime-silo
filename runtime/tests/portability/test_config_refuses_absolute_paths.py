"""Phase 1a — FR-2/FR-3: config loader refuses absolute paths outside $BENNY_HOME."""
from __future__ import annotations

from pathlib import Path

import pytest

from benny.portable import config as cfg
from benny.portable import home as home_mod


@pytest.fixture
def initialized_home(tmp_path: Path) -> Path:
    root = tmp_path / "optimus"
    home_mod.init(root, profile="native")
    return root


def test_loader_accepts_fresh_config(initialized_home: Path) -> None:
    loaded = cfg.load(initialized_home)
    assert loaded.schema_version
    assert loaded.profile == "native"


def test_loader_rejects_absolute_path_outside_root(initialized_home: Path) -> None:
    cfg_path = initialized_home / "config" / "benny.toml"
    bad = cfg_path.read_text(encoding="utf-8") + '\nextra_data_dir = "C:/Users/alice/leak"\n'
    cfg_path.write_text(bad, encoding="utf-8")
    with pytest.raises(cfg.PortableConfigError, match="absolute"):
        cfg.load(initialized_home)


def test_loader_accepts_path_under_ssd_root(initialized_home: Path, tmp_path: Path) -> None:
    cfg_path = initialized_home / "config" / "benny.toml"
    allowed = initialized_home.as_posix() + "/data/extra"
    amended = cfg_path.read_text(encoding="utf-8") + f'\nextra_data_dir = "{allowed}"\n'
    cfg_path.write_text(amended, encoding="utf-8")
    loaded = cfg.load(initialized_home)
    assert loaded.extra_data_dir == allowed


def test_loader_accepts_relative_paths(initialized_home: Path) -> None:
    cfg_path = initialized_home / "config" / "benny.toml"
    amended = cfg_path.read_text(encoding="utf-8") + '\nextra_data_dir = "data/extra"\n'
    cfg_path.write_text(amended, encoding="utf-8")
    loaded = cfg.load(initialized_home)
    assert loaded.extra_data_dir == "data/extra"
