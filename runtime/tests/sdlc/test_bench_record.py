"""P2 — one record, two blocks, no composite.

Red tests. They fail until `benny/sdlc/bench_record.py` exists.

`pypes model-bench` scores manifest AUTHORING; `run_multi_model` scores agentic NAVIGATION. Two
scales with no comparability between them. P2 lands both on one record — and refuses to invent the
number that would make them look comparable.

The refusal is the deliverable. A weighted composite invented at design time is an unfrozen rubric
wearing a number: it looks like a measurement, it ranks subjects, and nobody ever agreed to the
weights. Ranking here names one metric, in one block, declared up front.

Scenarios ↔ delivery/tasks/P2.md gherkin.
"""

from __future__ import annotations

import pytest

from benny.sdlc.bench_record import (
    AUTHORING_KEYS,
    BENCH_RECORD_KIND,
    NAVIGATION_KEYS,
    RECORD_KEYS,
    authoring_block,
    build_record,
    navigation_block,
    rank_records,
    validate_record,
)
from benny.sdlc.sandbox_runner import METRIC_FIELDS, SandboxResult

# A model_compare trial as `_trial_to_dict` emits it — a plain dict, so these tests need no
# pydantic (the ambient interpreter has none, and model_compare is a pydantic module).
TRIAL = {
    "model": "house/qwen2.5-coder-tuned",
    "label": "incumbent",
    "wall_seconds": 12.5,
    "total_tokens": 4210,
    "cost_usd": 0.0,
    "status": "OK",
    "auto_scores": {
        "has_required_ops": 0.8,
        "step_count": 6,
        "parse_ok": 1.0,
    },
    "quality_score": 7.5,
}


def _nav(**kw):
    return SandboxResult(model="incumbent", **kw)


# ---------------------------------------------------------------------------
# Scenario: both blocks are present
# ---------------------------------------------------------------------------


def test_a_record_carries_an_authoring_block_and_a_navigation_block():
    rec = build_record(
        "incumbent",
        authoring=authoring_block(TRIAL),
        navigation=navigation_block(_nav(tool_selection_accuracy=0.9)),
        rubric_hash="fnv1a:deadbeef",
        primary_metric="navigation.tool_selection_accuracy",
    )
    assert rec["kind"] == BENCH_RECORD_KIND
    assert rec["subject"] == "incumbent"
    assert "authoring" in rec and "navigation" in rec
    assert rec["authoring"]["has_required_ops"] == 0.8
    assert rec["navigation"]["tool_selection_accuracy"] == 0.9
    ok, errors = validate_record(rec)
    assert ok, errors


def test_a_record_missing_either_block_is_rejected():
    """TDD 1. A record with one block is a single scale wearing a record's clothes."""
    full = build_record(
        "s",
        authoring=authoring_block(TRIAL),
        navigation=navigation_block(_nav()),
        rubric_hash="h",
        primary_metric="authoring.has_required_ops",
    )
    for missing in ("authoring", "navigation"):
        partial = {k: v for k, v in full.items() if k != missing}
        ok, errors = validate_record(partial)
        assert not ok
        assert any(missing in e for e in errors), errors


def test_a_block_may_be_explicitly_not_scored_but_not_silently_absent():
    """A subject scored on only one surface must SAY so, rather than omitting the block —
    absence is ambiguous between 'not run' and 'lost'."""
    rec = build_record(
        "s",
        authoring=None,
        navigation=navigation_block(_nav(tool_efficiency=0.5)),
        rubric_hash="h",
        primary_metric="navigation.tool_efficiency",
    )
    assert rec["authoring"] is None
    assert rec["scored_on"] == ["navigation"]
    ok, errors = validate_record(rec)
    assert ok, errors


# ---------------------------------------------------------------------------
# TDD 3 / the refusal: no composite, no weighted blend
# ---------------------------------------------------------------------------


def test_every_emitted_key_is_one_the_schema_declares():
    """The previous version of this test asserted the record against the denylist itself, so it
    could only ever catch names already on the list. This asserts against the SCHEMA."""
    rec = build_record(
        "s",
        authoring=authoring_block(TRIAL),
        navigation=navigation_block(_nav(tool_selection_accuracy=0.9)),
        rubric_hash="h",
        primary_metric="navigation.tool_selection_accuracy",
    )
    assert set(rec) <= RECORD_KEYS, set(rec) - RECORD_KEYS
    assert set(rec["authoring"]) <= AUTHORING_KEYS, set(rec["authoring"]) - AUTHORING_KEYS
    assert set(rec["navigation"]) <= NAVIGATION_KEYS, set(rec["navigation"]) - NAVIGATION_KEYS


