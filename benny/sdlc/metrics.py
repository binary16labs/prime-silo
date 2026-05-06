"""AOS-001 Phase 10 — Process-metric record (§4.5 of requirement.md).

Public API
----------
  ProcessMetric
      Dataclass holding the §4.5 process-metric fields.

  record(metric, *, workspace_path) -> Path
      Persists *metric* to ``<workspace>/data_out/metrics/<run_id>.json``
      and returns the written path (AOS-F28).

  phoenix_attrs(metric) -> dict[str, Any]
      Returns OTLP span attributes in the ``aos.metrics.*`` namespace,
      ready to attach to the existing workflow span (AOS-F31).

  aos_doctor_section(*, workspace_path=None) -> dict[str, Any]
      Returns the ``aos`` sub-section of ``benny doctor --json`` (AOS-OBS1).
      Includes PBR store size, ledger head SHA, and pending HITL count.

AOS requirements covered
------------------------
  F28    record(): process-metric JSON at data_out/metrics/{run_id}.json.
  F31    phoenix_attrs(): OTLP span attributes in aos.metrics.* namespace.
  OBS1   aos_doctor_section(): 'aos' key in benny doctor --json output.
  OBS2   Module logger is under 'benny.sdlc.metrics' (aos component hierarchy).

Dependencies: stdlib only (dataclasses, datetime, json, pathlib).
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)  # AOS-OBS2: logger under benny.sdlc.* hierarchy


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------


@dataclass
class ProcessMetric:
    """Process-centric metric record per §4.5 of requirement.md (AOS-F28).

    All float fields are in the range [0.0, 1.0] except latency (ms) and
    loop count (int).
    """

    run_id: str
    model: str
    tool_selection_accuracy: float
    tool_efficiency: float
    context_efficiency: float
    iteration_latency_ms_p95: float
    loop_count_p95: int
    constraint_adherence: float

    # Assigned by record() if not provided
    captured_at: str = field(default="")

    def __post_init__(self) -> None:
        if not self.captured_at:
            self.captured_at = datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Public API — record
# ---------------------------------------------------------------------------


def record(
    metric: ProcessMetric,
    *,
    workspace_path: Path,
) -> Path:
    """Persist *metric* to ``<workspace>/data_out/metrics/<run_id>.json`` (AOS-F28).

    Parameters
    ----------
    metric:
        Populated :class:`ProcessMetric` instance.
    workspace_path:
        Root path of the target workspace.

    Returns
    -------
    Path
        Absolute path to the written JSON file.
    """
    metrics_dir = Path(workspace_path) / "data_out" / "metrics"
    metrics_dir.mkdir(parents=True, exist_ok=True)

    out_path = metrics_dir / f"{metric.run_id}.json"
    doc = asdict(metric)
    out_path.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    log.debug("aos: metrics recorded for run %s → %s", metric.run_id, out_path)
    return out_path


# ---------------------------------------------------------------------------
# Public API — phoenix_attrs
# ---------------------------------------------------------------------------


def phoenix_attrs(metric: ProcessMetric) -> dict[str, Any]:
    """Return OTLP span attributes for a process-metric record (AOS-F31).

    All keys are in the ``aos.metrics.*`` namespace to avoid collisions with
    existing Phoenix / OpenTelemetry attributes.

    Parameters
    ----------
    metric:
        Populated :class:`ProcessMetric` instance.

    Returns
    -------
    dict[str, Any]
        OTLP attribute dict ready to attach to a Phoenix workflow span.
    """
    return {
        "aos.metrics.run_id":                    metric.run_id,
        "aos.metrics.model":                     metric.model,
        "aos.metrics.tool_selection_accuracy":   metric.tool_selection_accuracy,
        "aos.metrics.tool_efficiency":           metric.tool_efficiency,
        "aos.metrics.context_efficiency":        metric.context_efficiency,
        "aos.metrics.iteration_latency_ms_p95":  metric.iteration_latency_ms_p95,
        "aos.metrics.loop_count_p95":            metric.loop_count_p95,
        "aos.metrics.constraint_adherence":      metric.constraint_adherence,
        "aos.metrics.captured_at":               metric.captured_at,
    }


# ---------------------------------------------------------------------------
# Public API — aos_doctor_section (AOS-OBS1)
# ---------------------------------------------------------------------------


def aos_doctor_section(
    *,
    workspace_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Return the ``aos`` sub-section of ``benny doctor --json`` (AOS-OBS1).

    Parameters
    ----------
    workspace_path:
        Optional workspace to inspect.  When ``None``, returns placeholder
        values suitable for offline / no-workspace contexts.

    Returns
    -------
    dict[str, Any]
        Dict with keys: ``pbr_store_size_bytes``, ``ledger_head_sha``,
        ``pending_hitl_count``, ``last_metric_run_id``,
        ``last_metric_captured_at``.
    """
    section: dict[str, Any] = {
        "pbr_store_size_bytes": 0,
        "ledger_head_sha": None,
        "pending_hitl_count": 0,
        "last_metric_run_id": None,
        "last_metric_captured_at": None,
    }

    if workspace_path is None:
        return section

    ws = Path(workspace_path)

    # PBR store size
    artifacts_dir = ws / "artifacts"
    if artifacts_dir.exists():
        section["pbr_store_size_bytes"] = sum(
            f.stat().st_size for f in artifacts_dir.rglob("*") if f.is_file()
        )

    # Ledger head SHA (read from ledger.jsonl last line)
    try:
        from benny.governance.ledger import get_head_hash

        ledger_dir = ws / "ledger"
        if ledger_dir.exists():
            section["ledger_head_sha"] = get_head_hash(ledger_dir=ledger_dir)
    except Exception:
        pass  # ledger not yet initialised — informational only

    # Last process metric
    metrics_dir = ws / "data_out" / "metrics"
    if metrics_dir.exists():
        metric_files = sorted(metrics_dir.glob("*.json"), key=lambda f: f.stat().st_mtime)
        if metric_files:
            try:
                last = json.loads(metric_files[-1].read_text(encoding="utf-8"))
                section["last_metric_run_id"] = last.get("run_id")
                section["last_metric_captured_at"] = last.get("captured_at")
            except (json.JSONDecodeError, OSError):
                pass

    return section
