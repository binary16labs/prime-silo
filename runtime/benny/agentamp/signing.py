"""AAMP-001 Phase 1 — Skin-pack HMAC signing (AAMP-SEC4).

Reuses the same HMAC-SHA256 approach and key-resolution path established by
``benny.sdlc.checkpoint`` (BENNY_HMAC_KEY env var → dev fallback key).

The signature covers a **canonical payload** derived from the skin manifest
JSON with the ``signature`` field stripped, serialised with sorted keys and
no whitespace.  This mirrors how ``benny.core.manifest_hash.sign_manifest``
works for SwarmManifests.

Public API
----------
  sign_skin_pack(manifest_json: str) -> SkinSignature
      Compute and return a :class:`SkinSignature` for *manifest_json*.

  verify_skin_pack(manifest_json: str, sig: SkinSignature) -> bool
      Return ``True`` iff *sig* is a valid HMAC-SHA256 over the canonical
      payload extracted from *manifest_json*.

  canonical_skin_payload(manifest_json: str) -> str
      Return the deterministic string that backs the signature.
      Exported so tests can inspect it without re-implementing the logic.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any

from .contracts import SkinSignature

# HMAC key resolution — identical pattern to benny.sdlc.checkpoint._get_hmac_key
_DEFAULT_KEY = b"benny-aos-dev-hmac-key-do-not-use-in-prod-000"


def _get_hmac_key() -> bytes:
    raw = os.environ.get("BENNY_HMAC_KEY", "")
    if raw:
        try:
            return bytes.fromhex(raw)
        except ValueError:
            pass
    return _DEFAULT_KEY


def canonical_skin_payload(manifest_json: str) -> str:
    """Return the deterministic signing payload for a skin manifest JSON string.

    The ``signature`` field is stripped (if present) before serialisation so
    that the payload is stable across sign → verify round-trips.
    """
    data: dict[str, Any] = json.loads(manifest_json)
    data.pop("signature", None)
    return json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_skin_pack(manifest_json: str) -> SkinSignature:
    """Compute an HMAC-SHA256 :class:`SkinSignature` over *manifest_json*.

    The signing key is resolved from ``BENNY_HMAC_KEY`` (or the dev fallback).
    """
    key = _get_hmac_key()
    payload = canonical_skin_payload(manifest_json).encode("utf-8")
    tag = hmac.new(key, payload, hashlib.sha256).hexdigest()
    return SkinSignature(
        algorithm="HMAC-SHA256",
        value=tag,
        signed_at=datetime.now(tz=timezone.utc).isoformat(),
    )


def verify_skin_pack(manifest_json: str, sig: SkinSignature) -> bool:
    """Return ``True`` iff *sig.value* is a valid HMAC-SHA256 for *manifest_json*.

    Uses ``hmac.compare_digest`` to prevent timing-side-channel leakage.
    """
    if sig.algorithm != "HMAC-SHA256":
        return False
    key = _get_hmac_key()
    payload = canonical_skin_payload(manifest_json).encode("utf-8")
    expected = hmac.new(key, payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, sig.value)
