"""P2 — one record, two blocks, and a refusal.

`pypes model-bench` scores manifest AUTHORING: did the model produce a plan containing the required
operations, in how many steps, at what cost. `run_multi_model` scores agentic NAVIGATION: how well
the model drove the SDLC loop. Both are real measurements of the same subject and neither is
convertible into the other.

This module lands them on one record with two blocks. What it deliberately does NOT do is combine
them.

    A weighted composite invented at design time is an unfrozen rubric wearing a number.

It would look like a measurement, it would rank subjects, and nobody would ever have agreed to the
weights — and once a composite exists, it is the number people quote. So the composite is not merely
omitted: `validate_record` REFUSES a record carrying one, at any depth, and `rank_records` demands
that every record it ranks declares the same single primary metric and the same rubric hash. A pile
of records ranked against one metric they did not all declare is the composite problem in disguise.

Placement note: this lives in `benny.sdlc` rather than `benny.pypes` because `benny/pypes/__init__.py`
eagerly imports pydantic-backed models — so importing anything from that package drags pydantic in,
which the estate's ambient interpreter does not have. `benny/sdlc/__init__.py` is a bare docstring.
(That `pypes` describes itself as "intentionally import-cheap" while doing this is a real defect, but
it is not P2's to fix.)

Requirements: R1 (one measurement path), R10 (frozen rubric by hash), R21 (additive).
Design: architecture/SOLUTION-model-plurality.md §4.3, decision D3. Contract: delivery/tasks/P2.md
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional, Tuple

from .sandbox_runner import METRIC_FIELDS, SandboxResult

BENCH_RECORD_KIND = "bench_record/1"

#: The authoring fields projected from a model_compare trial. A projection, not a rewrite — this
#: module never recomputes a score that `model_compare` already produced.
_AUTHORING_SCORES = ("has_required_ops", "step_count", "parse_ok")
_AUTHORING_TOP = ("wall_seconds", "total_tokens", "cost_usd", "quality_score", "status", "model")

# --- The refusal, as an ALLOWLIST -------------------------------------------
# The first version of this was a denylist of seven stems: composite|weighted|overall|... Its own
# verifier walked `harmonic_mean` straight through it — the textbook way to combine two normalised
# scales — along with `merit_score`, `rating`, `fitness` and `index`. Worse, the test asserted the
# emitted record against that same pattern, so it could only ever catch names already on the list.
#
# A denylist requires guessing every name a composite might wear. An allowlist requires only knowing
# the schema, which this module already does. An unrecognised key is now the violation, so a blend
# cannot arrive under a name nobody thought to ban.
AUTHORING_KEYS = frozenset({"source", "unmeasured", *_AUTHORING_SCORES, *_AUTHORING_TOP})
NAVIGATION_KEYS = frozenset(
    {"source", "status", "unavailable_reason", "run_id", "unmeasured", *METRIC_FIELDS}
)
#: Serving topology. Validated against ITS OWN schema — it was previously scanned against
#: RECORD_KEYS, which is a category error: no real topology dict could be carried at all, so the
#: declared `topology` parameter was unusable.
TOPOLOGY_KEYS = frozenset({"endpoint", "quantisation", "context_length", "model_id"})
RECORD_KEYS = frozenset(
    {
        "kind", "subject", "authoring", "navigation", "scored_on",
        "rubric_hash", "roster_hash", "topology", "primary_metric",
    }
)


def authoring_block(trial: Dict[str, Any]) -> Dict[str, Any]:
    """Project one `model_compare` trial dict into the authoring block.

    Takes a plain dict — the shape `_trial_to_dict` already emits — so this is testable without
    pydantic and, more importantly, so `model_compare.py` needs no change at all (R21).

    A score the trial did not carry is ``None``, never ``0.0``. P1 established that distinction for
    the navigation side; it would be incoherent to abandon it here.
    """
    scores = trial.get("auto_scores") or {}
    block: Dict[str, Any] = {"source": "pypes.model-bench"}
    for key in _AUTHORING_SCORES:
        block[key] = scores.get(key)
    for key in _AUTHORING_TOP:
        block[key] = trial.get(key)
    # Carried here for the same reason the navigation block carries it: so a consumer that ignores
    # nulls cannot mistake the record for complete. Its absence made the record asymmetric on its
    # own central invariant — `has_required_ops=0.0` and `parse_ok=None` were distinguishable only
    # by the null-check this list exists to make unnecessary.
    block["unmeasured"] = sorted(k for k in _AUTHORING_SCORES + _AUTHORING_TOP if block[k] is None)
    return block


def navigation_block(result: SandboxResult) -> Dict[str, Any]:
    """Project a `SandboxResult` into the navigation block, preserving P1's distinction.

    `unmeasured` is carried explicitly alongside the fields rather than left to be inferred from
    nulls, so a consumer that ignores nulls still cannot mistake the record for complete.
    """
    block: Dict[str, Any] = {"source": "sdlc.run_multi_model"}
    for field in METRIC_FIELDS:
        block[field] = getattr(result, field)
    block["status"] = result.status
    block["unavailable_reason"] = result.unavailable_reason
    block["run_id"] = result.run_id
    block["unmeasured"] = sorted(result.unmeasured)
    return block


def _resolve_metric(record: Dict[str, Any], primary_metric: str) -> Any:
    """`block.field` -> the value, raising if the path does not exist on this record."""
    if not isinstance(primary_metric, str) or not primary_metric:
        raise ValueError("primary_metric must be a '<block>.<field>' string naming what to rank by")
    block_name, _, field = primary_metric.partition(".")
    if not block_name or not field:
        raise ValueError(
            f"primary_metric {primary_metric!r} must be '<block>.<field>' — naming the block is "
            "the point: the same field name can exist on both scales and mean different things"
        )
    if block_name not in ("authoring", "navigation"):
        raise ValueError(f"unknown block {block_name!r} in primary_metric {primary_metric!r}")
    block = record.get(block_name)
    if block is None:
        raise ValueError(f"primary_metric {primary_metric!r} names a block this record did not score")
    if field not in block:
        raise ValueError(f"primary_metric {primary_metric!r} names a field that block does not carry")
    return block[field]


def build_record(
    subject: str,
    *,
    authoring: Optional[Dict[str, Any]],
    navigation: Optional[Dict[str, Any]],
    rubric_hash: str,
    primary_metric: str,
    roster_hash: Optional[str] = None,
    topology: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build one bench record. Raises if `primary_metric` does not name a real field.

    `scored_on` states which surfaces actually ran. A block may be explicitly ``None`` — a subject
    scored on one surface only — but it may not be silently absent, because absence is ambiguous
    between "not run" and "lost on the way here".
    """
    record: Dict[str, Any] = {
        "kind": BENCH_RECORD_KIND,
        "subject": subject,
        "authoring": authoring,
        "navigation": navigation,
        "scored_on": [n for n, b in (("authoring", authoring), ("navigation", navigation)) if isinstance(b, dict)],
        "rubric_hash": rubric_hash,
        "roster_hash": roster_hash,
        "topology": topology,
        "primary_metric": primary_metric,
    }
    _resolve_metric(record, primary_metric)  # fail at build time, not at ranking time
    return record


