"""AAMP-F1, AAMP-F35, AAMP-SEC3, AAMP-SEC4 — skin-pack loader tests.

Covers:
  test_aamp_f1_skin_load_signed        — signed pack loads cleanly
  test_aamp_f1_unsigned_rejected       — unsigned pack rejected outside dev_mode
  test_aamp_f35_install_rejects_unsigned  — alias confirming SkinSignatureMissing raised
  test_aamp_f35_install_rejects_invalid_sig — HMAC tampered: SkinSignatureInvalid raised
  test_aamp_f35_no_bypass_flag         — no --bypass / no way around sig check in prod mode
  test_aamp_sec3_zip_path_traversal_rejected — zip with ../ member rejected
  test_aamp_sec4_signature_uses_shared_key_path — verify() honours BENNY_HMAC_KEY
"""

from __future__ import annotations

import io
import json
import os
import zipfile
from pathlib import Path

import pytest

from benny.agentamp.contracts import SkinManifest, SkinSignature
from benny.agentamp.signing import sign_skin_pack, verify_skin_pack
from benny.agentamp.skin import (
    SkinPathEscape,
    SkinSignatureInvalid,
    SkinSignatureMissing,
    load,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_aamp(tmp_path: Path, manifest: SkinManifest, extra_members: dict | None = None) -> Path:
    """Write a minimal .aamp zip containing skin.manifest.json."""
    pack = tmp_path / f"{manifest.id}.aamp"
    manifest_json = json.dumps(manifest.model_dump(mode="json"), indent=2, ensure_ascii=False)
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr("skin.manifest.json", manifest_json)
        for name, content in (extra_members or {}).items():
            zf.writestr(name, content)
    return pack


def _signed_manifest(skin_id: str = "test-skin") -> SkinManifest:
    """Return a SkinManifest with a valid HMAC signature."""
    m = SkinManifest(id=skin_id)
    raw = json.dumps(m.model_dump(mode="json"), indent=2, ensure_ascii=False)
    sig = sign_skin_pack(raw)
    return m.model_copy(update={"signature": sig})


# ---------------------------------------------------------------------------
# AAMP-F1: signed pack loads cleanly
# ---------------------------------------------------------------------------


def test_aamp_f1_skin_load_signed(tmp_path):
    """A correctly signed pack opens without raising."""
    manifest = _signed_manifest("happy-path-skin")
    pack = _make_aamp(tmp_path, manifest)

    loaded, zf = load(pack, dev_mode=False)
    zf.close()

    assert loaded.id == "happy-path-skin"
    assert loaded.signature is not None
    assert loaded.signature.algorithm == "HMAC-SHA256"


# ---------------------------------------------------------------------------
# AAMP-F1 / AAMP-F35: unsigned pack is rejected
# ---------------------------------------------------------------------------


def test_aamp_f1_unsigned_rejected(tmp_path):
    """An unsigned pack (signature=None) raises SkinSignatureMissing."""
    manifest = SkinManifest(id="unsigned-skin")  # signature is None by default
    pack = _make_aamp(tmp_path, manifest)

    with pytest.raises(SkinSignatureMissing):
        load(pack, dev_mode=False)


def test_aamp_f35_install_rejects_unsigned(tmp_path):
    """Alias for test_aamp_f1_unsigned_rejected — maps to AAMP-F35 acceptance row."""
    manifest = SkinManifest(id="unsigned-f35")
    pack = _make_aamp(tmp_path, manifest)

    with pytest.raises(SkinSignatureMissing):
        load(pack, dev_mode=False)


# ---------------------------------------------------------------------------
# AAMP-F35: tampered / invalid signature rejected
# ---------------------------------------------------------------------------


def test_aamp_f35_install_rejects_invalid_sig(tmp_path):
    """A pack with a tampered HMAC value raises SkinSignatureInvalid."""
    manifest = _signed_manifest("tampered-skin")
    # corrupt the signature value
    bad_sig = SkinSignature(
        algorithm="HMAC-SHA256",
        value="0" * 64,
        signed_at=manifest.signature.signed_at,
    )
    manifest = manifest.model_copy(update={"signature": bad_sig})
    pack = _make_aamp(tmp_path, manifest)

    with pytest.raises(SkinSignatureInvalid):
        load(pack, dev_mode=False)


# ---------------------------------------------------------------------------
# AAMP-F35: no bypass flag — dev_mode=True is the *only* way to skip sig check
# ---------------------------------------------------------------------------


def test_aamp_f35_no_bypass_flag(tmp_path):
    """There is no secret bypass: unsigned packs always fail in prod mode.

    This test verifies there is no ``bypass_signature`` parameter or similar
    escape hatch on the ``load()`` signature.
    """
    import inspect
    sig = inspect.signature(load)
    params = set(sig.parameters.keys())
    forbidden = {"bypass", "bypass_signature", "skip_sig", "no_verify"}
    assert params.isdisjoint(forbidden), (
        f"load() must not accept bypass params; found: {params & forbidden}"
    )


# ---------------------------------------------------------------------------
# AAMP-SEC3: path-traversal in zip members is rejected
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_member", [
    "../evil.py",
    "subdir/../../evil.py",
    "/etc/passwd",
])
def test_aamp_sec3_zip_path_traversal_rejected(tmp_path, bad_member):
    """A zip containing a path-traversal member name raises SkinPathEscape."""
    manifest = _signed_manifest("safe-skin")
    pack = tmp_path / "safe-skin.aamp"

    # Build the pack manually to insert the dangerous member
    manifest_json = json.dumps(manifest.model_dump(mode="json"), indent=2)
    with zipfile.ZipFile(pack, "w") as zf:
        zf.writestr("skin.manifest.json", manifest_json)
        zf.writestr(bad_member, "malicious content")

    with pytest.raises(SkinPathEscape):
        load(pack, dev_mode=False)


