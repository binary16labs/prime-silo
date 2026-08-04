"""P1 — the real executor hook for ``run_multi_model``. Where the zeros end.

`sandbox_runner.run_multi_model` has carried eight agentic metrics since Phase
10 and has never produced a real one: `hook` defaulted to `_dry_run_stub`, which
returns 0.0 for every field. The API, the report and the dashboards were all
real; only the numbers were not.

This module supplies the hook. It drives a **subject** (a persona→model
assignment — design D2) through the SDLC manifest and folds the resulting G0
run-event stream into the eight `SandboxResult` fields.

The rule that matters, and the reason this module is careful rather than clever:

    **A metric that cannot be derived is ``None``, never ``0.0``.**

What today's stream can actually support
----------------------------------------
`pypes/orchestrator.py` emits `node_finished` with `duration_ms` and nothing
else — no `tokens_in`, no `tokens_out`, no `model`. So against the orchestrator
as it stands, a real bench run measures **two** of eight metrics
(`iteration_latency_ms_p95`, `loop_count_p95`) and honestly reports the other six
as `unmeasured`. That is the true state of the instrument, and stating it is the
deliverable. Two real numbers and six admissions beat eight fabricated zeros.
The remaining six become derivable the moment the orchestrator populates the
fields the G0 schema already defines (`events.py:node_finished`) — this module
reads them the instant they appear; no change here is required.

Requirements: R1 (one measurement path), R2 (real hook, stub explicit),
R3 (unmeasured ≠ 0.0), R6 (heterogeneous rosters), R13 (promotion input).
Design: architecture/SOLUTION-model-plurality.md §4.2. Contract: delivery/tasks/P1.md
"""

from __future__ import annotations

import json
import logging
import math
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence

from .model_resolver import resolve_model
from .sandbox_runner import METRIC_FIELDS, SandboxResult

log = logging.getLogger(__name__)  # AOS-OBS2: under the benny.sdlc.* hierarchy

#: Personas a subject may assign. `"*"` in a roster assigns all of them.
PERSONAS: tuple[str, ...] = ("planner", "architect", "implementer", "reviewer")


class SubjectUnavailable(RuntimeError):
    """A subject could not be run at all — endpoint down, model unresolvable.

    Raised by a driver and allowed to propagate out of the hook, where
    `run_multi_model` records an ``unavailable`` row with this reason and carries
    on with the remaining subjects.
    """


# ---------------------------------------------------------------------------
# Roster → assignment. Resolution goes through the EXISTING resolver.
# ---------------------------------------------------------------------------


class _BenchConfig:
    """The `ManifestConfig` surface `resolve_model` reads: a per-persona map.

    A shim, deliberately — the contract forbids a second resolver, so subject
    assignments are fed into `resolve_model`'s existing `model_per_persona`
    lookup rather than resolved here.
    """

    def __init__(self, per_persona: Dict[str, str], default: Optional[str] = None) -> None:
        self.model_per_persona = per_persona
        self.model = default


def resolve_assignment(roster: Dict[str, Any], subject_label: str) -> Dict[str, str]:
    """Expand a subject's `assign` block to ``{persona: model_id}``.

    Raises ``KeyError`` for an unknown subject or an assignment naming a model
    label that is not in the roster's pool — fail closed, because a silently
    dropped persona is a subject that is not the subject you named.
    """
    models = {m.get("label"): m for m in roster.get("models", [])}
    subject = next(
        (s for s in roster.get("subjects", []) if s.get("label") == subject_label), None
    )
    if subject is None:
        raise KeyError(f"subject {subject_label!r} is not in the roster")

    assign: Dict[str, str] = subject.get("assign", {}) or {}
    wildcard = assign.get("*")
    personas = sorted({*PERSONAS, *(p for p in assign if p != "*")})

    out: Dict[str, str] = {}
    for persona in personas:
        label = assign.get(persona, wildcard)
        if label is None:
            continue  # persona genuinely unassigned; resolve_model's default applies
        entry = models.get(label)
        if entry is None:
            raise KeyError(
                f"subject {subject_label!r} assigns unknown model label {label!r} to {persona!r}"
            )
        out[persona] = entry["id"]
    return out