def test_the_names_that_walked_through_the_denylist_are_now_refused():
    """Every one of these was ACCEPTED by the seven-word denylist. `harmonic_mean` is the textbook
    way to combine two normalised scales; `model_rating` is the obvious name, not an exotic one."""
    rec = build_record(
        "s", authoring=authoring_block(TRIAL), navigation=navigation_block(_nav()),
        rubric_hash="h", primary_metric="authoring.has_required_ops",
    )
    for name in ("harmonic_mean", "merit_score", "model_rating", "rating", "index", "points",
                 "score", "grade", "rollup", "merit", "fitness", "unified_scale", "z_score"):
        ok, errors = validate_record({**rec, name: 0.86})
        assert not ok, f"{name} was accepted"
        assert any(name in e for e in errors), errors


def test_a_composite_inside_a_tuple_is_refused():
    """_forbidden_keys recursed into lists but not tuples, and validation runs before any JSON
    round-trip could normalise one away."""
    rec = build_record(
        "s", authoring=authoring_block(TRIAL), navigation=navigation_block(_nav()),
        rubric_hash="h", primary_metric="authoring.has_required_ops",
    )
    ok, errors = validate_record({**rec, "roster_hash": ({"harmonic_mean": 0.9},)})
    assert not ok, errors


def test_a_record_carrying_a_composite_is_rejected_by_the_validator():
    rec = build_record(
        "s",
        authoring=authoring_block(TRIAL),
        navigation=navigation_block(_nav()),
        rubric_hash="h",
        primary_metric="authoring.has_required_ops",
    )
    for bad in ("composite_score", "weighted_total", "overall_score", "combined"):
        poisoned = {**rec, bad: 0.86}
        ok, errors = validate_record(poisoned)
        assert not ok, f"{bad} was accepted"
        assert any(bad in e for e in errors), errors


def test_a_composite_hidden_inside_a_block_is_also_rejected():
    rec = build_record(
        "s",
        authoring={**authoring_block(TRIAL), "weighted_mean": 0.7},
        navigation=navigation_block(_nav()),
        rubric_hash="h",
        primary_metric="authoring.has_required_ops",
    )
    ok, errors = validate_record(rec)
    assert not ok
    assert any("weighted_mean" in e for e in errors), errors


# ---------------------------------------------------------------------------
# The primary metric is declared, and must exist
# ---------------------------------------------------------------------------


def test_the_primary_metric_must_name_a_block_and_a_field_that_exist():
    for bad in ("tool_efficiency", "navigation.vibes", "nosuchblock.x", "navigation."):
        with pytest.raises(ValueError):
            build_record(
                "s",
                authoring=authoring_block(TRIAL),
                navigation=navigation_block(_nav(tool_efficiency=0.5)),
                rubric_hash="h",
                primary_metric=bad,
            )


def test_ranking_uses_the_declared_metric_and_excludes_unmeasured():
    recs = [
        build_record("a", authoring=authoring_block(TRIAL),
                     navigation=navigation_block(_nav(tool_selection_accuracy=0.7)),
                     rubric_hash="h", primary_metric="navigation.tool_selection_accuracy"),
        build_record("b", authoring=authoring_block(TRIAL),
                     navigation=navigation_block(_nav(tool_selection_accuracy=0.9)),
                     rubric_hash="h", primary_metric="navigation.tool_selection_accuracy"),
        build_record("unmeasured", authoring=authoring_block(TRIAL),
                     navigation=navigation_block(_nav()),
                     rubric_hash="h", primary_metric="navigation.tool_selection_accuracy"),
    ]
    out = rank_records(recs)
    assert [r["subject"] for r in out["ranked"]] == ["b", "a"]
    assert dict(out["excluded"])["unmeasured"] == "unmeasured"
    assert out["primary_metric"] == "navigation.tool_selection_accuracy"