# ---------------------------------------------------------------------------
# AAMP-SEC4: signing respects BENNY_HMAC_KEY
# ---------------------------------------------------------------------------


def test_aamp_sec4_signature_uses_shared_key_path(tmp_path, monkeypatch):
    """verify_skin_pack() fails when a different HMAC key is used."""
    # Sign with key A
    monkeypatch.setenv("BENNY_HMAC_KEY", "aa" * 32)
    manifest = SkinManifest(id="key-test-skin")
    raw = json.dumps(manifest.model_dump(mode="json"), indent=2)
    sig_a = sign_skin_pack(raw)
    assert verify_skin_pack(raw, sig_a)  # same key → valid

    # Verify with key B → should fail
    monkeypatch.setenv("BENNY_HMAC_KEY", "bb" * 32)
    assert not verify_skin_pack(raw, sig_a)


def test_aamp_sec4_default_key_fallback(tmp_path):
    """sign+verify round-trip works without BENNY_HMAC_KEY in environment."""
    # Ensure env var is not set (or ignore it by using the default)
    env_key = os.environ.pop("BENNY_HMAC_KEY", None)
    try:
        manifest = SkinManifest(id="default-key-skin")
        raw = json.dumps(manifest.model_dump(mode="json"), indent=2)
        sig = sign_skin_pack(raw)
        assert verify_skin_pack(raw, sig)
    finally:
        if env_key is not None:
            os.environ["BENNY_HMAC_KEY"] = env_key


# ---------------------------------------------------------------------------
# dev_mode bypass (only for development — GATE-AAMP-DEVMODE-1 ensures False at release)
# ---------------------------------------------------------------------------


def test_dev_mode_allows_unsigned(tmp_path):
    """dev_mode=True lets an unsigned pack through (for local development)."""
    manifest = SkinManifest(id="dev-unsigned")
    pack = _make_aamp(tmp_path, manifest)

    loaded, zf = load(pack, dev_mode=True)
    zf.close()

    assert loaded.id == "dev-unsigned"
    assert loaded.signature is None