def subject_model_for(roster: Dict[str, Any], subject_label: str, persona: str) -> str:
    """The model `persona` runs under for `subject_label`, via `resolve_model`."""
    return resolve_model(persona, config=_BenchConfig(resolve_assignment(roster, subject_label)))


# ---------------------------------------------------------------------------
# Event stream → metrics
# ---------------------------------------------------------------------------


def read_events(path: Path) -> List[Dict[str, Any]]:
    """Read a G0 ``events.jsonl``. A missing file is an empty stream, not a zero."""
    p = Path(path)
    if not p.exists():
        return []
    events: List[Dict[str, Any]] = []
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            # A torn final line is normal while a run is in flight. Skipping it
            # loses one event; guessing at its contents would lose the truth.
            log.warning("bench: skipping unparseable event line in %s", p)
    return events


def percentile(values: Sequence[float], pct: float = 95.0) -> Optional[float]:
    """Nearest-rank percentile. ``None`` for an empty sample — p95 of nothing is
    not zero. Deterministic: no interpolation, no clock, no randomness."""
    ordered = sorted(v for v in values if v is not None)
    if not ordered:
        return None
    rank = max(1, math.ceil(pct / 100.0 * len(ordered)))
    return ordered[rank - 1]


def _sum_detail(events: Iterable[Dict[str, Any]], key: str) -> Optional[int]:
    """Sum ``detail[key]`` across events, or ``None`` if no event carries it."""
    total = None
    for e in events:
        detail = e.get("detail")
        if isinstance(detail, dict) and isinstance(detail.get(key), (int, float)):
            total = (total or 0) + int(detail[key])
    return total


def derive_metrics(
    events: Iterable[Dict[str, Any]],
    *,
    rubric: Optional[Dict[str, Any]] = None,
    price_book: Optional[Dict[str, float]] = None,
) -> Dict[str, Optional[float]]:
    """Fold a G0 event stream into the eight metrics.

    Every field starts as ``None`` and is only ever *replaced* by a value the
    stream actually supports. That ordering is the safety property: a derivation
    that cannot run leaves `unmeasured` standing, so a future metric added
    carelessly fails closed.

    `rubric` (optional): ``{"expected_ops": {node_id: op}, "min_steps": int}`` —
    without it the two tool metrics are unmeasured, because there is nothing to
    be accurate *against*.
    `price_book` (optional): ``{model_id: usd_per_1k_tokens}`` — without it cost
    is unmeasured. Local Lemonade inference has no meaningful per-token price,
    and inventing one would put a fabricated number in a governance record.
    """
    events = list(events)
    metrics: Dict[str, Optional[float]] = {f: None for f in METRIC_FIELDS}

    finished = [e for e in events if e.get("event") == "node_finished"]
    failed = [e for e in events if e.get("event") == "node_failed"]
    progress = [e for e in events if e.get("event") == "node_progress"]

    # --- latency: the one thing the stream carries today -------------------
    durations = [
        e["duration_ms"] for e in (*finished, *failed) if e.get("duration_ms") is not None
    ]
    if durations:
        metrics["iteration_latency_ms_p95"] = float(percentile(durations))

    # --- loops: max attempt per node is the agentic loop count -------------
    attempts: Dict[str, int] = {}
    for e in events:
        node = e.get("node_id")
        if node is None:
            continue
        attempts[node] = max(attempts.get(node, 0), int(e.get("attempt") or 1))
    if attempts:
        metrics["loop_count_p95"] = int(percentile(list(attempts.values())))

    # --- tokens: ALL or NOTHING -------------------------------------------
    # A sum over the subset of nodes that happened to report, presented as the
    # run total, is a smaller lie rather than a truth. If any completed node is
    # silent about tokens, the total is unmeasured.
    complete_tokens = bool(finished) and all(
        e.get("tokens_in") is not None and e.get("tokens_out") is not None for e in finished
    )
    if complete_tokens:
        prompt_tokens = sum(int(e["tokens_in"]) for e in finished)
        metrics["total_tokens"] = prompt_tokens + sum(int(e["tokens_out"]) for e in finished)

        unique = _sum_detail(progress, "unique_prompt_tokens")
        if unique is not None and prompt_tokens > 0:
            metrics["context_efficiency"] = min(1.0, unique / prompt_tokens)

        if price_book:
            priced = [e for e in finished if e.get("model") in price_book]
            if len(priced) == len(finished):
                metrics["total_cost"] = sum(
                    (int(e["tokens_in"]) + int(e["tokens_out"])) / 1000.0 * price_book[e["model"]]
                    for e in finished
                )

    # --- constraint adherence ---------------------------------------------
    # Zero evaluations leaves this unmeasured. The old stub returned 1.0 here —
    # a perfect compliance score derived from no evidence whatsoever. Absence of
    # evaluation is not evidence of adherence.
    evaluations = _sum_detail(progress, "gate_evaluations")
    if evaluations:
        rejections = _sum_detail(progress, "gate_rejections") or 0
        metrics["constraint_adherence"] = max(0.0, 1.0 - rejections / evaluations)

    # --- tool metrics: only against a frozen rubric ------------------------
    if rubric:
        observed = {
            e["node_id"]: e["detail"]["tool"]
            for e in progress
            if e.get("node_id")
            and isinstance(e.get("detail"), dict)
            and e["detail"].get("tool")
        }
        expected: Dict[str, str] = dict(rubric.get("expected_ops") or {})
        judged = {n: t for n, t in observed.items() if n in expected}
        if judged:
            hits = sum(1 for n, t in judged.items() if t == expected[n])
            metrics["tool_selection_accuracy"] = hits / len(judged)
        min_steps = rubric.get("min_steps")
        if observed and min_steps:
            metrics["tool_efficiency"] = min(1.0, float(min_steps) / len(observed))

    return metrics