def test_ranking_refuses_records_that_declare_different_primary_metrics():
    """Ranking a mixed pile against one metric is the composite problem in disguise."""
    recs = [
        build_record("a", authoring=authoring_block(TRIAL), navigation=navigation_block(_nav(tool_efficiency=0.5)),
                     rubric_hash="h", primary_metric="navigation.tool_efficiency"),
        build_record("b", authoring=authoring_block(TRIAL), navigation=navigation_block(_nav(tool_selection_accuracy=0.9)),
                     rubric_hash="h", primary_metric="navigation.tool_selection_accuracy"),
    ]
    with pytest.raises(ValueError):
        rank_records(recs)


def test_ranking_refuses_records_whose_rubric_hashes_differ():
    """A post-hoc rubric edit must invalidate comparison by hash mismatch (R10)."""
    recs = [
        build_record("a", authoring=authoring_block(TRIAL), navigation=navigation_block(_nav(tool_efficiency=0.5)),
                     rubric_hash="fnv1a:aaaa", primary_metric="navigation.tool_efficiency"),
        build_record("b", authoring=authoring_block(TRIAL), navigation=navigation_block(_nav(tool_efficiency=0.6)),
                     rubric_hash="fnv1a:bbbb", primary_metric="navigation.tool_efficiency"),
    ]
    with pytest.raises(ValueError) as exc:
        rank_records(recs)
    assert "rubric" in str(exc.value).lower()


# ---------------------------------------------------------------------------
# P1's guarantee must survive the trip onto the record
# ---------------------------------------------------------------------------


def test_unmeasured_navigation_metrics_stay_none_on_the_record():
    """The whole of P1 is that unmeasured is not zero. Serialising must not quietly fix that."""
    block = navigation_block(_nav(iteration_latency_ms_p95=340.0))
    for field in METRIC_FIELDS:
        if field != "iteration_latency_ms_p95":
            assert block[field] is None, f"{field} became {block[field]!r} on the record"
    assert block["unmeasured"] == sorted(f for f in METRIC_FIELDS if f != "iteration_latency_ms_p95")


def test_a_genuine_zero_survives_as_a_zero():
    """The converse error, which cost P6 a finding: 0.0 must not become unmeasured."""
    block = navigation_block(_nav(total_cost=0.0, total_tokens=0, tool_efficiency=0.0))
    assert block["total_cost"] == 0.0
    assert block["total_tokens"] == 0
    assert block["tool_efficiency"] == 0.0
    assert "total_cost" not in block["unmeasured"]


def test_an_unavailable_subject_carries_its_reason_onto_the_record():
    block = navigation_block(
        SandboxResult(model="down", status="unavailable", unavailable_reason="endpoint refused")
    )
    assert block["status"] == "unavailable"
    assert block["unavailable_reason"] == "endpoint refused"


def test_an_unavailable_subject_is_excluded_from_ranking():
    recs = [
        build_record("ok", authoring=authoring_block(TRIAL), navigation=navigation_block(_nav(tool_efficiency=0.4)),
                     rubric_hash="h", primary_metric="navigation.tool_efficiency"),
        build_record("down", authoring=authoring_block(TRIAL),
                     navigation=navigation_block(SandboxResult(model="down", status="unavailable",
                                                               unavailable_reason="endpoint refused")),
                     rubric_hash="h", primary_metric="navigation.tool_efficiency"),
    ]
    out = rank_records(recs)
    assert [r["subject"] for r in out["ranked"]] == ["ok"]
    assert dict(out["excluded"])["down"] == "unavailable"


# ---------------------------------------------------------------------------
# The authoring block: a projection of model_compare's trial dict, not a rewrite
# ---------------------------------------------------------------------------


def test_the_authoring_block_projects_the_trial_without_inventing_fields():
    block = authoring_block(TRIAL)
    assert block["has_required_ops"] == 0.8
    assert block["step_count"] == 6
    assert block["wall_seconds"] == 12.5
    assert block["total_tokens"] == 4210
    assert block["quality_score"] == 7.5
    # Nothing that was not in the trial appears in the block, apart from the source marker and the
    # unmeasured list — and that list is exactly the schema, so it cannot smuggle a field in.
    assert set(block) <= AUTHORING_KEYS
    assert block["unmeasured"] == [], "every field in this trial was present"


def test_a_trial_missing_a_score_yields_none_not_zero():
    thin = {"model": "m", "status": "OK", "auto_scores": {}}
    block = authoring_block(thin)
    assert block["has_required_ops"] is None
    assert block["quality_score"] is None


