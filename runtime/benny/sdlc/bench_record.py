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


#: The record fields that are themselves closed objects (or null). Everything else in the record is
#: a scalar or a list of scalars. These three are the ONLY fields with sub-structure, and they are
#: refused through one shared path — `_refuse_object` — so no single container field can be given an
#: allowlist while another is quietly left with a denylist's blind spot. That asymmetry is the whole
#: history of this validator: the guard was added for authoring and navigation and forgotten for
#: topology, and a composite rode in as `topology=[{"weighted": 0.9}]` through the one gap left.
_SUBOBJECTS = (
    ("authoring", AUTHORING_KEYS),
    ("navigation", NAVIGATION_KEYS),
    ("topology", TOPOLOGY_KEYS),
)


#: A scalar leaf: what a declared field is permitted to carry. `bool` is listed for intent even
#: though it is an `int` subclass. Anything NOT on this list — a dict, a set, a frozenset, a
#: MappingProxyType, a dataclass, any object with a `__dict__` — is not a scalar and is refused.
_SCALAR_TYPES = (str, int, float, bool, type(None))


def _is_scalar_tree(value: Any) -> bool:
    """True only if `value` is a scalar or a (possibly nested) list/tuple of scalars.

    This fails CLOSED, which is the whole point. The previous walker asked the wrong question —
    'does this CONTAIN a dict?' — and returned False for every container it did not enumerate, so a
    composite could ride in as a frozenset, a MappingProxyType or a dataclass under an allowed key
    and never be looked at. The key NAMES were an allowlist while the container TYPES were still a
    denylist of the three shapes someone happened to think of. This asks the inverse: a value passes
    only if every leaf is a known scalar type. A container type nobody enumerated is refused by
    default rather than waved through."""
    if isinstance(value, _SCALAR_TYPES):
        return True
    if isinstance(value, (list, tuple)):
        return all(_is_scalar_tree(v) for v in value)
    return False


def _refuse_object(obj: Any, keyset: frozenset, where: str, errors: List[str]) -> None:
    """`obj` must be a closed object over `keyset`: a dict whose every key is declared and whose
    every value is free of nested objects. A non-dict is refused outright — otherwise it is scanned
    by nothing, which is precisely how a list/tuple block, and later a non-dict topology, walked
    past the allowlist."""
    if not isinstance(obj, dict):
        errors.append(
            f"the {where} is a {type(obj).__name__}, not an object — a non-object is scanned by "
            "nothing, so the allowlist cannot see what it carries, and a composite rides in as a "
            "list, a tuple or a bare value"
        )
        return
    for key, value in obj.items():
        if key not in keyset:
            errors.append(
                f"{where}.{key} is not a field the {where} schema declares. A record may only "
                "carry known fields — an unrecognised key is how a composite score arrives under a "
                "name nobody thought to ban, and a weighted blend invented at design time is an "
                "unfrozen rubric wearing a number (design D3)"
            )
        if not _is_scalar_tree(value):
            errors.append(
                f"{where}.{key} holds a {type(value).__name__}, not a scalar — a declared field "
                "carries a scalar or a list of scalars, never a structure, because a structure is "
                "where an unnamed composite hides"
            )


def validate_record(record: Dict[str, Any]) -> Tuple[bool, List[str]]:
    """Fail-closed validation against ONE closed schema. Returns ``(ok, errors)``.

    Every value travels a single path: the record is a closed object over ``RECORD_KEYS``; three of
    its fields (``authoring``, ``navigation``, ``topology``) are themselves closed objects or null,
    each refused by the same ``_refuse_object``; every other field carries a scalar or a list of
    scalars and is refused if it hides a nested object. No field has a bespoke branch, because a
    bespoke branch is what kept getting forgotten — the allowlist was wired for the authoring and
    navigation blocks and not for topology, so a composite hid in the one container still guarded by
    a denylist's blind spot."""
    errors: List[str] = []
    if not isinstance(record, dict):
        return (False, ["a bench record must be an object"])

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

    # The closed schema, one path. Top-level keys must be declared; the three sub-objects are
    # delegated to `_refuse_object`; every other field is refused if it hides a nested object.
    subobject_names = {name for name, _ in _SUBOBJECTS}
    for key, value in record.items():
        if key not in RECORD_KEYS:
            errors.append(
                f"{key} is not a field the record schema declares. A record may only carry known "
                "fields — an unrecognised key is how a composite score arrives under a name nobody "
                "thought to ban, and a weighted blend invented at design time is an unfrozen rubric "
                "wearing a number (design D3)"
            )
            continue
        if key in subobject_names:
            continue  # checked below against its own keyset
        if not _is_scalar_tree(value):
            errors.append(
                f"{key} holds a {type(value).__name__}, not a scalar — a declared field carries a "
                "scalar or a list of scalars, never a structure, because a structure is where an "
                "unnamed composite hides"
            )
    for name, keyset in _SUBOBJECTS:
        block = record.get(name)
        if block is None:
            continue  # explicitly not scored, or no topology declared — both legal
        _refuse_object(block, keyset, name, errors)

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
        if not isinstance(block["unmeasured"], (list, tuple)):
            # A named refusal, not a bare TypeError out of `sorted(None)` two lines down. A caller
            # that hands us `unmeasured: null` gets told what is wrong, not a stack trace.
            errors.append(
                f"the {name} block's `unmeasured` is a {type(block['unmeasured']).__name__}, not a "
                "list — the invariant is a list of the fields that were not measured"
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
