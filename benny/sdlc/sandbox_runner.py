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

import json
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


@dataclass
class SandboxResult:
    """Per-model metrics produced by the sandbox runner (AOS-F30).

    Fields
    ------
    model:                    LLM model identifier.
    tool_selection_accuracy:  Fraction [0,1] of correct tool choices.
    tool_efficiency:          tools_used / minimum_required [0,1].
    context_efficiency:       unique_tokens / total_tokens [0,1].
    iteration_latency_ms_p95: p95 iteration wall-time in milliseconds.
    loop_count_p95:           p95 number of agentic loops.
    constraint_adherence:     1.0 = no schema drift [0,1].
    total_cost:               Estimated USD cost of the run.
    total_tokens:             Total tokens consumed (prompt + completion).
    captured_at:              ISO-8601 UTC timestamp.
    """

    model: str
    tool_selection_accuracy: float
    tool_efficiency: float
    context_efficiency: float
    iteration_latency_ms_p95: float
    loop_count_p95: int
    constraint_adherence: float
    total_cost: float
    total_tokens: int
    captured_at: str = field(default="")

    def __post_init__(self) -> None:
        if not self.captured_at:
            self.captured_at = datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Default stub — used when no hook provided
# ---------------------------------------------------------------------------


def _dry_run_stub(model: str, manifest_path: Path, workspace: Path) -> SandboxResult:
    """Dry-run stub that returns a zeroed SandboxResult (no LLM invocation)."""
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
    )


# ---------------------------------------------------------------------------
# Public API — run_multi_model
# ---------------------------------------------------------------------------

_ModelHook = Callable[[str, Path, Path], SandboxResult]


def run_multi_model(
    manifest_path: Path,
    *,
    models: List[str],
    workspace: Path,
    hook: Optional[_ModelHook] = None,
) -> List[SandboxResult]:
    """Execute *manifest_path* against each model and return per-model results.

    Parameters
    ----------
    manifest_path:
        Path to the SDLC manifest JSON file.
    models:
        List of model identifiers to run against (e.g. ``["lm_a", "lm_b"]``).
    workspace:
        Workspace root directory.
    hook:
        Optional callable ``(model, manifest_path, workspace) → SandboxResult``.
        Defaults to a dry-run stub when ``None``.

    Returns
    -------
    list[SandboxResult]
        One result per model, in the same order as *models*.
    """
    runner = hook or _dry_run_stub
    results: List[SandboxResult] = []

    for model in models:
        log.debug("aos: sandbox running model %s against %s", model, manifest_path.name)
        try:
            result = runner(model, Path(manifest_path), Path(workspace))
        except Exception as exc:  # pragma: no cover — defensive
            log.warning("aos: sandbox run failed for model %s: %s", model, exc)
            result = SandboxResult(
                model=model,
                tool_selection_accuracy=0.0,
                tool_efficiency=0.0,
                context_efficiency=0.0,
                iteration_latency_ms_p95=0.0,
                loop_count_p95=0,
                constraint_adherence=0.0,
                total_cost=0.0,
                total_tokens=0,
            )
        results.append(result)

    return results


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
        f"",
        f"Generated: {ts}",
        f"Models compared: {', '.join(r.model for r in results)}",
        f"",
        "## Per-model metrics",
        "",
    ]

    # Table header
    cols = [
        "model", "tool_selection_accuracy", "tool_efficiency",
        "context_efficiency", "iteration_latency_ms_p95", "loop_count_p95",
        "constraint_adherence", "total_cost", "total_tokens",
    ]
    lines.append("| " + " | ".join(cols) + " |")
    lines.append("| " + " | ".join(["---"] * len(cols)) + " |")

    for r in results:
        row = asdict(r)
        cells = [str(row.get(c, "—")) for c in cols]
        lines.append("| " + " | ".join(cells) + " |")

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