def _unknown_keys(obj: Any, allowed: frozenset, prefix: str) -> List[str]:
    """Keys not in `allowed`, at every depth. Recurses through dicts, lists AND tuples — the
    previous version handled the first two, and a dict inside a tuple walked through."""
    found: List[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if key not in allowed:
                found.append(f"{prefix}{key}")
            found.extend(_unknown_keys(value, allowed, f"{prefix}{key}."))
    elif isinstance(obj, (list, tuple)):
        for i, value in enumerate(obj):
            found.extend(_unknown_keys(value, allowed, f"{prefix}{i}."))
    return found


def validate_record(record: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Fail-closed validation. Returns ``(ok, errors)``."""
    errors: List[str] = []
    if record.get("kind") != BENCH_RECORD_KIND:
        errors.append(f"kind must be {BENCH_RECORD_KIND!r}")
    for block in ("authoring", "navigation"):
        if block not in record:
            errors.append(
                f"the {block} block is absent — a record with one block is a single scale wearing "
                "a record's clothes; set it to null explicitly if that surface was not scored"
            )
    if not record.get("rubric_hash"):
        errors.append("rubric_hash is required — an unfrozen rubric makes the numbers unrankable (R10)")

    # The refusal. Every key must be one the schema declares; anything else is how a composite
    # arrives wearing a name nobody thought to ban.
    top_level = {k: v for k, v in record.items() if k not in ("authoring", "navigation", "topology")}
    unknown = [(k, "record") for k in _unknown_keys(top_level, RECORD_KEYS, "")]
    if isinstance(record.get("topology"), dict):
        unknown += [(k, "topology") for k in _unknown_keys(record["topology"], TOPOLOGY_KEYS, "topology.")]
    for name, allowed in (("authoring", AUTHORING_KEYS), ("navigation", NAVIGATION_KEYS)):
        block = record.get(name)
        if block is None:
            continue  # explicitly not scored on this surface, which is legal
        if not isinstance(block, dict):
            # A LIST or TUPLE block used to fall through both scans: the record-level scan skips
            # the block keys and the block scan required a dict, so nothing looked at it at all
            # and `authoring=[real_block, {"harmonic_mean": 0.873}]` validated clean. Not exotic —
            # model-bench runs N trials per subject, so the obvious next change to this module
            # makes `authoring` a list, and at that moment the refusal is off rather than degraded.
            errors.append(
                f"the {name} block is a {type(block).__name__}, not an object — a non-object block "
                "is scanned by nothing, so the allowlist cannot see what it carries"
            )
            continue
        unknown += [(k, name) for k in _unknown_keys(block, allowed, f"{name}.")]
    for key, where in unknown:
        errors.append(
            f"{key} is not a field the {where} schema declares. A record may only carry known "
            "fields — an unrecognised key is how a composite score arrives under a name nobody "
            "thought to ban, and a weighted blend invented at design time is an unfrozen rubric "
            "wearing a number (design D3)"
        )

    # The record's central invariant, checked rather than assumed: `unmeasured` must agree with the
    # actual nulls. Previously a block could claim everything was measured while carrying nulls,
    # or list a field it had in fact measured, and still validate.
    for name, fields in (("authoring", _AUTHORING_SCORES + _AUTHORING_TOP), ("navigation", METRIC_FIELDS)):
        block = record.get(name)
        if not isinstance(block, dict):
            continue
        if "unmeasured" not in block:
            errors.append(
                f"the {name} block carries no `unmeasured` list — the invariant was opt-in, so a "
                "block holding nulls while claiming completeness validated clean"
            )
            continue
        # Computed over the SCHEMA, not over present keys: dropping the null fields and declaring
        # `unmeasured: []` previously validated, while the honest inverse was refused.
        actual = sorted(f for f in fields if block.get(f) is None)
        if sorted(block["unmeasured"]) != actual:
            errors.append(
                f"{name}.unmeasured says {sorted(block['unmeasured'])} but the nulls are {actual} — "
                "the list and the values must agree or neither can be trusted"
            )
    return (not errors, errors)


def rank_records(
    records: List[Dict[str, Any]], *, higher_is_better: bool = True
) -> Dict[str, Any]:
    """Rank records by the primary metric they all declare, excluding what was not measured.

    Refuses a mixed pile: every record must declare the SAME primary metric and the SAME rubric
    hash. Ranking records that declared different instruments against one of them would be exactly
    the comparability failure P2 exists to remove.
    """
    if not records:
        return {"ranked": [], "excluded": [], "primary_metric": None}

    metrics = {r.get("primary_metric") for r in records}
    if len(metrics) != 1:
        raise ValueError(f"records declare different primary metrics {sorted(map(str, metrics))} — not comparable")
    primary_metric = records[0].get("primary_metric")
    if not primary_metric:
        raise ValueError("records declare no primary metric — there is nothing to rank them by")

    hashes = {r.get("rubric_hash") for r in records}
    if len(hashes) != 1:
        raise ValueError(
            f"records carry different rubric hashes {sorted(map(str, hashes))} — the instrument "
            "changed between them, so a post-hoc rubric edit has invalidated the comparison (R10)"
        )
    # `{None}` is a set of size one, so the check above passed happily for records that declared NO
    # instrument at all — the R10 guarantee satisfied vacuously by the absence of a rubric.
    if not records[0].get("rubric_hash"):
        raise ValueError("records carry no rubric hash — an undeclared instrument cannot freeze a comparison (R10)")

    block_name = primary_metric.split(".", 1)[0]
    ranked: List[Dict[str, Any]] = []
    excluded: List[Tuple[str, str]] = []
    for record in records:
        # Availability is judged on the block being RANKED, not always on navigation. Hardwiring it
        # dropped a subject from an authoring ranking because an unrelated sandbox was down.
        block = record.get(block_name) or {}
        if block.get("status") == "unavailable":
            excluded.append((record["subject"], "unavailable"))
            continue
        value = _resolve_metric(record, primary_metric)
        if value is None:
            excluded.append((record["subject"], "unmeasured"))
        elif not isinstance(value, (int, float)) or isinstance(value, bool):
            raise ValueError(f"{record['subject']}'s {primary_metric} is {value!r}, which cannot be ranked")
        else:
            ranked.append(record)

    ranked.sort(
        key=lambda r: (
            -_resolve_metric(r, primary_metric) if higher_is_better else _resolve_metric(r, primary_metric),
            r["subject"],
        )
    )
    return {"ranked": ranked, "excluded": excluded, "primary_metric": primary_metric}
