"""Content-hash + signature for SwarmManifest (PBR-001 Phase 2).

A manifest is the reproducibility contract of a Benny run. Two hosts given
the same ``manifest.json`` must agree on the *identity* of that manifest —
otherwise "run this again" has no meaning across machines.

The identity is the ``content_hash``: the SHA-256 of a canonical JSON
projection of the manifest with the volatile, authoring-time fields
stripped. The ``signature`` is a thin wrapper over the hash:

* ``sha256:<hex>`` — digest-only (no secret configured)
* ``hmac-sha256:<hex>`` — HMAC-SHA-256 over the canonical payload

HMAC is not full cryptographic provenance (no key rotation, no chain of
custody) — it's a tamper-evident marker that proves a holder of the secret
produced this payload. Real signing (ed25519 + registry) lands in Phase 6.
"""
from __future__ import annotations

import hashlib
import hmac
import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from benny.core.manifest import SwarmManifest

# Fields that must NOT participate in the hash, because they change for
# reasons unrelated to the manifest's semantic content. Adding a new field
# here deserves a PR-level discussion — that's why the list is explicit.
_VOLATILE_FIELDS: frozenset[str] = frozenset(
    {
        "content_hash",
        "signature",
        "created_at",
        "updated_at",
        "latest_run",
    }
)

_HMAC_PREFIX = "hmac-sha256:"
_SHA_PREFIX = "sha256:"


def canonical_payload(manifest: "SwarmManifest") -> str:
    """Return the deterministic JSON bytes that back the content hash.

    Sorted keys, no whitespace, volatile fields removed. Two hosts holding
    the same manifest get byte-identical output from this function.
    """
    raw: dict[str, Any] = manifest.model_dump(mode="json")
    for key in _VOLATILE_FIELDS:
        raw.pop(key, None)
    return json.dumps(raw, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def compute_content_hash(manifest: "SwarmManifest") -> str:
    """SHA-256 of the canonical payload, hex-encoded."""
    payload = canonical_payload(manifest).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def sign_manifest(
    manifest: "SwarmManifest", *, hmac_key: bytes | None = None
) -> "SwarmManifest":
    """Return a new manifest with ``content_hash`` and ``signature`` set.

    The original is left untouched — callers store the signed copy.
    """
    digest = compute_content_hash(manifest)
    if hmac_key is None:
        signature = f"{_SHA_PREFIX}{digest}"
    else:
        mac = hmac.new(hmac_key, canonical_payload(manifest).encode("utf-8"), hashlib.sha256)
        signature = f"{_HMAC_PREFIX}{mac.hexdigest()}"
    return manifest.model_copy(update={"content_hash": digest, "signature": signature})


def verify_signature(manifest: "SwarmManifest", *, hmac_key: bytes | None = None) -> bool:
    """Return True iff the manifest's signature matches its current content.

    For ``sha256:`` signatures any party can verify (it's just a digest).
    For ``hmac-sha256:`` signatures the caller must supply the same key that
    signed the manifest.
    """
    sig = manifest.signature or ""
    expected_hash = compute_content_hash(manifest)

    if sig.startswith(_SHA_PREFIX):
        claimed = sig[len(_SHA_PREFIX) :]
        return hmac.compare_digest(claimed, expected_hash)

    if sig.startswith(_HMAC_PREFIX):
        if hmac_key is None:
            return False
        mac = hmac.new(hmac_key, canonical_payload(manifest).encode("utf-8"), hashlib.sha256)
        claimed = sig[len(_HMAC_PREFIX) :]
        return hmac.compare_digest(claimed, mac.hexdigest())

    return False
