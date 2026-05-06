"""Report rendering — turn a checkpointed Gold step into an explainable artifact.

Reports are the "why" layer on top of the "what". They read a step's
checkpoint, aggregate along the drill-down dimensions, annotate every
metric with its CLP provenance, and write a markdown (or JSON/HTML)
document that a risk officer or auditor can read *without* opening a
parquet file.

Supported ``kind`` values:

* ``financial_risk`` — counterparty / portfolio exposure with threshold
  breach highlights.
* ``threshold_breaches`` — tabulate every failed threshold check per
  step.
* ``move_analysis`` — compare the current run to a baseline checkpoint.
* ``generic_summary`` — column stats + top-N rows.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from .checkpoints import CheckpointStore
from .engine import ExecutionEngine
from .models import PypesManifest, ReportSpec, RunReceipt, ValidationResult


def render_report(
    engine: ExecutionEngine,
    manifest: PypesManifest,
    spec: ReportSpec,
    store: CheckpointStore,
    receipt: RunReceipt,
    baseline_store: Optional[CheckpointStore] = None,
) -> str:
    """Render ``spec`` against the run's checkpoints and return an artifact path."""
    df = store.read(engine, spec.source_step)
    if df is None:
        raise KeyError(f"Report '{spec.id}' requires checkpoint for step '{spec.source_step}'")

    if spec.kind == "financial_risk":
        body = _render_financial_risk(engine, manifest, spec, df, receipt)
    elif spec.kind == "threshold_breaches":
        body = _render_threshold_breaches(manifest, spec, receipt)
    elif spec.kind == "move_analysis":
        body = _render_move_analysis(engine, manifest, spec, df, baseline_store)
    else:
        body = _render_generic(engine, manifest, spec, df)

    report_dir = store.run_dir / "reports"
    report_dir.mkdir(parents=True, exist_ok=True)
    if spec.format == "json":
        path = report_dir / f"{spec.id}.json"
    elif spec.format == "html":
        path = report_dir / f"{spec.id}.html"
    else:
        path = report_dir / f"{spec.id}.md"

    if spec.format == "json":
        # In JSON mode, ``body`` is already JSON text.
        path.write_text(body, encoding="utf-8")
    elif spec.format == "html":
        path.write_text(_wrap_html(spec.title, body), encoding="utf-8")
    else:
        path.write_text(body, encoding="utf-8")
    return str(path)


# =============================================================================
# KIND RENDERERS
# =============================================================================


def _render_financial_risk(
    engine: ExecutionEngine,
    manifest: PypesManifest,
    spec: ReportSpec,
    df: Any,
    receipt: RunReceipt,
) -> str:
    head = _header(manifest, spec, receipt)

    # Aggregate by drill-down dimension(s) with declared metrics.
    if spec.drill_down_by and spec.metrics:
        agg = engine.aggregate(df, group_by=spec.drill_down_by, metrics=spec.metrics)
    else:
        agg = df

    # Sort by first numeric metric descending if available.
    if spec.metrics:
        first_metric = next(iter(spec.metrics.keys()))
        try:
            agg = engine.sort(agg, by=[first_metric], descending=True)
        except Exception:
            pass

    rows = engine.to_records(agg, limit=spec.top_n or 50)
    columns = list(rows[0].keys()) if rows else engine.columns(agg)

    lines: List[str] = [head, "", "## Top Exposures", ""]
    lines.append(_markdown_table(columns, rows))

    # Breach table
    breach_lines = _breach_table(manifest, receipt)
    if breach_lines:
        lines.append("")
        lines.append("## Threshold Breaches")
        lines.append("")
        lines.extend(breach_lines)

    # CLP provenance
    lines.append("")
    lines.append("## CLP Provenance")
    lines.append("")
    lines.extend(_clp_provenance_lines(manifest, spec))

    return "\n".join(lines) + "\n"


def _render_threshold_breaches(
    manifest: PypesManifest, spec: ReportSpec, receipt: RunReceipt
) -> str:
    lines = [_header(manifest, spec, receipt), "", "## Breaches by Step", ""]
    breach_lines = _breach_table(manifest, receipt)
    if breach_lines:
        lines.extend(breach_lines)
    else:
        lines.append("_No threshold breaches detected in this run._")
    return "\n".join(lines) + "\n"


def _render_move_analysis(
    engine: ExecutionEngine,
    manifest: PypesManifest,
    spec: ReportSpec,
    df: Any,
    baseline_store: Optional[CheckpointStore],
) -> str:
    lines = [_header(manifest, spec, None), "", "## Move Analysis", ""]
    cols = [c for c in engine.columns(df) if _is_numeric_col(engine, df, c)]
    baseline_df = baseline_store.read(engine, spec.source_step) if baseline_store else None
    if baseline_df is None:
        lines.append("_No baseline run found for this manifest — first run establishes the baseline._")
        return "\n".join(lines) + "\n"

    header = ["column", "current_mean", "baseline_mean", "delta_percent"]
    rows: List[Dict[str, Any]] = []
    for c in cols[:20]:
        cur = engine.describe(df, c)
        base = engine.describe(baseline_df, c)
        cm = cur.get("mean")
        bm = base.get("mean")
        if cm is None or bm is None or not bm:
            delta = None
        else:
            delta = round((cm - bm) / bm * 100.0, 4)
        rows.append({"column": c, "current_mean": cm, "baseline_mean": bm, "delta_percent": delta})
    lines.append(_markdown_table(header, rows))
    return "\n".join(lines) + "\n"


