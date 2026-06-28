"""ADR-001 Phase F — `.aamp.view` HMAC signing helpers.

A pinned ``.aamp.view`` is the canonical, replayable form of a layout the
in-browser agent (or a human) has composed. Pinning = HMAC-SHA256 over a
canonical JSON payload, using the same key resolution path established by
:mod:`benny.agentamp.signing` (``BENNY_HMAC_KEY`` env var → dev fallback).

Why the same pattern, copied not imported:
  Skin packs and views share a signing technique, but they are different
  surfaces with different field schemas. Reusing the *technique* via
  :func:`canonical_view_payload` keeps the signature deterministic; reusing
  the *module* would couple unrelated change windows. If the skin pack ever
  switches algorithms, that change should not silently propagate to views.

Public API
----------
  canonical_view_payload(view: dict) -> str
      Deterministic UTF-8 string the signature is computed over. Strips a
      pre-existing ``signature`` field so signing is idempotent across
      sign → embed → re-sign loops.

  sign_view(view: dict) -> ViewSignature
      Compute and return a :class:`ViewSignature`.

  verify_view(view: dict, signature: ViewSignature) -> bool
      Return True iff *signature* is a valid HMAC-SHA256 over the canonical
      payload of *view*. Uses ``hmac.compare_digest`` to avoid timing leaks.

This module is intentionally write-free — it never reads or writes view
files. The pinning lifecycle (read draft → sign → write canonical) lives
in :mod:`benny.api.views_routes`.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel

# Same dev fallback string used by benny.agentamp.signing — keeping the keys
# aligned in dev mode means a single ``BENNY_HMAC_KEY=hex...`` exports both
# surfaces. The default is explicitly NOT a production key.
_DEFAULT_KEY = b"benny-aos-dev-hmac-key-do-not-use-in-prod-000"


def _get_hmac_key() -> bytes:
    raw = os.environ.get("BENNY_HMAC_KEY", "")
    if raw:
        try:
            return bytes.fromhex(raw)
        except ValueError:
            pass
    # Per-install key persisted by `benny init` at $BENNY_HOME/state/hmac-key —
    # used before the non-production dev fallback so signatures are tied to this
    # install rather than a key every install shares.
    from ..portable.home import install_hmac_key_bytes_from_env_home

    install_key = install_hmac_key_bytes_from_env_home()
    if install_key is not None:
        return install_key
    return _DEFAULT_KEY


class ViewSignature(BaseModel):
    """Pydantic envelope returned by :func:`sign_view` and accepted by
    :func:`verify_view`. Mirrors :class:`benny.agentamp.contracts.SkinSignature`
    intentionally — same shape, separate name so view signatures and skin
    signatures cannot be mixed up by type check alone."""

    algorithm: str = "HMAC-SHA256"
    value: str
    signed_at: str  # ISO-8601 UTC


def canonical_view_payload(view: dict[str, Any]) -> str:
    """Return the deterministic signing payload for a view dict.

    Strips a pre-existing ``signature`` field so signing is idempotent: a
    pinned view that already carries a signature can be re-signed without
    the prior signature affecting the new one.
    """
    if not isinstance(view, dict):
        raise TypeError("canonical_view_payload: view must be a dict.")
    cloned = {k: v for k, v in view.items() if k != "signature"}
    return json.dumps(cloned, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sign_view(view: dict[str, Any]) -> ViewSignature:
    """Compute an HMAC-SHA256 :class:`ViewSignature` over *view*."""
    key = _get_hmac_key()
    payload = canonical_view_payload(view).encode("utf-8")
    tag = hmac.new(key, payload, hashlib.sha256).hexdigest()
    return ViewSignature(
        algorithm="HMAC-SHA256",
        value=tag,
        signed_at=datetime.now(tz=timezone.utc).isoformat(),
    )


def verify_view(view: dict[str, Any], signature: ViewSignature) -> bool:
    """Return True iff *signature* validly signs *view*.

    Pinned views may store the signature inline under a top-level
    ``signature`` field; :func:`canonical_view_payload` strips it before
    hashing so verification of an inline-signed view round-trips correctly.
    """
    if signature.algorithm != "HMAC-SHA256":
        return False
    key = _get_hmac_key()
    payload = canonical_view_payload(view).encode("utf-8")
    expected = hmac.new(key, payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature.value)
