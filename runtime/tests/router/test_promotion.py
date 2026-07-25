"""L12 router unit tests — the served model changes ONLY by human signature, and is reversible.
Scenarios ↔ delivery/tasks/L12.md gherkin. No network, no served endpoint; a temp pointer file.
"""

import json

import pytest

from benny.router import promotion as pr
from benny.router import tuned_engine as te


def _pointer(tmp_path):
    return str(tmp_path / "served_pointer.json")


def test_unsigned_promotion_is_refused_served_unchanged(tmp_path):
    """Scenario: an unsigned promotion is refused."""
    p = _pointer(tmp_path)
    # seed a served model, signed.
    pr.promote(p, "house/model-a", human_signature="owner-sig-1")
    before = pr.read_served(p)

    # a candidate that passes its gate but carries NO signature.
    res = pr.promote(p, "house/model-b", human_signature=None, decision_vector={"eval_nll": 0.9})
    assert res["ok"] is False
    assert "unsigned" in res["reason"]
    # the served position is unchanged.
    assert pr.read_served(p)["served"] == "house/model-a"
    assert pr.read_served(p) == before


def test_signed_promotion_swaps_and_records_predecessor(tmp_path):
    """Scenario: a signed promotion swaps the served model."""
    p = _pointer(tmp_path)
    pr.promote(p, "house/model-a", human_signature="owner-sig-1")
    res = pr.promote(p, "house/model-b", human_signature="owner-sig-2",
                     decision_vector={"eval_nll": 0.88}, decision_rule="dominates-or-pareto-with-eval-anchor")
    assert res["ok"] is True
    served = pr.read_served(p)
    assert served["served"] == "house/model-b"        # names the new model
    assert served["replaces"] == "house/model-a"       # records the one it replaced
    assert served["rollback_to"] == "house/model-a"    # and how to revert
    assert served["human_signature"] == "owner-sig-2"
    assert served["type"] == "model_promotion"         # §5.5 record shape


def test_rollback_restores_the_exact_predecessor(tmp_path):
    """Scenario: rollback restores the predecessor."""
    p = _pointer(tmp_path)
    pr.promote(p, "house/model-a", human_signature="owner-sig-1")
    pr.promote(p, "house/model-b", human_signature="owner-sig-2")
    assert pr.read_served(p)["served"] == "house/model-b"

    res = pr.rollback(p, human_signature="owner-rollback-sig")
    assert res["ok"] is True
    assert pr.read_served(p)["served"] == "house/model-a"  # exact prior served model restored


def test_passing_number_alone_never_auto_swaps(tmp_path):
    """Scenario: a passing number alone never auto-swaps."""
    p = _pointer(tmp_path)
    pr.promote(p, "house/model-a", human_signature="owner-sig-1")
    # a candidate that DOMINATES on metrics but is unsigned — the loop must not swap on the number.
    dominating = {"eval_nll": 0.50, "agent_pass": 0.99, "cost_per_task": 0.0, "latency_ms": 900}
    res = pr.promote(p, "house/model-super", human_signature=None, decision_vector=dominating)
    assert res["ok"] is False
    assert pr.read_served(p)["served"] == "house/model-a"  # served model not changed


def test_rollback_also_requires_a_signature(tmp_path):
    """A served-position change is a served-position change: reverting is human-signed too."""
    p = _pointer(tmp_path)
    pr.promote(p, "house/model-a", human_signature="owner-sig-1")
    pr.promote(p, "house/model-b", human_signature="owner-sig-2")
    res = pr.rollback(p, human_signature=None)
    assert res["ok"] is False
    assert pr.read_served(p)["served"] == "house/model-b"  # unchanged


def test_served_engine_id_is_additive_default_unchanged(tmp_path):
    """With no promotion pointer, the router's served id is the default — additive (R36)."""
    missing = str(tmp_path / "none.json")
    assert te.served_engine_id(pointer_path=missing, default="qwen3_5_9b") == "qwen3_5_9b"
    # once a signed promotion exists, the served id reflects it.
    p = _pointer(tmp_path)
    pr.promote(p, "house/model-a", human_signature="owner-sig-1")
    assert te.served_engine_id(pointer_path=p, default="qwen3_5_9b") == "house/model-a"


def test_pointer_is_valid_json_promotion_record(tmp_path):
    p = _pointer(tmp_path)
    pr.promote(p, "house/model-a", human_signature="owner-sig-1",
               decision_vector={"eval_nll": 1.12}, decision_rule="dominates-or-pareto-with-eval-anchor")
    with open(p, encoding="utf-8") as fh:
        rec = json.load(fh)
    for field in ("type", "served", "human_signature", "valid_time", "txn_time", "schema_version"):
        assert field in rec