# ---------------------------------------------------------------------------
# Defects found by claude-p2-verifier (LOG 2026-08-04T17:30Z) — regression tests
# ---------------------------------------------------------------------------


def test_records_declaring_no_rubric_hash_at_all_cannot_rank():
    """`{None}` is a set of size one, so the "same rubric hash" guard passed happily for records
    that declared NO instrument — R10 satisfied vacuously by the absence of a rubric."""
    recs = [
        build_record("a", authoring=None, navigation=navigation_block(_nav(tool_efficiency=0.5)),
                     rubric_hash="h", primary_metric="navigation.tool_efficiency"),
        build_record("b", authoring=None, navigation=navigation_block(_nav(tool_efficiency=0.6)),
                     rubric_hash="h", primary_metric="navigation.tool_efficiency"),
    ]
    for r in recs:
        r["rubric_hash"] = None
    with pytest.raises(ValueError) as exc:
        rank_records(recs)
    assert "rubric" in str(exc.value).lower()


def test_availability_is_judged_on_the_block_being_ranked():
    """Ranking by an AUTHORING metric must not drop a subject because its NAVIGATION sandbox was
    down — the exclusion was hardwired to navigation regardless of what was being ranked."""
    down_nav = navigation_block(
        SandboxResult(model="a", status="unavailable", unavailable_reason="endpoint refused")
    )
    recs = [
        build_record("a", authoring=authoring_block(TRIAL), navigation=down_nav,
                     rubric_hash="h", primary_metric="authoring.has_required_ops"),
        build_record("b", authoring=authoring_block({**TRIAL, "auto_scores": {"has_required_ops": 0.2}}),
                     navigation=navigation_block(_nav()),
                     rubric_hash="h", primary_metric="authoring.has_required_ops"),
    ]
    out = rank_records(recs)
    assert [r["subject"] for r in out["ranked"]] == ["a", "b"], out["excluded"]
    assert out["excluded"] == []


def test_a_block_lying_about_its_own_unmeasured_list_is_refused():
    """The record's central invariant, previously assumed rather than checked: a block could claim
    everything was measured while carrying nulls, and validate."""
    rec = build_record("s", authoring=authoring_block(TRIAL),
                       navigation=navigation_block(_nav(tool_efficiency=0.5)),
                       rubric_hash="h", primary_metric="navigation.tool_efficiency")
    understated = {**rec["navigation"], "unmeasured": []}
    ok, errors = validate_record({**rec, "navigation": understated})
    assert not ok and any("unmeasured" in e for e in errors), errors

    overstated = {**rec["navigation"], "unmeasured": sorted(METRIC_FIELDS)}
    ok, errors = validate_record({**rec, "navigation": overstated})
    assert not ok and any("unmeasured" in e for e in errors), errors


def test_the_authoring_block_carries_its_own_unmeasured_list():
    """The record was asymmetric on its central invariant — navigation carried the list, authoring
    did not, so `has_required_ops=0.0` and `parse_ok=None` were distinguishable only by a
    null-check, the very inference the list exists to make unnecessary."""
    thin = authoring_block({"model": "m", "status": "OK", "auto_scores": {}})
    assert "quality_score" in thin["unmeasured"]
    assert "has_required_ops" in thin["unmeasured"]
    scored = authoring_block({**TRIAL, "auto_scores": {**TRIAL["auto_scores"], "has_required_ops": 0.0}})
    assert "has_required_ops" not in scored["unmeasured"], "a genuine zero is measured"


def test_ranking_a_non_numeric_metric_is_a_named_refusal_not_a_bare_TypeError():
    recs = [build_record("a", authoring=None, navigation=navigation_block(_nav()),
                         rubric_hash="h", primary_metric="navigation.tool_efficiency")]
    recs[0]["navigation"]["tool_efficiency"] = "high"
    with pytest.raises(ValueError) as exc:
        rank_records(recs)
    assert "cannot be ranked" in str(exc.value)


def test_records_with_no_primary_metric_are_a_named_refusal():
    recs = [build_record("a", authoring=None, navigation=navigation_block(_nav(tool_efficiency=0.5)),
                         rubric_hash="h", primary_metric="navigation.tool_efficiency")]
    recs[0]["primary_metric"] = None
    with pytest.raises(ValueError) as exc:
        rank_records(recs)
    assert "nothing to rank" in str(exc.value)
