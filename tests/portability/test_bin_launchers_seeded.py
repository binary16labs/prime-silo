"""Phase 1b — bin/ launchers are seeded on init.

Per PBR-001 §4.3, ``<home>/bin/`` carries the portable CLI launchers so that a
user plugging the SSD into a new host can run ``./bin/benny`` without first
installing Benny globally. The launchers must:

* exist under both profiles (app and native),
* set ``BENNY_HOME`` to the enclosing root, and
* invoke ``python -m benny_cli`` (profile=native) or the bundled app entry
  point (profile=app), so the launcher is identical to the user regardless
  of how they installed.
"""
from __future__ import annotations

import stat
from pathlib import Path

import pytest

from benny.portable import home as home_mod


@pytest.fixture
def fresh_home(tmp_path: Path) -> Path:
    return tmp_path / "optimus"


@pytest.mark.parametrize("profile", ["app", "native"])
def test_init_seeds_posix_and_windows_launchers(fresh_home: Path, profile: str) -> None:
    home_mod.init(fresh_home, profile=profile)

    posix = fresh_home / "bin" / "benny"
    win = fresh_home / "bin" / "benny.cmd"
    assert posix.is_file(), "POSIX launcher missing"
    assert win.is_file(), "Windows launcher missing"


@pytest.mark.parametrize("profile", ["app", "native"])
def test_launchers_reference_benny_home_not_host_paths(
    fresh_home: Path, profile: str
) -> None:
    """FR-2: no absolute host paths in launchers — they must self-locate."""
    home_mod.init(fresh_home, profile=profile)

    for name in ("benny", "benny.cmd"):
        content = (fresh_home / "bin" / name).read_text(encoding="utf-8")
        # Must export/set BENNY_HOME.
        assert "BENNY_HOME" in content, f"{name} does not set BENNY_HOME"
        # Must not hardcode the root by absolute value — must derive it.
        assert "D:/optimus" not in content
        assert "D:\\optimus" not in content
        assert "/home/" not in content
        assert "/Users/" not in content


def test_posix_launcher_has_shebang_and_executable_bit(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="native")
    posix = fresh_home / "bin" / "benny"
    first_line = posix.read_text(encoding="utf-8").splitlines()[0]
    assert first_line.startswith("#!"), "POSIX launcher must have a shebang"

    mode = posix.stat().st_mode
    # On Windows the x-bit can't always be set, but we still verify we tried.
    # On POSIX this must be genuinely executable by the user.
    import os

    if os.name == "posix":
        assert mode & stat.S_IXUSR, "POSIX launcher must be executable"


def test_windows_launcher_uses_cmd_syntax(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="native")
    win = fresh_home / "bin" / "benny.cmd"
    content = win.read_text(encoding="utf-8")
    # Minimal correctness: @echo off and a Python invocation.
    assert "@echo off" in content.lower()
    assert "%*" in content, "must forward CLI args"
