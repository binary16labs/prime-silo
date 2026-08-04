"""AOS-001 Phase 10 — Multi-model sandbox runner.

Public API
----------
  SandboxResult
      Dataclass with per-model metrics (AOS-F30).

  run_multi_model(manifest_path, *, models, workspace, hook=None) -> list[SandboxResult]
      Execute the same manifest against each model in sequence (AOS-F29).
      *hook* is an optional callable ``(model, manifest_path, workspace) →
      SandboxResult`` used for testing without a real LLM.  When *hook*
      is ``None``, a dry-run stub is used (models not actually invoked).

  write_sandbox_report(results, *, manifest_id, workspace_path,
                       timestamp=None) -> Path
      Write a Markdown side-by-side comparison report to
      ``<workspace>/data_out/sandbox_reports/<manifest_id>_<ts>.md``
      (AOS-F29).

  sandbox_availability() -> dict[str, Any]
      Return information about available sandbox backends (AOS-SEC4):
      bubblewrap, sandbox-exec, or none.

  diff_manifests(m1, m2) -> dict[str, Any]
      Compute a structural diff between two manifest dicts (AOS-COMP4).
      Returns keys: ``added``, ``removed``, ``changed``.

AOS requirements covered
------------------------
  F29    run_multi_model() + write_sandbox_report(): multi-model sandbox.
  F30    SandboxResult: all 8 required per-model metric fields.
  NFR9   run_multi_model() is stateless and safe to call 10× consecutively.
  SEC4   sandbox_availability(): reports bubblewrap/sandbox-exec availability.
  COMP4  diff_manifests(): structural diff for benny diff sub-command.

Dependencies: stdlib only (dataclasses, datetime, json, pathlib, shutil, sys).
"""

from __future__ import annotations

import logging
import shutil
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, List, Optional

log = logging.getLogger(__name__)  # AOS-OBS2: under benny.sdlc.* hierarchy


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


#: The eight AOS-F30 metric fields, in report order. Single source of truth —
#: `bench_executor` derives exactly these, and `rank_subjects` ranks by one of them.
METRIC_FIELDS = (
    "tool_selection_accuracy",
    "tool_efficiency",
    "context_efficiency",
    "iteration_latency_ms_p95",
    "loop_count_p95",
    "constraint_adherence",
    "total_cost",
    "total_tokens",
)

#: Sentinel asking for the zeroed stub deliberately (P1/R2, design D4).
DRY_RUN = "dry-run"


@dataclass
class SandboxResult:
    """Per-model metrics produced by the sandbox runner (AOS-F30).

    **Every metric is ``Optional`` and defaults to ``None`` (P1/R3).** ``None``
    means *not measured*; it is not a zero, is rendered as ``unmeasured``, and is
    excluded from ranking. This is the whole point of P1: the previous shape made
    an underived metric indistinguishable from a real zero, so eight fields that
    had never once been measured read as eight legitimate scores.

    Fields
    ------
    model:                    Subject label (design D2) or LLM model identifier.
    tool_selection_accuracy:  Fraction [0,1] of correct tool choices.
    tool_efficiency:          minimum_required / tools_used [0,1].
    context_efficiency:       unique_tokens / prompt_tokens [0,1].
    iteration_latency_ms_p95: p95 iteration wall-time in milliseconds.
    loop_count_p95:           p95 number of agentic loops (attempts per node).
    constraint_adherence:     1.0 = no schema drift [0,1].
    total_cost:               Estimated USD cost of the run.
    total_tokens:             Total tokens consumed (prompt + completion).
    captured_at:              ISO-8601 UTC timestamp.
    status:                   ``ok`` | ``unavailable`` | ``dry-run``.
    unavailable_reason:       Why the subject could not be run, when unavailable.
    run_id:                   Run whose event stream these metrics were folded from.
    """

    model: str
    tool_selection_accuracy: Optional[float] = None
    tool_efficiency: Optional[float] = None
    context_efficiency: Optional[float] = None
    iteration_latency_ms_p95: Optional[float] = None
    loop_count_p95: Optional[int] = None
    constraint_adherence: Optional[float] = None
    total_cost: Optional[float] = None
    total_tokens: Optional[int] = None
    captured_at: str = field(default="")
    status: str = "ok"
    unavailable_reason: Optional[str] = None
    run_id: Optional[str] = None

    def __post_init__(self) -> None:
        if not self.captured_at:
            self.captured_at = datetime.now(timezone.utc).isoformat()

    @property
    def unmeasured(self) -> tuple[str, ...]:
        """Metric names this run could not derive. Empty tuple = fully measured."""
        return tuple(f for f in METRIC_FIELDS if getattr(self, f) is None)

    @property
    def measured(self) -> tuple[str, ...]:
        return tuple(f for f in METRIC_FIELDS if getattr(self, f) is not None)


