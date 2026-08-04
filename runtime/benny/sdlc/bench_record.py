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

#: Any field name matching this is a composite by another name. Checked at every depth, because a
#: blend hidden one level down still ends up being the number people quote.
FORBIDDEN_KEY_PATTERN = re.compile(
    r"composite|weighted|overall|combined|aggregate_score|total_score|blend", re.IGNORECASE
)

#: The authoring fields projected from a model_compare trial. A projection, not a rewrite — this
#: module never recomputes a score that `model_compare` already produced.
_AUTHORING_SCORES = ("has_required_ops", "step_count", "parse_ok")
_AUTHORING_TOP = ("wall_seconds", "total_tokens", "cost_usd", "quality_score", "status", "model")


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
        "scored_on": [n for n, b in (("authoring", authoring), ("navigation", navigation)) if b],
        "rubric_hash": rubric_hash,
        "roster_hash": roster_hash,
        "topology": topology,
        "primary_metric": primary_metric,
    }
    _resolve_metric(record, primary_metric)  # fail at build time, not at ranking time
    return record


def _forbidden_keys(obj: Any, prefix: str = "") -> List[str]:
    found: List[str] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            if FORBIDDEN_KEY_PATTERN.search(str(key)):
                found.append(f"{prefix}{key}")
            found.extend(_forbidden_keys(value, f"{prefix}{key}."))
    elif isinstance(obj, list):
        for i, value in enumerate(obj):
            found.extend(_forbidden_keys(value, f"{prefix}{i}."))
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
    for key in _forbidden_keys(record):
        errors.append(
            f"{key} looks like a composite score, which this record refuses to carry (design D3): "
            "a weighted blend invented at design time is an unfrozen rubric wearing a number"
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
    hashes = {r.get("rubric_hash") for r in records}
    if len(hashes) != 1:
        raise ValueError(
            f"records carry different rubric hashes {sorted(map(str, hashes))} — the instrument "
            "changed between them, so a post-hoc rubric edit has invalidated the comparison (R10)"
        )

    primary_metric = records[0]["primary_metric"]
    ranked: List[Dict[str, Any]] = []
    excluded: List[Tuple[str, str]] = []
    for record in records:
        nav = record.get("navigation") or {}
        if nav.get("status") == "unavailable":
            excluded.append((record["subject"], "unavailable"))
            continue
        value = _resolve_metric(record, primary_metric)
        if value is None:
            excluded.append((record["subject"], "unmeasured"))
        else:
            ranked.append(record)

    ranked.sort(
        key=lambda r: (
            -_resolve_metric(r, primary_metric) if higher_is_better else _resolve_metric(r, primary_metric),
            r["subject"],
        )
    )
    return {"ranked": ranked, "excluded": excluded, "primary_metric": primary_metric}
