"""Per-install HMAC signing key — generated on `benny init`, resolved by the
signing surfaces before the non-production dev fallback.

Covers: the key is seeded once under state/, is valid 64-char hex, survives a
re-init (idempotent like device-id), and the env helpers resolve / export it.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

from benny.portable import home as home_mod


@pytest.fixture
def fresh_home(tmp_path: Path) -> Path:
    return tmp_path / "optimus"


def test_init_seeds_hmac_key(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="native")
    key_file = fresh_home / "state" / "hmac-key"
    assert key_file.is_file(), "init should seed state/hmac-key"
    value = key_file.read_text(encoding="utf-8").strip()
    assert len(value) == 64, "expected 32 bytes as 64 hex chars"
    bytes.fromhex(value)  # raises if not valid hex


def test_hmac_key_is_idempotent(fresh_home: Path) -> None:
    home_mod.init(fresh_home, profile="native")
    first = home_mod.read_install_hmac_key(fresh_home)
    # A second init must not rotate the key (it is an install identity).
    home_mod.init(fresh_home, profile="native")
    second = home_mod.read_install_hmac_key(fresh_home)
    assert first is not None
    assert first == second


def test_read_install_hmac_key_missing(tmp_path: Path) -> None:
    assert home_mod.read_install_hmac_key(tmp_path / "never-inited") is None


def test_env_home_resolution(fresh_home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    home_mod.init(fresh_home, profile="native")
    expected = home_mod.read_install_hmac_key(fresh_home)
    monkeypatch.setenv("BENNY_HOME", str(fresh_home))
    monkeypatch.delenv("BENNY_HMAC_KEY", raising=False)

    key_bytes = home_mod.install_hmac_key_bytes_from_env_home()
    assert key_bytes == bytes.fromhex(expected)


def test_ensure_hmac_key_in_env_sets_and_respects_existing(
    fresh_home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    home_mod.init(fresh_home, profile="native")
    install_key = home_mod.read_install_hmac_key(fresh_home)

    # Unset: the install key is exported.
    monkeypatch.delenv("BENNY_HMAC_KEY", raising=False)
    assert home_mod.ensure_hmac_key_in_env(fresh_home) == install_key
    assert os.environ["BENNY_HMAC_KEY"] == install_key

    # Already set: an explicit key always wins.
    monkeypatch.setenv("BENNY_HMAC_KEY", "deadbeef")
    assert home_mod.ensure_hmac_key_in_env(fresh_home) == "deadbeef"
    assert os.environ["BENNY_HMAC_KEY"] == "deadbeef"