def unavailable_result(model: str, reason: str) -> SandboxResult:
    """A subject that could not be run at all. NOT a zeroed row.

    Zeros here would rank the subject last *on merit* — as though it had been
    measured and performed terribly — instead of excluding it as unmeasured.
    """
    return SandboxResult(model=model, status="unavailable", unavailable_reason=reason)


# ---------------------------------------------------------------------------
# Default stub — used when no hook provided
# ---------------------------------------------------------------------------


def _dry_run_stub(model: str, manifest_path: Path, workspace: Path) -> SandboxResult:
    """Dry-run stub: a zeroed SandboxResult, no LLM invoked.

    Kept (design D4) but now reachable ONLY by asking for it by name, and tagged
    ``status="dry-run"`` so no report can present it as a measurement. Note the
    ``constraint_adherence=1.0`` below: for years this stub awarded a *perfect*
    adherence score to a run that never happened.
    """
    return SandboxResult(
        model=model,
        tool_selection_accuracy=0.0,
        tool_efficiency=0.0,
        context_efficiency=0.0,
        iteration_latency_ms_p95=0.0,
        loop_count_p95=0,
        constraint_adherence=1.0,
        total_cost=0.0,
        total_tokens=0,
        status=DRY_RUN,
    )


def _select_runner(hook: Any) -> _ModelHook:
    """Resolve the ``hook`` argument to a callable, or refuse loudly (R2, D4)."""
    if hook is None:
        raise ValueError(
            "run_multi_model(hook=...) is required. Passing None used to select "
            "_dry_run_stub silently, which returns 0.0 for every metric — "
            "indistinguishable in the report from a real run that scored zero, "
            "which is how eight metrics went years without ever being measured. "
            f"Pass a real hook (see benny.sdlc.bench_executor.make_bench_hook), or "
            f"hook={DRY_RUN!r} to ask for the zeroed stub deliberately."
        )
    if hook == DRY_RUN:
        return _dry_run_stub
    if not callable(hook):
        raise TypeError(f"hook must be callable or {DRY_RUN!r}, got {type(hook).__name__}")
    return hook


# ---------------------------------------------------------------------------
# Public API — run_multi_model
# ---------------------------------------------------------------------------

_ModelHook = Callable[[str, Path, Path], SandboxResult]


def run_multi_model(
    manifest_path: Path,
    *,
    models: List[str],
    workspace: Path,
    hook: Any = None,
) -> List[SandboxResult]:
    """Execute *manifest_path* against each model and return per-model results.

    Parameters
    ----------
    manifest_path:
        Path to the SDLC manifest JSON file.
    models:
        Subject labels to run (design D2 — a subject is a persona→model
        assignment, and "one model everywhere" is the degenerate case).
    workspace:
        Workspace root directory.
    hook:
        **Required.** A callable ``(subject, manifest_path, workspace) →
        SandboxResult``, or the string ``"dry-run"`` to select the zeroed stub
        deliberately. ``None`` raises — see :func:`_select_runner`.

    Returns
    -------
    list[SandboxResult]
        One result per subject, in the same order as *models*. A subject that
        could not be run yields an ``unavailable`` row and does **not** abort the
        others.
    """
    runner = _select_runner(hook)
    results: List[SandboxResult] = []

    for model in models:
        log.debug("aos: sandbox running model %s against %s", model, Path(manifest_path).name)
        try:
            result = runner(model, Path(manifest_path), Path(workspace))
        except Exception as exc:
            # One unreachable subject must not take the comparison down with it.
            # The row is `unavailable` with a reason — never a zeroed row, which
            # would read as "measured, and terrible".
            log.warning("aos: sandbox run unavailable for subject %s: %s", model, exc)
            result = unavailable_result(model, f"{type(exc).__name__}: {exc}")
        results.append(result)

    return results


def rank_subjects(
    results: List[SandboxResult],
    *,
    primary_metric: str,
    higher_is_better: bool = True,
) -> dict[str, Any]:
    """Rank subjects by one declared metric, excluding anything unmeasured (D3).

    There is deliberately **no composite score**: a weighted blend invented at
    design time is an unfrozen rubric wearing a number. Ranking declares its
    primary metric up front and reports what it had to leave out, so a thin
    comparison cannot masquerade as a complete one.

    Returns ``{"ranked": [...], "excluded": [(model, why), ...], "primary_metric": str}``.
    """
    if primary_metric not in METRIC_FIELDS:
        raise ValueError(f"unknown primary_metric {primary_metric!r}; expected one of {METRIC_FIELDS}")

    ranked: List[SandboxResult] = []
    excluded: List[tuple] = []
    for r in results:
        if r.status == "unavailable":
            excluded.append((r.model, "unavailable"))
        elif getattr(r, primary_metric) is None:
            excluded.append((r.model, "unmeasured"))
        else:
            ranked.append(r)

    ranked.sort(key=lambda r: (-getattr(r, primary_metric) if higher_is_better else getattr(r, primary_metric), r.model))
    return {"ranked": ranked, "excluded": excluded, "primary_metric": primary_metric}


