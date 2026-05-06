"""AAMP-SEC4 — skin-pack signing unit tests.

Covers:
  sign_skin_pack() → valid SkinSignature
  verify_skin_pack() → True for correct sig, False for wrong sig / wrong key / tampered payload
  canonical_skin_payload() → signature field is stripped; output is deterministic
"""

from __future__ import annotations

import json

import pytest

from benny.agentamp.contracts import SkinManifest, SkinSignature
from benny.agentamp.signing import canonical_skin_payload, sign_skin_pack, verify_skin_pack


def _manifest_json(skin_id: str = "test") -> str:
    m = SkinManifest(id=skin_id)
    return json.dumps(m.model_dump(mode="json"), indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Round-trip
# ---------------------------------------------------------------------------


def test_sign_verify_round_trip():
    raw = _manifest_json("round-trip")
    sig = sign_skin_pack(raw)
    assert verify_skin_pack(raw, sig)


def test_sign_sets_hmac_sha256():
    raw = _manifest_json()
    sig = sign_skin_pack(raw)
    assert sig.algorithm == "HMAC-SHA256"
    assert len(sig.value) == 64  # hex SHA-256


def test_verify_rejects_wrong_value():
    raw = _manifest_json()
    sig = sign_skin_pack(raw)
    bad = SkinSignature(algorithm="HMAC-SHA256", value="0" * 64, signed_at=sig.signed_at)
    assert not verify_skin_pack(raw, bad)


# ---------------------------------------------------------------------------
# Tamper detection
# ---------------------------------------------------------------------------


def test_verify_fails_on_tampered_payload():
    raw = _manifest_json("tamper-me")
    sig = sign_skin_pack(raw)

    data = json.loads(raw)
    data["id"] = "evil-skin"
    tampered = json.dumps(data)

    assert not verify_skin_pack(tampered, sig)


def test_verify_rejects_unknown_algorithm():
    raw = _manifest_json()
    sig = SkinSignature(algorithm="SHA256", value="abc", signed_at="2026-01-01T00:00:00+00:00")
    assert not verify_skin_pack(raw, sig)


# ---------------------------------------------------------------------------
# canonical_skin_payload — signature field is stripped
# ---------------------------------------------------------------------------


def test_canonical_strips_signature_field():
    raw = _manifest_json()
    sig = sign_skin_pack(raw)

    # Embed signature into manifest JSON
    data = json.loads(raw)
    data["signature"] = sig.model_dump(mode="json")
    signed_raw = json.dumps(data)

    canonical_unsigned = canonical_skin_payload(raw)
    canonical_signed = canonical_skin_payload(signed_raw)

    assert canonical_unsigned == canonical_signed


def test_canonical_is_deterministic():
    raw = _manifest_json("det")
    assert canonical_skin_payload(raw) == canonical_skin_payload(raw)


# ---------------------------------------------------------------------------
# Key isolation
# ---------------------------------------------------------------------------


def test_different_keys_produce_different_sigs(monkeypatch):
    raw = _manifest_json()

    monkeypatch.setenv("BENNY_HMAC_KEY", "aa" * 32)
    sig_a = sign_skin_pack(raw)

    monkeypatch.setenv("BENNY_HMAC_KEY", "bb" * 32)
    sig_b = sign_skin_pack(raw)

    assert sig_a.value != sig_b.value


def test_verify_fails_with_wrong_key(monkeypatch):
    raw = _manifest_json()

    monkeypatch.setenv("BENNY_HMAC_KEY", "cc" * 32)
    sig = sign_skin_pack(raw)

    monkeypatch.setenv("BENNY_HMAC_KEY", "dd" * 32)
    assert not verify_skin_pack(raw, sig)
