"""L12 — human-signed model promotion + rollback (EP-L / wave 3).

Promotion of model N+1 to the served position behind the router requires a HUMAN SIGNATURE — never
an auto-swap on a passing number (R39; owner human-signed-stops doctrine). Every promotion is
reversible: the served pointer records what N+1 replaced and how to revert (pin + rollback). The
served pointer is the §5.5 ``model_promotion`` record; this is the same record L6's ``recordServed``
writes on the JS side — one shape, both languages.

This module OWNS the served-pointer file only. It does not touch the default engine or the RAG path;
the router asks ``tuned_engine.served_engine_id`` who is served, which is additive (R36).

The enforced invariant is *no signature ⇒ no served change*. Cryptographic verification of the
signature is a future extension; here a signature is "present" when it is a non-empty string — the
point of L12 is that a passing metric vector ALONE can never move the served position.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Optional

SCHEMA_VERSION = "1.0.0"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _valid_signature(sig: Optional[str]) -> bool:
    """A human signature is present when it is a non-empty string. None/""/whitespace ⇒ unsigned."""
    return isinstance(sig, str) and sig.strip() != ""


def read_served(pointer_path: str) -> Optional[dict]:
    """The current served-model pointer (a §5.5 model_promotion record), or None if unset."""
    try:
        with open(pointer_path, encoding="utf-8") as fh:
            return json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _write(pointer_path: str, record: dict) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(pointer_path)), exist_ok=True)
    with open(pointer_path, "w", encoding="utf-8") as fh:
        json.dump(record, fh, indent=2)
        fh.write("\n")


def promote(
    pointer_path: str,
    served: str,
    *,
    human_signature: Optional[str] = None,
    decision_vector: Optional[dict] = None,
    decision_rule: Optional[str] = None,
) -> dict:
    """Promote ``served`` to the served position — ONLY with a valid human signature.

    Without a signature the served position is left untouched (returns ok=False). With one, writes a
    new model_promotion record naming ``served``, the model it ``replaces`` (the prior served), and
    ``rollback_to`` (how to revert). A passing ``decision_vector`` alone never swaps.
    """
    if not _valid_signature(human_signature):
        return {"ok": False, "reason": "unsigned-promotion-refused"}

    prior = read_served(pointer_path)
    prior_served = prior.get("served") if prior else None
    record = {
        "type": "model_promotion",
        "served": served,
        "replaces": prior_served,
        "decision_vector": decision_vector,
        "decision_rule": decision_rule,
        "human_signature": human_signature,
        "rollback_to": prior_served,
        "valid_time": _now(),
        "txn_time": _now(),
        "schema_version": SCHEMA_VERSION,
    }
    _write(pointer_path, record)
    return {"ok": True, "served": served, "replaces": prior_served}


def rollback(pointer_path: str, *, human_signature: Optional[str] = None) -> dict:
    """Revert to the exact prior served model recorded in the current pointer.

    Rollback is a served-position change, so it too is human-signed. Restores ``rollback_to`` (the
    predecessor) and records the model it just reverted away from, so the revert is itself reversible.
    """
    cur = read_served(pointer_path)
    if not cur:
        return {"ok": False, "reason": "nothing-to-roll-back"}
    target = cur.get("rollback_to") or cur.get("replaces")
    if target is None:
        return {"ok": False, "reason": "no-predecessor-to-restore"}
    if not _valid_signature(human_signature):
        return {"ok": False, "reason": "unsigned-rollback-refused"}

    record = {
        "type": "model_promotion",
        "served": target,
        "replaces": cur.get("served"),
        "decision_vector": cur.get("decision_vector"),
        "decision_rule": "rollback",
        "human_signature": human_signature,
        "rollback_to": cur.get("served"),  # so a rollback can itself be rolled back
        "valid_time": _now(),
        "txn_time": _now(),
        "schema_version": SCHEMA_VERSION,
    }
    _write(pointer_path, record)
    return {"ok": True, "served": target, "reverted_from": cur.get("served")}
