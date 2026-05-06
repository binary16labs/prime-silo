"""AAMP-001 Phase 5 — Equalizer panel + manifest write path acceptance tests.

Covers
------
  AAMP-F9    test_aamp_f9_eq_write_signs_manifest
  AAMP-F10   test_aamp_f10_per_task_picker, test_aamp_f10_knob_lock_persists
  AAMP-SEC5  test_aamp_sec5_eq_write_policy_evaluated
  AAMP-COMP1 test_aamp_comp1_eq_write_ledger_entry
  AAMP-COMP2 test_aamp_comp2_previous_signatures_preserved
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from benny.agentamp.equalizer import (
    EQ_ALLOWED_PATHS,
    EqKnob,
    EqLock,
    EqManifest,
    EqPathNotAllowed,
    EqWriteResult,
    apply_eq_write,
    validate_knob_path,
)
from benny.governance.ledger import verify_chain  # noqa: direct submodule import
from benny.governance.policy import (  # noqa: direct submodule import
    AAMP_TOOL_EQ_WRITE,
    PolicyDeniedError,
    PolicyEvaluator,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_LEDGER_SECRET = b"test-ledger-secret"


def _make_manifest(
    model: str = "gpt-4o",
    max_concurrency: int = 1,
    signature: Any = None,
) -> Dict[str, Any]:
    """Minimal SwarmManifest dict for tests."""
    return {
        "schema_version": "1.0",
        "id": "test-manifest-001",
        "name": "Test Manifest",
        "config": {
            "model": model,
            "max_concurrency": max_concurrency,
            "max_depth": 3,
        },
        "plan": {
            "tasks": [
                {"id": "t1", "description": "Task 1", "complexity": "medium"},
                {"id": "t2", "description": "Task 2", "complexity": "low"},
            ],
            "edges": [],
        },
        "signature": signature,
    }


def _permissive_evaluator(persona: str = "aamp:user") -> PolicyEvaluator:
    return PolicyEvaluator(
        mode="enforce",
        auto_approve_writes=False,
        allowed_tools_per_persona={persona: [AAMP_TOOL_EQ_WRITE]},
    )


def _apply(
    knobs: List[EqKnob],
    manifest: Dict[str, Any] | None = None,
    *,
    tmp_path: Path,
    task_ids: List[str] | None = None,
    evaluator: PolicyEvaluator | None = None,
) -> EqWriteResult:
    return apply_eq_write(
        manifest or _make_manifest(),
        knobs,
        workspace="test_ws",
        benny_home=tmp_path,
        policy_evaluator=evaluator or _permissive_evaluator(),
        ledger_dir=tmp_path / "ledger",
        ledger_secret=_LEDGER_SECRET,
        task_ids=task_ids,
    )


# ---------------------------------------------------------------------------
# allow-list validation (AAMP-F9)
# ---------------------------------------------------------------------------


def test_allowed_paths_non_empty():
    """EQ_ALLOWED_PATHS must be a non-empty frozenset."""
    assert isinstance(EQ_ALLOWED_PATHS, frozenset)
    assert len(EQ_ALLOWED_PATHS) >= 7


def test_validate_knob_path_config_model():
    """config.model is allowed."""
    validate_knob_path("config.model")  # must not raise


def test_validate_knob_path_config_max_concurrency():
    validate_knob_path("config.max_concurrency")


def test_validate_knob_path_config_max_depth():
    validate_knob_path("config.max_depth")


def test_validate_knob_path_tasks_wildcard_assigned_model():
    """tasks[*].assigned_model is allowed."""
    validate_knob_path("tasks[*].assigned_model")


def test_validate_knob_path_tasks_index_complexity():
    """tasks[3].complexity (concrete index) is allowed."""
    validate_knob_path("tasks[3].complexity")


def test_validate_knob_path_tasks_index_deterministic():
    validate_knob_path("tasks[0].deterministic")


def test_validate_knob_path_tasks_index_estimated_tokens():
    validate_knob_path("tasks[7].estimated_tokens")


def test_validate_knob_path_rejects_arbitrary_config():
    """config.unknown_field must be rejected."""
    with pytest.raises(EqPathNotAllowed):
        validate_knob_path("config.unknown_field")


def test_validate_knob_path_rejects_root_field():
    """Top-level manifest fields (not under config) must be rejected."""
    with pytest.raises(EqPathNotAllowed):
        validate_knob_path("name")


def test_validate_knob_path_rejects_tasks_bad_field():
    """tasks[*].description is not in the per-task allow-list."""
    with pytest.raises(EqPathNotAllowed):
        validate_knob_path("tasks[*].description")


def test_validate_knob_path_rejects_path_traversal():
    """Paths with .. must be rejected."""
    with pytest.raises(EqPathNotAllowed):
        validate_knob_path("config/../secret")


# ---------------------------------------------------------------------------
# AAMP-F9: eq write signs manifest
# ---------------------------------------------------------------------------


def test_aamp_f9_eq_write_signs_manifest(tmp_path):
    """apply_eq_write() produces a result with a non-null new_signature (AAMP-F9)."""
    result = _apply(
        [EqKnob(path="config.model", value="claude-3-5-sonnet")],
        tmp_path=tmp_path,
    )
    assert result.new_signature
    assert result.new_signature.get("algorithm") == "HMAC-SHA256"
    assert result.new_signature.get("value")
    assert result.new_signature.get("signed_at")


def test_aamp_f9_signature_embedded_in_updated_manifest(tmp_path):
    """The updated_manifest dict contains the new signature (AAMP-F9)."""
    result = _apply(
        [EqKnob(path="config.model", value="claude-3-5-sonnet")],
        tmp_path=tmp_path,
    )
    assert result.updated_manifest.get("signature") == result.new_signature


def test_aamp_f9_knob_value_applied_to_manifest(tmp_path):
    """The knob value is actually written into config (AAMP-F9)."""
    result = _apply(
        [EqKnob(path="config.model", value="claude-3-opus")],
        tmp_path=tmp_path,
    )
    assert result.updated_manifest["config"]["model"] == "claude-3-opus"


def test_aamp_f9_multiple_knobs_applied(tmp_path):
    """Multiple knobs in one write are all applied (AAMP-F9)."""
    result = _apply(
        [
            EqKnob(path="config.model", value="claude-3-5-haiku"),
            EqKnob(path="config.max_concurrency", value=4),
            EqKnob(path="config.max_depth", value=5),
        ],
        tmp_path=tmp_path,
    )
    cfg = result.updated_manifest["config"]
    assert cfg["model"] == "claude-3-5-haiku"
    assert cfg["max_concurrency"] == 4
    assert cfg["max_depth"] == 5


def test_aamp_f9_invalid_path_raises_before_write(tmp_path):
    """EqPathNotAllowed is raised before any ledger write (AAMP-F9)."""
    ledger_dir = tmp_path / "ledger"
    with pytest.raises(EqPathNotAllowed):
        apply_eq_write(
            _make_manifest(),
            [EqKnob(path="config.bad_field", value=1)],
            workspace="ws",
            benny_home=tmp_path,
            policy_evaluator=_permissive_evaluator(),
            ledger_dir=ledger_dir,
            ledger_secret=_LEDGER_SECRET,
        )
    # Ledger must still be empty — no write happened
    assert not (ledger_dir / "ledger.jsonl").exists()


def test_aamp_f9_original_manifest_not_mutated(tmp_path):
    """apply_eq_write() does not mutate the input dict (AAMP-F9)."""
    original = _make_manifest(model="original-model")
    _apply(
        [EqKnob(path="config.model", value="new-model")],
        manifest=original,
        tmp_path=tmp_path,
    )
    assert original["config"]["model"] == "original-model"


# ---------------------------------------------------------------------------
# AAMP-F10: per-task picker + knob lock
# ---------------------------------------------------------------------------


def test_aamp_f10_per_task_picker(tmp_path):
    """tasks[*].complexity with task_ids only updates the selected task (AAMP-F10)."""
    result = _apply(
        [EqKnob(path="tasks[*].complexity", value="high")],
        tmp_path=tmp_path,
        task_ids=["t1"],
    )
    tasks = result.updated_manifest["plan"]["tasks"]
    t1 = next(t for t in tasks if t["id"] == "t1")
    t2 = next(t for t in tasks if t["id"] == "t2")
    assert t1["complexity"] == "high"
    assert t2["complexity"] == "low"   # unchanged


def test_aamp_f10_wildcard_without_task_ids_updates_all(tmp_path):
    """tasks[*].complexity without task_ids updates all tasks (AAMP-F10)."""
    result = _apply(
        [EqKnob(path="tasks[*].complexity", value="high")],
        tmp_path=tmp_path,
        task_ids=None,
    )
    tasks = result.updated_manifest["plan"]["tasks"]
    for task in tasks:
        assert task["complexity"] == "high"


def test_aamp_f10_knob_lock_persists(tmp_path):
    """A locked knob writes its lock state to eq.json (AAMP-F10)."""
    _apply(
        [EqKnob(path="config.max_concurrency", value=3, locked=True)],
        tmp_path=tmp_path,
    )
    eq_json = tmp_path / "agentamp" / "user" / "eq.json"
    assert eq_json.exists(), "eq.json was not created"
    lock = EqLock.model_validate_json(eq_json.read_text(encoding="utf-8"))
    assert lock.locks.get("config.max_concurrency") is True


def test_aamp_f10_unlocked_knob_not_in_eq_json(tmp_path):
    """An unlocked knob does NOT write to eq.json (AAMP-F10)."""
    _apply(
        [EqKnob(path="config.max_concurrency", value=2, locked=False)],
        tmp_path=tmp_path,
    )
    eq_json = tmp_path / "agentamp" / "user" / "eq.json"
    # File may or may not exist; if it does, the path must not be present
    if eq_json.exists():
        lock = EqLock.model_validate_json(eq_json.read_text(encoding="utf-8"))
        assert "config.max_concurrency" not in lock.locks


def test_aamp_f10_lock_accumulates_across_writes(tmp_path):
    """Multiple writes accumulate locked paths in eq.json (AAMP-F10)."""
    _apply(
        [EqKnob(path="config.model", value="m1", locked=True)],
        tmp_path=tmp_path,
    )
    _apply(
        [EqKnob(path="config.max_depth", value=5, locked=True)],
        tmp_path=tmp_path,
    )
    eq_json = tmp_path / "agentamp" / "user" / "eq.json"
    lock = EqLock.model_validate_json(eq_json.read_text(encoding="utf-8"))
    assert lock.locks.get("config.model") is True
    assert lock.locks.get("config.max_depth") is True


# ---------------------------------------------------------------------------
# AAMP-SEC5: policy evaluation
# ---------------------------------------------------------------------------


def test_aamp_sec5_eq_write_policy_evaluated(tmp_path):
    """apply_eq_write() calls policy.evaluate; a denial raises PolicyDeniedError (AAMP-SEC5)."""
    # Build an evaluator that denies the eq_write tool for this persona
    deny_evaluator = PolicyEvaluator(
        mode="enforce",
        auto_approve_writes=False,
        allowed_tools_per_persona={"aamp:user": []},  # empty allowlist → deny
    )
    with pytest.raises(PolicyDeniedError):
        apply_eq_write(
            _make_manifest(),
            [EqKnob(path="config.model", value="x")],
            workspace="ws",
            benny_home=tmp_path,
            policy_evaluator=deny_evaluator,
            ledger_dir=tmp_path / "ledger",
            ledger_secret=_LEDGER_SECRET,
        )


def test_aamp_sec5_policy_denial_no_ledger_entry(tmp_path):
    """A policy denial must not produce a ledger entry (AAMP-SEC5)."""
    ledger_dir = tmp_path / "ledger"
    deny_evaluator = PolicyEvaluator(
        mode="enforce",
        auto_approve_writes=False,
        allowed_tools_per_persona={"aamp:user": []},
    )
    with pytest.raises(PolicyDeniedError):
        apply_eq_write(
            _make_manifest(),
            [EqKnob(path="config.model", value="x")],
            workspace="ws",
            benny_home=tmp_path,
            policy_evaluator=deny_evaluator,
            ledger_dir=ledger_dir,
            ledger_secret=_LEDGER_SECRET,
        )
    assert not (ledger_dir / "ledger.jsonl").exists()


def test_aamp_sec5_approved_write_succeeds(tmp_path):
    """An approved policy write completes without error (AAMP-SEC5)."""
    result = _apply(
        [EqKnob(path="config.model", value="approved-model")],
        tmp_path=tmp_path,
        evaluator=_permissive_evaluator(),
    )
    assert result.updated_manifest["config"]["model"] == "approved-model"


# ---------------------------------------------------------------------------
# AAMP-COMP1: ledger entry on eq write
# ---------------------------------------------------------------------------


def test_aamp_comp1_eq_write_ledger_entry(tmp_path):
    """apply_eq_write() appends a ledger entry (AAMP-COMP1)."""
    ledger_dir = tmp_path / "ledger"
    result = apply_eq_write(
        _make_manifest(),
        [EqKnob(path="config.model", value="ledger-test")],
        workspace="ws",
        benny_home=tmp_path,
        policy_evaluator=_permissive_evaluator(),
        ledger_dir=ledger_dir,
        ledger_secret=_LEDGER_SECRET,
    )
    assert result.ledger_seq >= 1
    assert (ledger_dir / "ledger.jsonl").exists()


def test_aamp_comp1_ledger_seq_increments(tmp_path):
    """Sequential writes produce incrementing ledger sequence numbers (AAMP-COMP1)."""
    ledger_dir = tmp_path / "ledger"
    kwargs = dict(
        workspace="ws",
        benny_home=tmp_path,
        policy_evaluator=_permissive_evaluator(),
        ledger_dir=ledger_dir,
        ledger_secret=_LEDGER_SECRET,
    )
    r1 = apply_eq_write(_make_manifest(), [EqKnob(path="config.model", value="m1")], **kwargs)
    r2 = apply_eq_write(_make_manifest(), [EqKnob(path="config.model", value="m2")], **kwargs)
    assert r2.ledger_seq == r1.ledger_seq + 1


def test_aamp_comp1_ledger_chain_valid(tmp_path):
    """The HMAC chain in the ledger is intact after multiple writes (AAMP-COMP1)."""
    ledger_dir = tmp_path / "ledger"
    kwargs = dict(
        workspace="ws",
        benny_home=tmp_path,
        policy_evaluator=_permissive_evaluator(),
        ledger_dir=ledger_dir,
        ledger_secret=_LEDGER_SECRET,
    )
    for val in ("m1", "m2", "m3"):
        apply_eq_write(_make_manifest(), [EqKnob(path="config.model", value=val)], **kwargs)

    assert verify_chain(ledger_dir=ledger_dir, secret=_LEDGER_SECRET)


def test_aamp_comp1_ledger_entry_persona(tmp_path):
    """The ledger entry records the correct persona (AAMP-COMP1)."""
    ledger_dir = tmp_path / "ledger"
    apply_eq_write(
        _make_manifest(),
        [EqKnob(path="config.model", value="test")],
        workspace="ws",
        benny_home=tmp_path,
        policy_evaluator=_permissive_evaluator(),
        ledger_dir=ledger_dir,
        ledger_secret=_LEDGER_SECRET,
        persona="aamp:user",
    )
    lines = (ledger_dir / "ledger.jsonl").read_text(encoding="utf-8").splitlines()
    record = json.loads(lines[-1])
    assert record["persona"] == "aamp:user"


# ---------------------------------------------------------------------------
# AAMP-COMP2: previous signatures preserved
# ---------------------------------------------------------------------------


def test_aamp_comp2_previous_signatures_preserved(tmp_path):
    """When the manifest has a signature, it is moved to previous_signatures (AAMP-COMP2)."""
    old_sig = {
        "algorithm": "HMAC-SHA256",
        "value": "aabbcc" * 10,
        "signed_at": "2026-01-01T00:00:00+00:00",
    }
    manifest = _make_manifest(signature=old_sig)
    result = _apply(
        [EqKnob(path="config.model", value="new-model")],
        manifest=manifest,
        tmp_path=tmp_path,
    )
    assert len(result.previous_signatures) == 1
    assert result.previous_signatures[0]["value"] == old_sig["value"]


def test_aamp_comp2_no_previous_sig_when_draft(tmp_path):
    """A draft manifest (signature=None) produces an empty previous_signatures list (AAMP-COMP2)."""
    manifest = _make_manifest(signature=None)
    result = _apply(
        [EqKnob(path="config.model", value="x")],
        manifest=manifest,
        tmp_path=tmp_path,
    )
    assert result.previous_signatures == []


def test_aamp_comp2_new_signature_differs_from_previous(tmp_path):
    """After an eq write the new signature is different from the old one (AAMP-COMP2)."""
    old_sig = {
        "algorithm": "HMAC-SHA256",
        "value": "old" * 20,
        "signed_at": "2026-01-01T00:00:00+00:00",
    }
    manifest = _make_manifest(signature=old_sig)
    result = _apply(
        [EqKnob(path="config.model", value="changed")],
        manifest=manifest,
        tmp_path=tmp_path,
    )
    assert result.new_signature["value"] != old_sig["value"]


# ---------------------------------------------------------------------------
# EqManifest model
# ---------------------------------------------------------------------------


def test_eq_manifest_round_trip():
    """EqManifest serialises and deserialises correctly."""
    em = EqManifest(
        skin_id="dark-neon",
        knobs=[
            EqKnob(path="config.model", value="claude-3-5-sonnet", locked=True),
            EqKnob(path="config.max_concurrency", value=2),
        ],
    )
    raw = em.model_dump_json()
    em2 = EqManifest.model_validate_json(raw)
    assert len(em2.knobs) == 2
    assert em2.knobs[0].locked is True
    assert em2.knobs[1].path == "config.max_concurrency"


def test_eq_manifest_default_schema_version():
    """EqManifest.schema_version defaults to '1.0'."""
    em = EqManifest()
    assert em.schema_version == "1.0"


# ---------------------------------------------------------------------------
# EqLock model
# ---------------------------------------------------------------------------


def test_eq_lock_empty_by_default():
    """EqLock.locks is empty dict by default."""
    lock = EqLock()
    assert lock.locks == {}


def test_eq_lock_round_trip(tmp_path):
    """EqLock persists and loads correctly."""
    p = tmp_path / "eq.json"
    lock = EqLock(locks={"config.model": True, "config.max_depth": False})
    p.write_text(lock.model_dump_json(), encoding="utf-8")
    loaded = EqLock.model_validate_json(p.read_text(encoding="utf-8"))
    assert loaded.locks["config.model"] is True
    assert loaded.locks["config.max_depth"] is False
