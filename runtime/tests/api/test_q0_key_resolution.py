"""Q0 — single key-resolution path: env BENNY_API_KEY -> per-install keystore
($BENNY_HOME/state/hmac-key) -> fail fast with an actionable error.

Test names map to the contract scenarios in delivery/tasks/Q0.md.
Hermetic: tmp_path keystores, no live services.
"""

import pytest

from benny.api.agent_scope import (
    derive_agent_api_key_from_install_key,
)
from benny.api.agent_scope import (
    resolve_benny_api_key as _resolve_benny_api_key,
)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("BENNY_API_KEY", raising=False)
    monkeypatch.delenv("BENNY_AGENT_API_KEY", raising=False)
    monkeypatch.delenv("BENNY_HOME", raising=False)


def _write_keystore(root, value: str) -> None:
    state = root / "state"
    state.mkdir(parents=True, exist_ok=True)
    (state / "hmac-key").write_text(value, encoding="utf-8")


def test_scenario_missing_key_fails_fast_naming_env_and_keystore():
    """Scenario: burned credential is gone and absence fails fast."""
    with pytest.raises(RuntimeError) as excinfo:
        _resolve_benny_api_key()
    message = str(excinfo.value)
    assert "BENNY_API_KEY" in message
    assert "state/hmac-key" in message


def test_scenario_env_key_honoured_first(monkeypatch, tmp_path):
    """Scenario: local development still boots — env wins over the keystore."""
    _write_keystore(tmp_path, "aa" * 32)
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    monkeypatch.setenv("BENNY_API_KEY", "q0-explicit-env-key")
    assert _resolve_benny_api_key() == "q0-explicit-env-key"


def test_scenario_keystore_fallback_reads_install_key(monkeypatch, tmp_path):
    """Scenario: local development still boots — keystore is the fallback."""
    _write_keystore(tmp_path, "ab" * 32)
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    assert _resolve_benny_api_key() == "ab" * 32


def test_scenario_empty_keystore_still_fails_fast(monkeypatch, tmp_path):
    _write_keystore(tmp_path, "")
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    with pytest.raises(RuntimeError):
        _resolve_benny_api_key()


def test_scenario_agent_key_derivation_parity_with_node():
    """The agent-key derivation MUST match server/lib/runtime_proxy.js
    byte-for-byte. Node parity check (same fixture, same digest) lives in
    tests/adr003_same_origin_followup_test.mjs — both pin this exact digest:

        node -e "console.log(require('crypto').createHmac('sha256',
          Buffer.from('ab'.repeat(32),'hex')).update('benny-agent-scope')
          .digest('hex'))"
    """
    install_key = bytes.fromhex("ab" * 32)
    derived = derive_agent_api_key_from_install_key(install_key)
    assert derived == "eb8eaf640b7c05686f1da81b432bdd4ba9cc7e466fff704a209dd6693dfaaa70"


def test_scenario_agent_key_differs_from_human_key(monkeypatch, tmp_path):
    """ADR-003: human and agent credentials must never collapse into one."""
    _write_keystore(tmp_path, "ab" * 32)
    monkeypatch.setenv("BENNY_HOME", str(tmp_path))
    human = _resolve_benny_api_key()
    agent = derive_agent_api_key_from_install_key(bytes.fromhex("ab" * 32))
    assert human != agent
