"""resolve_home() — the Python mirror of packaging/desktop/home_resolver.js.

Verifies root precedence (PRIME_SILO_HOME env > desktop-config homeDir >
per-user default), $BENNY_HOME derivation, legacy-key handling, and that the
workspace root can never fall back to a cwd-relative path (the pre-Phase-0
source of run debris committed into the git checkout).
"""

from pathlib import Path

import benny.portable.home as home_mod
from benny.portable.home import resolve_benny_home, resolve_home


def _isolate(monkeypatch, tmp_path):
    """Point the per-user config dir at tmp and neutralise ambient env."""
    user_data = tmp_path / "Prime-Silo"
    user_data.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(home_mod, "_user_data_path", lambda env=None: user_data)
    return user_data


def test_default_root_is_per_user_not_cwd(monkeypatch, tmp_path):
    user_data = _isolate(monkeypatch, tmp_path)
    resolved = resolve_home(env={})
    assert resolved.source == "default"
    assert resolved.root == user_data / "prime-silo-home"
    assert resolved.benny_home == resolved.root / "benny"
    assert resolved.benny_home_source == "derived"
    # Never a cwd-relative path.
    assert resolved.benny_home.is_absolute()


def test_env_root_beats_config(monkeypatch, tmp_path):
    user_data = _isolate(monkeypatch, tmp_path)
    (user_data / "prime-silo-config.json").write_text(
        '{"homeDir": "%s"}' % (tmp_path / "cfg-home").as_posix(), encoding="utf-8"
    )
    resolved = resolve_home(env={"PRIME_SILO_HOME": str(tmp_path / "env-home")})
    assert resolved.source == "env"
    assert resolved.root == (tmp_path / "env-home").resolve()

    by_config = resolve_home(env={})
    assert by_config.source == "config"
    assert by_config.root == (tmp_path / "cfg-home").resolve()


def test_benny_home_env_override_wins_and_warns_outside_root(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    resolved = resolve_home(
        env={
            "PRIME_SILO_HOME": str(tmp_path / "declared"),
            "BENNY_HOME": str(tmp_path / "elsewhere"),
        }
    )
    assert resolved.benny_home == (tmp_path / "elsewhere").resolve()
    assert resolved.benny_home_source == "env-override"
    assert any("BENNY_HOME" in w for w in resolved.warnings)

    inside = resolve_home(
        env={
            "PRIME_SILO_HOME": str(tmp_path / "declared"),
            "BENNY_HOME": str(tmp_path / "declared" / "benny"),
        }
    )
    assert not any("BENNY_HOME" in w for w in inside.warnings)


def test_legacy_config_benny_home_honored_with_warning(monkeypatch, tmp_path):
    user_data = _isolate(monkeypatch, tmp_path)
    (user_data / "prime-silo-config.json").write_text(
        '{"bennyHome": "%s"}' % (tmp_path / "old-home").as_posix(), encoding="utf-8"
    )
    resolved = resolve_home(env={})
    assert resolved.benny_home == (tmp_path / "old-home").resolve()
    assert resolved.benny_home_source == "legacy-config"
    assert any("bennyHome" in w for w in resolved.warnings)


def test_legacy_default_dir_detected(monkeypatch, tmp_path):
    user_data = _isolate(monkeypatch, tmp_path)
    (user_data / "benny-home").mkdir()
    resolved = resolve_home(env={})
    assert resolved.benny_home == user_data / "benny-home"
    assert resolved.benny_home_source == "legacy-default"


def test_resolve_benny_home_matches_resolve_home(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path)
    env = {"BENNY_HOME": str(tmp_path / "bh")}
    assert resolve_benny_home(env) == resolve_home(env).benny_home


def test_workspace_root_never_cwd_relative():
    # WORKSPACE_ROOT is computed at import via resolve_benny_home(); whatever
    # the ambient env, it must be absolute (the old code fell back to a
    # relative "workspace" dir inside the git checkout).
    from benny.core.workspace import WORKSPACE_ROOT

    assert Path(WORKSPACE_ROOT).is_absolute()
    assert Path(WORKSPACE_ROOT).name == "workspaces"
