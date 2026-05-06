"""Phase 1b — app/compose.yml is seeded for the 'app' profile.

Per PBR-001 §4.3, profile=app ships with a declarative Compose file pinning
the container versions that make up the newbie install. The native profile
intentionally has no compose.yml — experts run services directly.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from benny.portable import home as home_mod


@pytest.fixture
def fresh_home(tmp_path: Path) -> Path:
    return tmp_path / "optimus"


def test_app_profile_seeds_compose_yml(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="app")
    compose = fresh_home / "app" / "compose.yml"
    assert compose.is_file(), "profile=app must seed app/compose.yml"

    text = compose.read_text(encoding="utf-8")
    # The four portable-stack services must appear.
    for service in ("neo4j", "api", "ui"):
        assert f"\n  {service}:" in text, f"compose.yml missing service: {service}"


def test_native_profile_does_not_seed_compose_yml(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="native")
    assert not (fresh_home / "app").exists(), "native profile must not create app/"


def test_compose_yml_has_no_foreign_absolute_paths(fresh_home: Path) -> None:
    """FR-2 on the seeded compose file itself."""
    from benny.governance.portability import absolute_path_scanner as scanner

    home_mod.init(fresh_home, profile="app")
    compose = fresh_home / "app" / "compose.yml"
    text = compose.read_text(encoding="utf-8")
    hits = scanner.scan_text(text, ssd_root=str(fresh_home).replace("\\", "/"))
    assert not hits, f"compose.yml has foreign absolute paths: {hits}"
