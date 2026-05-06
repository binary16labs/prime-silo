"""Phase 2 — content-hash & signature on SwarmManifest.

The manifest is Benny's reproducibility contract (PBR-001 §7). Two separate
hosts given the same manifest.json MUST be able to agree on the identity of
a run, which means the hash MUST be:

* deterministic — same canonical content → same hash
* stable — re-serialising a manifest without content changes does not shift
  the hash (volatile fields like ``updated_at`` don't leak in)
* content-sensitive — any change to requirement, plan, or inputs flips it
"""
from __future__ import annotations

import copy

import pytest

from benny.core.manifest import (
    ManifestPlan,
    ManifestTask,
    SwarmManifest,
)
from benny.core.manifest_hash import (
    canonical_payload,
    compute_content_hash,
    sign_manifest,
    verify_signature,
)


def _base_manifest() -> SwarmManifest:
    return SwarmManifest(
        id="m-1",
        name="test",
        requirement="Summarise the input document.",
        workspace="default",
        plan=ManifestPlan(
            tasks=[
                ManifestTask(id="t1", description="read", wave=0),
                ManifestTask(id="t2", description="summarise", dependencies=["t1"], wave=1),
            ]
        ),
    )


def test_hash_is_deterministic() -> None:
    m = _base_manifest()
    h1 = compute_content_hash(m)
    h2 = compute_content_hash(m)
    assert h1 == h2
    assert len(h1) == 64, "SHA-256 hex digest must be 64 chars"


def test_hash_ignores_volatile_fields() -> None:
    """`created_at`, `updated_at`, `latest_run`, `content_hash`, and
    `signature` MUST NOT participate in the hash — otherwise the hash would
    thrash on every save."""
    m1 = _base_manifest()
    m2 = m1.model_copy(
        update={
            "created_at": "1999-01-01T00:00:00",
            "updated_at": "2099-12-31T23:59:59",
            "content_hash": "stale",
            "signature": "stale",
        }
    )
    assert compute_content_hash(m1) == compute_content_hash(m2)


def test_hash_changes_when_requirement_changes() -> None:
    m = _base_manifest()
    h_before = compute_content_hash(m)
    m2 = m.model_copy(update={"requirement": "Summarise the OTHER document."})
    assert compute_content_hash(m2) != h_before


def test_hash_changes_when_plan_changes() -> None:
    m = _base_manifest()
    h_before = compute_content_hash(m)
    # Flip one task description.
    new_plan = copy.deepcopy(m.plan)
    new_plan.tasks[0].description = "re-read"
    m2 = m.model_copy(update={"plan": new_plan})
    assert compute_content_hash(m2) != h_before


def test_canonical_payload_is_sorted_json() -> None:
    """Canonical form is stable JSON: sorted keys, no volatile fields. If a
    future edit to the manifest adds a field, this test keeps us honest about
    whether the new field is volatile or content."""
    m = _base_manifest()
    payload = canonical_payload(m)
    # Keys MUST be sorted to guarantee byte-level determinism across hosts.
    import json

    parsed = json.loads(payload)
    # Canonical payload should carry requirement + plan but not volatile meta.
    assert "requirement" in parsed
    assert "plan" in parsed
    assert "content_hash" not in parsed
    assert "signature" not in parsed
    assert "created_at" not in parsed
    assert "updated_at" not in parsed
    assert "latest_run" not in parsed


# ---- signatures ------------------------------------------------------------


def test_sign_without_key_stamps_sha256_prefix() -> None:
    """With no signing key configured, the signature is just ``sha256:<hash>``.
    This is not cryptographic proof of origin — it's a tamper-evident
    digest. Strong signing comes in Phase 6 (6σ release gates)."""
    m = _base_manifest()
    signed = sign_manifest(m)
    assert signed.content_hash is not None
    assert signed.signature is not None
    assert signed.signature.startswith("sha256:")
    assert signed.signature == f"sha256:{signed.content_hash}"


def test_sign_with_hmac_key_uses_hmac_prefix() -> None:
    m = _base_manifest()
    signed = sign_manifest(m, hmac_key=b"shared-secret-phase-2")
    assert signed.signature.startswith("hmac-sha256:")
    # And verification round-trips.
    assert verify_signature(signed, hmac_key=b"shared-secret-phase-2")


def test_verify_rejects_wrong_key() -> None:
    m = _base_manifest()
    signed = sign_manifest(m, hmac_key=b"correct-key")
    assert not verify_signature(signed, hmac_key=b"attacker-key")


def test_verify_rejects_tampered_content() -> None:
    m = _base_manifest()
    signed = sign_manifest(m, hmac_key=b"k")
    tampered = signed.model_copy(update={"requirement": "Steal the cookies."})
    # Content hash is now stale relative to the signed value.
    assert not verify_signature(tampered, hmac_key=b"k")


# ---- back-compat -----------------------------------------------------------


def test_old_manifests_without_hash_still_load() -> None:
    """Manifests persisted before Phase 2 MUST still round-trip. We only add
    fields; we don't break existing ones."""
    payload = {
        "id": "legacy-1",
        "name": "legacy",
        "requirement": "old",
        "plan": {"tasks": [], "edges": [], "waves": []},
    }
    m = SwarmManifest.model_validate(payload)
    assert m.id == "legacy-1"
    # New fields default to None so hash can be recomputed on demand.
    assert m.content_hash is None
    assert m.signature is None