# ---------------------------------------------------------------------------
# Public API — write_sandbox_report
# ---------------------------------------------------------------------------


def write_sandbox_report(
    results: List[SandboxResult],
    *,
    manifest_id: str,
    workspace_path: Path,
    timestamp: Optional[str] = None,
) -> Path:
    """Write a Markdown side-by-side comparison report (AOS-F29).

    The report is written to
    ``<workspace>/data_out/sandbox_reports/<manifest_id>_<ts>.md``.

    Parameters
    ----------
    results:
        List of :class:`SandboxResult` objects, one per model.
    manifest_id:
        Manifest identifier used in the filename.
    workspace_path:
        Workspace root directory.
    timestamp:
        Optional ISO-8601 timestamp string; defaults to current UTC time.

    Returns
    -------
    Path
        Absolute path to the written ``.md`` file.
    """
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_dir = Path(workspace_path) / "data_out" / "sandbox_reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    out_path = report_dir / f"{manifest_id}_{ts}.md"

    lines: List[str] = [
        f"# Sandbox Report — `{manifest_id}`",
        "",
        f"Generated: {ts}",
        f"Models compared: {', '.join(r.model for r in results)}",
        "",
        "## Per-model metrics",
        "",
    ]

    # Table header
    cols = ["model", *METRIC_FIELDS]
    lines.append("| " + " | ".join(["status", *cols]) + " |")
    lines.append("| " + " | ".join(["---"] * (len(cols) + 1)) + " |")

    for r in results:
        row = asdict(r)
        # `None` renders as `unmeasured`, never as blank and never as 0. A blank
        # cell reads as an oversight; a zero reads as a result. It was neither.
        cells = [str(row.get(c)) if row.get(c) is not None else "unmeasured" for c in cols]
        lines.append("| " + " | ".join([r.status, *cells]) + " |")

    unavailable = [r for r in results if r.status == "unavailable"]
    if unavailable:
        lines += ["", "## Unavailable subjects", ""]
        lines += [f"- `{r.model}` — {r.unavailable_reason}" for r in unavailable]

    gaps = {f for r in results for f in r.unmeasured if r.status != "unavailable"}
    if gaps:
        lines += [
            "",
            "## Unmeasured",
            "",
            "These metrics could not be derived from the run-event stream and are "
            "reported as `unmeasured`. They are excluded from ranking. An unmeasured "
            "metric is **not** a zero:",
            "",
            *[f"- `{f}`" for f in sorted(gaps)],
        ]

    lines += ["", "---", ""]

    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


# ---------------------------------------------------------------------------
# Public API — sandbox_availability (AOS-SEC4)
# ---------------------------------------------------------------------------


def sandbox_availability() -> dict[str, Any]:
    """Report available OS sandbox backends (AOS-SEC4).

    Returns
    -------
    dict[str, Any]
        Keys: ``available`` (bool), ``backends`` (list[str]),
        ``recommended`` (str | None).
    """
    backends: List[str] = []

    # bubblewrap (Linux)
    if shutil.which("bwrap"):
        backends.append("bubblewrap")

    # sandbox-exec (macOS)
    if shutil.which("sandbox-exec"):
        backends.append("sandbox-exec")

    # Docker
    if shutil.which("docker"):
        backends.append("docker")

    return {
        "available": len(backends) > 0,
        "backends": backends,
        "recommended": backends[0] if backends else None,
        "platform": sys.platform,
    }


# ---------------------------------------------------------------------------
# Public API — diff_manifests (AOS-COMP4)
# ---------------------------------------------------------------------------


def diff_manifests(
    m1: dict[str, Any],
    m2: dict[str, Any],
) -> dict[str, Any]:
    """Compute a structural diff between two manifest dicts (AOS-COMP4).

    A simple key-level diff that identifies added, removed, and changed
    top-level keys (and recursively for nested dicts).

    Parameters
    ----------
    m1:
        First manifest dict (baseline).
    m2:
        Second manifest dict (new version).

    Returns
    -------
    dict[str, Any]
        Keys: ``added``, ``removed``, ``changed``.
    """
    added: dict[str, Any] = {}
    removed: dict[str, Any] = {}
    changed: dict[str, Any] = {}

    all_keys = set(m1.keys()) | set(m2.keys())
    for key in sorted(all_keys):
        if key in m1 and key not in m2:
            removed[key] = m1[key]
        elif key not in m1 and key in m2:
            added[key] = m2[key]
        elif m1[key] != m2[key]:
            changed[key] = {"from": m1[key], "to": m2[key]}

    return {"added": added, "removed": removed, "changed": changed}
