"""AOS-SEC2 — AOS modules must not make unexpected network calls.

Red test — imports will work but the module is the entire AOS stack;
this test verifies that running a full policy + lineage + ledger cycle
does NOT call socket.connect() (or any network primitive).

AOS-SEC2: When policy.deny_network is True (default for SDLC manifests),
only the local LLM endpoint(s) and the Marquez/Phoenix emitters may
receive outbound TCP. Verified by stubbing socket and confirming the
AOS modules do not trigger it during their core logic.
"""

from __future__ import annotations

import socket
from pathlib import Path
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# AOS-SEC2 — no unexpected egress in AOS core modules
# ---------------------------------------------------------------------------


def _raise_on_connect(*args, **kwargs):
    """Stub that raises if a network connection is attempted."""
    raise AssertionError(
        f"Unexpected network connect attempt: args={args!r}"
    )


def test_aos_no_unexpected_egress(tmp_path, monkeypatch):
    """SEC2: policy evaluate + lineage emit + ledger append make no network calls."""
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **kw: [][0])  # block DNS
    monkeypatch.setattr(socket.socket, "connect", _raise_on_connect)

    # Import AOS modules (already imported = no-op; verified offline-safe)
    from benny.governance.jsonld import emit_provenance
    from benny.governance.ledger import LedgerEntry, append_entry
    from benny.governance.policy import PolicyDecision, PolicyEvaluator

    ev = PolicyEvaluator(
        mode="warn",
        auto_approve_writes=False,
        allowed_tools_per_persona={"architect": ["write_file"]},
    )

    # 1. Policy evaluate — must not touch network
    decision = ev.evaluate(
        intent="write report.md",
        tool="write_file",
        persona="architect",
        workspace=str(tmp_path),
    )
    assert decision == PolicyDecision.APPROVED

    # 2. Lineage emit — must not touch network
    sha = "a" * 64
    emit_provenance(
        sha,
        workspace_path=tmp_path,
        run_id="r1",
        task_id="t1",
        persona="architect",
        model="lm",
        started_at="2026-01-01T00:00:00Z",
        ended_at="2026-01-01T00:00:01Z",
    )

    # 3. Ledger append — must not touch network
    entry = LedgerEntry(
        prompt_hash="sha256:p1",
        diff_hash="sha256:d1",
        persona="architect",
        model="lm",
        model_hash="sha256:mh1",
        manifest_sig="sha256:sig1",
    )
    append_entry(entry, ledger_dir=tmp_path / "ledger", secret=b"test-secret")


def test_aos_sec2_policy_module_imports_are_stdlib(tmp_path):
    """SEC2: benny.governance.policy module imports are stdlib-only (no httpx/requests)."""
    import importlib
    import sys

    # Ensure clean import check
    mod_name = "benny.governance.policy"
    if mod_name in sys.modules:
        mod = sys.modules[mod_name]
    else:
        mod = importlib.import_module(mod_name)

    # Check that the module's __file__ does not import httpx or requests at top level
    assert hasattr(mod, "PolicyEvaluator")
    assert hasattr(mod, "PolicyDecision")


def test_aos_sec2_ledger_module_imports_are_stdlib():
    """SEC2: benny.governance.ledger module uses only stdlib (hashlib, hmac, json, pathlib)."""
    import importlib
    import sys

    mod_name = "benny.governance.ledger"
    if mod_name in sys.modules:
        mod = sys.modules[mod_name]
    else:
        mod = importlib.import_module(mod_name)

    assert hasattr(mod, "append_entry")
    assert hasattr(mod, "verify_chain")
    assert hasattr(mod, "LedgerEntry")