def _render_generic(
    engine: ExecutionEngine,
    manifest: PypesManifest,
    spec: ReportSpec,
    df: Any,
) -> str:
    if spec.format == "json":
        return json.dumps(
            {
                "report": spec.model_dump(),
                "columns": engine.columns(df),
                "row_count": engine.row_count(df),
                "rows": engine.to_records(df, limit=spec.top_n or 50),
            },
            indent=2,
            default=str,
        )
    head = _header(manifest, spec, None)
    rows = engine.to_records(df, limit=spec.top_n or 50)
    cols = engine.columns(df)
    return head + "\n\n" + _markdown_table(cols, rows) + "\n"


# =============================================================================
# HELPERS
# =============================================================================


def _header(manifest: PypesManifest, spec: ReportSpec, receipt: Optional[RunReceipt]) -> str:
    stamp = datetime.utcnow().isoformat()
    run_line = f"- **Run:** `{receipt.run_id}`" if receipt else ""
    tags = ", ".join(manifest.governance.compliance_tags) or "—"
    return (
        f"# {spec.title}\n"
        f"\n"
        f"- **Manifest:** `{manifest.id}` ({manifest.name})\n"
        f"- **Workspace:** `{manifest.workspace}`\n"
        f"{run_line}\n"
        f"- **Source step:** `{spec.source_step}`\n"
        f"- **Compliance:** {tags}\n"
        f"- **Generated:** {stamp}Z\n"
    )


def _markdown_table(columns: List[str], rows: List[Dict[str, Any]]) -> str:
    if not rows:
        return "_no data_"
    header = "| " + " | ".join(columns) + " |"
    divider = "| " + " | ".join(["---"] * len(columns)) + " |"
    body = []
    for r in rows:
        body.append("| " + " | ".join(_fmt(r.get(c)) for c in columns) + " |")
    return "\n".join([header, divider, *body])


def _fmt(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float):
        if abs(value) >= 1e6:
            return f"{value:,.2f}"
        return f"{value:,.4f}" if value % 1 else str(int(value))
    return str(value).replace("|", "\\|")


def _breach_table(manifest: PypesManifest, receipt: RunReceipt) -> List[str]:
    breaches: List[Dict[str, Any]] = []
    for step_id, result in receipt.step_results.items():
        if not isinstance(result, ValidationResult):
            continue
        for check in result.checks:
            if check.get("status") == "FAILED":
                breaches.append(
                    {
                        "step": step_id,
                        "check": check.get("check"),
                        "field": check.get("field", ""),
                        "detail": _compact_check_detail(check),
                    }
                )
    if not breaches:
        return []
    return [_markdown_table(["step", "check", "field", "detail"], breaches)]


def _compact_check_detail(check: Dict[str, Any]) -> str:
    keys = ("nulls", "duplicates", "observed", "expected", "delta_percent")
    parts = [f"{k}={check[k]}" for k in keys if k in check]
    return "; ".join(parts) or check.get("reason", "—")


def _clp_provenance_lines(manifest: PypesManifest, spec: ReportSpec) -> List[str]:
    step = manifest.step(spec.source_step)
    if step is None or not step.clp_binding:
        return [
            "_No explicit CLP binding on the source step — add `clp_binding` to the step "
            "spec to enable column-level drill-back._"
        ]
    lines = [
        "| column | conceptual | logical | physical |",
        "| --- | --- | --- | --- |",
    ]
    concept_index = {c.name: c for c in manifest.clp.conceptual}
    for col, ref in step.clp_binding.items():
        if "." in ref:
            entity, attr = ref.split(".", 1)
        else:
            entity, attr = ref, ""
        concept = concept_index.get(entity)
        concept_name = concept.name if concept else entity
        physical = next(
            (p.uri_template for p in manifest.physical if p.entity == entity),
            "",
        ) if hasattr(manifest, "physical") else ""
        lines.append(f"| `{col}` | {concept_name} | {entity}.{attr} | {physical} |")
    return lines


def _is_numeric_col(engine: ExecutionEngine, df: Any, col: str) -> bool:
    try:
        stats = engine.describe(df, col)
        return stats.get("mean") is not None
    except Exception:
        return False


def _wrap_html(title: str, body_md: str) -> str:
    return (
        "<!doctype html>"
        f"<html><head><meta charset='utf-8'><title>{title}</title>"
        "<style>body{font-family:system-ui;padding:24px;max-width:920px;margin:auto}"
        "table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 10px}"
        "th{background:#f4f4f8}h1,h2{color:#222}</style></head>"
        "<body><pre style='white-space:pre-wrap'>" + body_md + "</pre></body></html>"
    )