# ---------------------------------------------------------------------------
# The hook
# ---------------------------------------------------------------------------

Driver = Callable[[str, Dict[str, str], Path, Path], Optional[str]]


def events_path(run_id: str, runs_root: Path) -> Path:
    """Where `RunEventStream` writes: ``<root>/runs/<run_id>/events.jsonl``."""
    return Path(runs_root) / "runs" / run_id / "events.jsonl"


def default_driver(
    subject_label: str, assignment: Dict[str, str], manifest_path: Path, workspace: Path
) -> Optional[str]:
    """Drive one subject through the real pypes orchestrator, returning its run id.

    Any failure becomes `SubjectUnavailable` so the comparison records an honest
    `unavailable` row and continues with the other subjects.
    """
    try:
        from ..pypes.orchestrator import run_manifest
    except Exception as exc:  # ImportError, or a broken optional dependency
        raise SubjectUnavailable(f"pypes orchestrator unavailable: {exc}") from exc

    try:
        receipt = run_manifest(
            manifest_path,
            workspace_root=Path(workspace),
            variables={"model_per_persona": dict(assignment)},
        )
    except Exception as exc:
        raise SubjectUnavailable(f"{type(exc).__name__}: {exc}") from exc

    run_id = getattr(receipt, "run_id", None)
    if not run_id:
        raise SubjectUnavailable("orchestrator returned a receipt with no run_id")
    return run_id


def make_bench_hook(
    roster: Dict[str, Any],
    *,
    drive: Driver = default_driver,
    rubric: Optional[Dict[str, Any]] = None,
    price_book: Optional[Dict[str, float]] = None,
    runs_root: Optional[Path] = None,
    read: Callable[[Path], List[Dict[str, Any]]] = read_events,
) -> Callable[[str, Path, Path], SandboxResult]:
    """Build a `_ModelHook` that benches subjects from `roster`.

    Satisfies R6 with **zero signature change** to `run_multi_model`: the
    existing `models: List[str]` parameter carries subject labels, and this hook
    resolves label → per-persona assignment (design D2).
    """

    def hook(subject_label: str, manifest_path: Path, workspace: Path) -> SandboxResult:
        assignment = resolve_assignment(roster, subject_label)
        log.info("bench: subject %s → %s", subject_label, assignment)
        run_id = drive(subject_label, assignment, Path(manifest_path), Path(workspace))

        root = Path(runs_root) if runs_root is not None else Path(workspace)
        events = read(events_path(run_id, root)) if run_id else []
        metrics = derive_metrics(events, rubric=rubric, price_book=price_book)

        result = SandboxResult(model=subject_label, run_id=run_id, **metrics)
        if result.unmeasured:
            log.info(
                "bench: subject %s measured %d/%d metrics; unmeasured: %s",
                subject_label, len(result.measured), len(METRIC_FIELDS),
                ", ".join(result.unmeasured),
            )
        return result

    return hook
