"""`benny pypes` CLI subcommand handlers — Rich terminal UI.

Keeps ``benny_cli.py`` lean — the top-level CLI just registers a
subparser and dispatches through to ``cmd_pypes`` here.

Subcommands:
    benny pypes run <manifest.json>             [--workspace W] [--resume RUN]
    benny pypes inspect <manifest.json>         (print DAG + CLP summary)
    benny pypes runs ls --workspace W           (list prior pypes runs)
    benny pypes drilldown <run_id> <step_id>    [--rows 20]
    benny pypes rerun <run_id> --from <step>    (re-execute from step onward)
    benny pypes report <run_id> <report_id>     (re-render a single report)
    benny pypes registry                        (list registered operations)

Sandbox / agent extensions (do NOT alter the deterministic flow):
    benny pypes plan "<requirement>"            (LLM -> draft manifest)
    benny pypes agent-report <run_id>           (risk-analyst narrative on a prior run)
    benny pypes bench <m1> <m2> [...]           (head-to-head perf comparison)
    benny pypes model-bench <spec.json>         (cross-model planner/agent/QA: time/cost/tokens/accuracy/quality)
    benny pypes chat <run_id>                   (multi-turn risk-analyst REPL)
"""

from __future__ import annotations

import argparse
import io
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Rich imports – bundled with Benny's requirements
# ---------------------------------------------------------------------------
from rich import box
from rich.console import Console
from rich.live import Live
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text
from rich.theme import Theme

from .checkpoints import CheckpointStore
from .engines import available_engines, get_engine
from .models import EngineType, PypesManifest, RunReceipt
from .orchestrator import Orchestrator, load_manifest
from .registry import default_registry
from .reports import render_report

# ---------------------------------------------------------------------------
# Console singleton — force UTF-8 on Windows so box-drawing chars render
# ---------------------------------------------------------------------------
_THEME = Theme({
    "stage.bronze":  "bold #b45309",
    "stage.silver":  "bold #94a3b8",
    "stage.gold":    "bold #d97706",
    "status.pass":   "bold green",
    "status.fail":   "bold red",
    "status.warn":   "bold yellow",
    "status.skip":   "dim",
    "status.run":    "bold cyan",
    "clp":           "bold #818cf8",
    "muted":         "dim white",
    "accent":        "bold cyan",
})

def _make_console() -> Console:
    if sys.platform == "win32":
        try:
            utf8_stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace", line_buffering=True)
            return Console(file=utf8_stdout, theme=_THEME, highlight=False, force_terminal=True)
        except AttributeError:
            pass
    return Console(theme=_THEME, highlight=False)

console = _make_console()

# Stage → colour mapping
_STAGE_STYLE: Dict[str, str] = {
    "bronze": "stage.bronze",
    "silver": "stage.silver",
    "gold":   "stage.gold",
}

# Status → (icon, style)
_STATUS_ICON: Dict[str, tuple[str, str]] = {
    "PASS":    ("OK", "status.pass"),
    "SUCCESS": ("OK", "status.pass"),
    "REUSED":  ("~~", "status.skip"),
    "SKIPPED": ("~~", "status.skip"),
    "PARTIAL": ("!!", "status.warn"),
    "WARN":    ("!!", "status.warn"),
    "FAIL":    ("XX", "status.fail"),
    "FAILED":  ("XX", "status.fail"),
    "RUNNING": (">>" , "status.run"),
    "PENDING": ("--", "muted"),
}


def _status_text(status: str) -> Text:
    icon, style = _STATUS_ICON.get(status, ("?", "muted"))
    return Text(f" {icon} {status} ", style=style)


# ---------------------------------------------------------------------------
# Log capture — buffers pypes log records during Live displays so they don't
# tear up the table, then flushes them cleanly afterward.
# ---------------------------------------------------------------------------

class _BufferingLogHandler(logging.Handler):
    """Capture log records into a list; flush to Rich console on demand."""

    def __init__(self) -> None:
        super().__init__()
        self.records: List[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)

    def flush_to_console(self) -> None:
        for rec in self.records:
            level = rec.levelname
            style = {"WARNING": "yellow", "ERROR": "red", "CRITICAL": "bold red"}.get(level, "dim")
            console.print(f"[{style}][{level}][/{style}] [dim]{rec.name}:[/] {rec.getMessage()}")
        self.records.clear()


def _capture_pypes_logs() -> _BufferingLogHandler:
    """Attach a buffering handler to the benny.pypes root logger.

    Child loggers (orchestrator, engines, etc.) propagate up here by default,
    so one handler is enough — no double-emit. We also silence OpenLineage's
    transport startup chatter ("Couldn't find any OpenLineage transport...")
    because it bypasses our buffer otherwise.
    """
    # OpenLineage prints "Couldn't find any OpenLineage transport configuration..."
    # from openlineage.client.transport at WARNING level. Pin to ERROR so it stays quiet.
    for noisy in ("openlineage", "openlineage.client", "openlineage.client.transport"):
        logging.getLogger(noisy).setLevel(logging.ERROR)

    handler = _BufferingLogHandler()
    logging.getLogger("benny.pypes").addHandler(handler)
    return handler


def _release_pypes_logs(handler: _BufferingLogHandler) -> None:
    """Remove the buffering handler and flush any captured messages."""
    logging.getLogger("benny.pypes").removeHandler(handler)
    handler.flush_to_console()


# =============================================================================
# SUBPARSER
# =============================================================================


def add_subparser(sub: argparse._SubParsersAction) -> None:
    p = sub.add_parser(
        "pypes",
        help="Declarative transformation engine — turn Benny into a data plane",
        description=(
            "Benny Pypes runs manifest-driven, DAG-based transformations over "
            "tabular data. Inputs are declared, every step's output is "
            "checkpointed, and reports (financial risk, threshold breaches, "
            "move analysis) render with full CLP lineage."
        ),
    )
    pp = p.add_subparsers(dest="pypes_cmd", required=True)

    p_run = pp.add_parser("run", help="Execute a pypes manifest")
    p_run.add_argument("manifest", help="Path to a pypes manifest.json")
    p_run.add_argument("--workspace", default=None, help="Override manifest.workspace")
    p_run.add_argument("--resume", dest="resume_run_id", default=None)
    p_run.add_argument("--only", action="append", default=[], help="Only run the named step (repeatable)")
    p_run.add_argument("--var", action="append", default=[], help="Variable override key=value (repeatable)")
    p_run.add_argument("--json", action="store_true", help="Emit the RunReceipt as JSON (disables Rich UI)")

    p_inspect = pp.add_parser("inspect", help="Print the DAG and CLP summary for a manifest")
    p_inspect.add_argument("manifest", help="Path to a pypes manifest.json")

    p_runs = pp.add_parser("runs", help="List prior pypes runs in a workspace")
    # --workspace / --limit at the top level so `benny pypes runs --workspace W` works
    p_runs.add_argument("--workspace", default="default")
    p_runs.add_argument("--limit", type=int, default=20)
    p_runs.set_defaults(runs_cmd="ls")          # default sub-action is ls
    p_runs_sub = p_runs.add_subparsers(dest="runs_cmd")
    p_runs_ls = p_runs_sub.add_parser("ls")
    p_runs_ls.add_argument("--workspace", default=None, help="Override parent --workspace")
    p_runs_ls.add_argument("--limit", type=int, default=None, help="Override parent --limit")

    p_runs_show = p_runs_sub.add_parser("show")
    p_runs_show.add_argument("run_id")
    p_runs_show.add_argument("--workspace", default=None)

    p_drill = pp.add_parser("drilldown", help="Inspect a step's checkpoint with CLP annotations")
    p_drill.add_argument("run_id")
    p_drill.add_argument("step_id")
    p_drill.add_argument("--workspace", default="default")
    p_drill.add_argument("--rows", type=int, default=20)
    p_drill.add_argument("--json", action="store_true")

    p_rerun = pp.add_parser("rerun", help="Re-execute a prior run starting from a given step")
    p_rerun.add_argument("run_id")
    p_rerun.add_argument("--from", dest="from_step", required=True)
    p_rerun.add_argument("--workspace", default="default")
    p_rerun.add_argument("--json", action="store_true")

    p_report = pp.add_parser("report", help="Re-render a single report from a prior run")
    p_report.add_argument("run_id")
    p_report.add_argument("report_id")
    p_report.add_argument("--workspace", default="default")

    pp.add_parser("registry", help="List every registered operation")

    # ── plan: LLM-author a manifest from a plain-English requirement ─────────
    p_plan = pp.add_parser(
        "plan",
        help="LLM-generate a pypes manifest from a requirement (sandbox; does not run by default)",
    )
    p_plan.add_argument("requirement", help="Plain-English description of the pipeline you want")
    p_plan.add_argument("--workspace", default="default", help="Workspace to bake into the manifest")
    p_plan.add_argument("--model", default=None, help="Override LLM model id (defaults to BENNY_DEFAULT_MODEL or active local model)")
    p_plan.add_argument("--id", dest="manifest_id", default=None, help="Force a specific manifest id")
    p_plan.add_argument("--notes", default=None, help="Extra steering text appended to the prompt")
    p_plan.add_argument("--save", action="store_true", help="Persist the draft to manifests/drafts/<id>.json")
    p_plan.add_argument("--out", default=None, help="Explicit output path (overrides --save)")
    p_plan.add_argument("--run", action="store_true", help="Execute the draft immediately after generation")
    p_plan.add_argument("--json", action="store_true", help="Emit the draft as JSON to stdout (disables Rich UI)")
    p_plan.add_argument(
        "--strategy",
        choices=("auto", "oneshot", "incremental", "swarm"),
        default="auto",
        help="Planning strategy: oneshot (1 LLM call), incremental (multi-pass for small/local models), "
             "swarm (N models + Judge), auto (incremental for local/thinking models, oneshot otherwise).",
    )
    p_plan.add_argument(
        "--swarm-models",
        default=None,
        help="Comma-separated list of model ids for --strategy swarm (defaults to primary + 2 siblings).",
    )
    p_plan.add_argument(
        "--judge-model",
        default=None,
        help="Model id for the swarm Judge synthesis call (defaults to the primary model).",
    )

    # ── agent-report: risk-analyst persona narrative over a finished run ─────
    p_ar = pp.add_parser(
        "agent-report",
        help="Generate an agent-authored risk narrative from a completed pypes run (sandbox; advisory)",
    )
    p_ar.add_argument("run_id", help="Pypes run id (the part after 'pypes-' in the run folder)")
    p_ar.add_argument("--workspace", default="default")
    p_ar.add_argument("--model", default=None, help="Override LLM model id")
    p_ar.add_argument("--out", default=None, help="Path to write risk_narrative.md (defaults to runs/pypes-<id>/reports/)")

    # ── bench: head-to-head performance comparison ───────────────────────────
    p_bench = pp.add_parser(
        "bench",
        help="Run two or more manifests sequentially and compare wall time / CPU / RSS / cost",
    )
    p_bench.add_argument("manifests", nargs="+", help="Two or more manifest paths. Optionally prefix a label like 'pandas=path.json'.")
    p_bench.add_argument("--workspace", default=None, help="Force a workspace for every run")
    p_bench.add_argument("--repeats", type=int, default=1, help="Run each manifest N times; best wall time wins (default 1)")
    p_bench.add_argument("--sample-interval", type=float, default=0.05, help="Seconds between resource samples (default 0.05)")
    p_bench.add_argument("--json", action="store_true", help="Emit a JSON report to stdout (disables Rich UI)")

    # ── model-bench: cross-model planner / agent / chat-qa comparison ────────
    p_mb = pp.add_parser(
        "model-bench",
        help="Run the same task (plan / agent_report / chat_qa) through N LLMs and compare cost / time / tokens / accuracy / quality",
    )
    p_mb.add_argument("spec", help="Path to a model-comparison JSON spec (see manifests/templates/model_comparison_planner.json)")
    p_mb.add_argument("--workspace", default=None, help="Override the workspace baked into the spec")
    p_mb.add_argument("--repeats", type=int, default=None, help="Override spec.repeats")
    p_mb.add_argument("--judge", action="store_true", help="Force-enable the LLM judge even if the spec disabled it")
    p_mb.add_argument("--no-judge", action="store_true", help="Force-disable the LLM judge even if the spec enabled it")
    p_mb.add_argument("--json", action="store_true", help="Emit results JSON to stdout (disables Rich UI)")
    p_mb.add_argument("--save-report", default=None, help="Write a Markdown scorecard to the given path")

    # ── chat: multi-turn risk-analyst REPL ───────────────────────────────────
    p_chat = pp.add_parser(
        "chat",
        help="Open a multi-turn conversation with the risk-analyst agent over a finished run",
    )
    p_chat.add_argument("run_id", help="Pypes run id to load gold facts from")
    p_chat.add_argument("--workspace", default="default")
    p_chat.add_argument("--model", default=None, help="Override LLM model id")
    p_chat.add_argument("--system", default=None, help="Override system prompt entirely (advanced)")
    p_chat.add_argument("--max-history", type=int, default=20, help="Max prior turns to send back to the model (default 20)")


# =============================================================================
# DISPATCH
# =============================================================================


def cmd_pypes(args: argparse.Namespace) -> int:
    cmd = args.pypes_cmd
    if cmd == "run":
        return _cmd_run(args)
    if cmd == "inspect":
        return _cmd_inspect(args)
    if cmd == "runs":
        if args.runs_cmd == "ls":
            return _cmd_runs_ls(args)
        if args.runs_cmd == "show":
            return _cmd_runs_show(args)
    if cmd == "drilldown":
        return _cmd_drilldown(args)
    if cmd == "rerun":
        return _cmd_rerun(args)
    if cmd == "report":
        return _cmd_report(args)
    if cmd == "registry":
        return _cmd_registry(args)
    if cmd == "plan":
        return _cmd_plan(args)
    if cmd == "agent-report":
        return _cmd_agent_report(args)
    if cmd == "bench":
        return _cmd_bench(args)
    if cmd == "model-bench":
        return _cmd_model_bench(args)
    if cmd == "chat":
        return _cmd_chat(args)
    console.print(f"[bold red]unknown pypes subcommand:[/] {cmd}")
    return 1


# =============================================================================
# HANDLERS
# =============================================================================


def _cmd_run(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)
    if args.workspace:
        manifest.workspace = args.workspace
    variables = _parse_vars(args.var)

    if args.json:
        receipt = Orchestrator().run(
            manifest,
            variables=variables,
            resume_from_run_id=args.resume_run_id,
            only_steps=args.only or None,
        )
        print(receipt.model_dump_json(indent=2))
        return 0 if receipt.status != "FAILED" else 1

    # ── Opening header panel ────────────────────────────────────────────────
    _print_run_header(manifest, args)

    # ── Live progress execution ─────────────────────────────────────────────
    step_ids = [s.id for s in manifest.steps]
    step_status: Dict[str, str] = {sid: "PENDING" for sid in step_ids}
    step_rows:   Dict[str, Optional[int]] = {sid: None for sid in step_ids}
    step_ms:     Dict[str, Optional[float]] = {sid: None for sid in step_ids}
    step_checks: Dict[str, int] = {sid: 0 for sid in step_ids}

    def _build_live_table() -> Table:
        tbl = Table(
            box=box.ROUNDED, show_header=True,
            header_style="bold cyan", border_style="dim",
            expand=True,
        )
        tbl.add_column("Stage",    width=7,  justify="center")
        tbl.add_column("Step",     min_width=22, style="bold white")
        tbl.add_column("Status",   width=14, justify="center")
        tbl.add_column("Engine",   width=8,  justify="center", style="muted")
        tbl.add_column("Rows",     width=9,  justify="right")
        tbl.add_column("Checks",   width=9,  justify="center")
        tbl.add_column("Duration", width=10, justify="right", style="muted")
        for s in manifest.steps:
            st   = step_status[s.id]
            rows = step_rows[s.id]
            ms   = step_ms[s.id]
            fails = step_checks[s.id]

            stage_style = _STAGE_STYLE.get(s.stage.value, "white")
            stage_badge = Text(f" {s.stage.value.upper()} ", style=stage_style)

            status_cell = _status_text(st)

            rows_cell = Text(f"{rows:,}" if rows is not None else "-", style="white" if rows else "muted")
            chk_cell  = Text("-" if not fails else f"[red]{fails} fail[/]", style="muted") if not fails else Text(f"{fails} fail", style="bold red")
            dur_cell  = Text(f"{ms/1000:.2f}s" if ms is not None else "...", style="muted")

            tbl.add_row(stage_badge, s.id, status_cell, s.engine.value, rows_cell, chk_cell, dur_cell)
        return tbl

    console.print()
    receipt: Optional[RunReceipt] = None

    # Capture pypes log output so it doesn't tear up the live table
    _log_handler = _capture_pypes_logs()

    with Live(console=console, refresh_per_second=10, transient=False) as live:
        def _tick(sid: str, status: str, rows: Optional[int] = None, ms: Optional[float] = None, fails: int = 0) -> None:
            step_status[sid] = status
            if rows is not None:
                step_rows[sid] = rows
            if ms is not None:
                step_ms[sid] = ms
            step_checks[sid] = fails
            live.update(_build_live_table())

        live.update(_build_live_table())
        orch = Orchestrator()
        receipt = _run_with_progress(orch, manifest, variables, args.resume_run_id, args.only or None, _tick)
        live.update(_build_live_table())

    # Release log handler and flush any captured warnings below the table
    _release_pypes_logs(_log_handler)

    # ── Final summary ───────────────────────────────────────────────────────
    console.print()
    _print_receipt_panel(receipt)
    return 0 if receipt.status != "FAILED" else 1


def _run_with_progress(
    orch: Orchestrator,
    manifest: PypesManifest,
    variables: Dict[str, Any],
    resume_run_id: Optional[str],
    only_steps: Optional[List[str]],
    tick: Any,
) -> RunReceipt:
    """Run the orchestrator while streaming step-level status to the live table."""
    from .orchestrator import _topological_order

    step_map = {s.id: s for s in manifest.steps}
    order = _topological_order(manifest.steps)
    if only_steps:
        order = [sid for sid in order if sid in only_steps]

    # Mark active steps as RUNNING before handing off to orchestrator
    for sid in order:
        tick(sid, "RUNNING")

    t0 = time.monotonic()
    receipt = orch.run(
        manifest,
        variables=variables,
        resume_from_run_id=resume_run_id,
        only_steps=only_steps,
    )
    total_ms = (time.monotonic() - t0) * 1000

    # Update from receipt
    for sid, vr in receipt.step_results.items():
        fails = sum(1 for c in (vr.checks or []) if c.get("status") == "FAILED")
        tick(sid, vr.status, rows=vr.row_count, ms=total_ms / max(len(receipt.step_results), 1), fails=fails)

    return receipt


def _cmd_inspect(args: argparse.Namespace) -> int:
    manifest = load_manifest(args.manifest)

    # ── Header ──────────────────────────────────────────────────────────────
    compliance = "  ·  ".join(manifest.governance.compliance_tags or []) or "none"
    console.print()
    console.print(Panel.fit(
        f"[bold white]Manifest[/]    [accent]{manifest.id}[/]  [muted]v{manifest.schema_version}[/]\n"
        f"[bold white]Name[/]        [white]{manifest.name}[/]\n"
        f"[bold white]Workspace[/]   [accent]{manifest.workspace}[/]\n"
        f"[bold white]Compliance[/]  [muted]{compliance}[/]",
        title="[bold cyan]  Benny Pypes — Manifest Inspection [/]",
        border_style="cyan",
        padding=(0, 2),
    ))
    console.print()

    # ── DAG table ────────────────────────────────────────────────────────────
    producers: Dict[str, str] = {}
    for s in manifest.steps:
        for o in s.outputs or [s.id]:
            producers[o] = s.id

    dag_tbl = Table(
        box=box.ROUNDED, show_header=True, header_style="bold cyan",
        border_style="dim", expand=True, title="[bold]Pipeline DAG[/]",
    )
    dag_tbl.add_column("Stage",   width=8,  justify="center")
    dag_tbl.add_column("Step ID", min_width=20, style="bold white")
    dag_tbl.add_column("Engine",  width=9,  justify="center")
    dag_tbl.add_column("Dependencies", ratio=1, style="muted")
    dag_tbl.add_column("Operations",   ratio=2)

    for s in manifest.steps:
        deps = sorted({producers[n] for n in s.inputs if n in producers})
        dep_text = Text(" -> ".join(deps) if deps else "[source]", style="muted" if not deps else "white")
        ops_text = Text(", ".join(o.operation for o in s.operations) or (s.sub_manifest_uri or "passthrough"))
        stage_style = _STAGE_STYLE.get(s.stage.value, "white")
        dag_tbl.add_row(
            Text(f" {s.stage.value.upper()} ", style=stage_style),
            s.id, s.engine.value, dep_text, ops_text,
        )
    console.print(dag_tbl)

    # ── CLP meta-model ───────────────────────────────────────────────────────
    if manifest.clp and (manifest.clp.conceptual or manifest.clp.logical):
        console.print()
        clp_tbl = Table(
            box=box.SIMPLE, show_header=True, header_style="clp",
            border_style="dim", expand=True, title="[clp]CLP Meta-Model[/]",
        )
        clp_tbl.add_column("Layer",  width=12)
        clp_tbl.add_column("Entity / Field", min_width=22)
        clp_tbl.add_column("Type",   width=12)
        clp_tbl.add_column("Details", ratio=1, style="muted")

        for c in manifest.clp.conceptual:
            tags = f"[{', '.join(c.compliance_tags)}]" if c.compliance_tags else ""
            clp_tbl.add_row(
                Text(" CONCEPTUAL", style="clp"),
                Text(c.name, style="bold white"),
                Text("concept"),
                Text(tags, style="muted"),
            )
        for l in manifest.clp.logical:
            for f in l.fields:
                details = f"required={f.required}"
                if f.threshold:
                    details += f"  threshold={f.threshold}"
                clp_tbl.add_row(
                    Text("  LOGICAL", style="bold #a5b4fc"),
                    Text(f"{l.entity}.{f.name}", style="white"),
                    Text(f.type, style="muted"),
                    Text(details, style="muted"),
                )
        console.print(clp_tbl)

    # ── Reports ──────────────────────────────────────────────────────────────
    if manifest.reports:
        console.print()
        rep_tbl = Table(
            box=box.SIMPLE, show_header=True, header_style="bold cyan",
            border_style="dim", expand=True, title="[bold]Reports[/]",
        )
        rep_tbl.add_column("Report ID",    min_width=22, style="bold white")
        rep_tbl.add_column("Kind",         width=20)
        rep_tbl.add_column("Source Step",  width=20, style="muted")
        rep_tbl.add_column("Format",       width=8,  justify="center")
        for r in manifest.reports:
            rep_tbl.add_row(r.id, r.kind, r.source_step, r.format)
        console.print(rep_tbl)

    console.print()
    return 0


def _cmd_runs_ls(args: argparse.Namespace) -> int:
    # Sub-parser overrides parent; fall back to parent-level values when None
    workspace = getattr(args, "workspace", None) or "default"
    limit     = getattr(args, "limit",     None) or 20
    ws_root   = _workspace_root(workspace)
    runs_dir  = ws_root / "runs"

    console.print()
    console.print(Rule(f"[bold cyan] Pypes Run History — workspace: {workspace} [/]"))
    console.print()

    if not runs_dir.exists():
        console.print("  [muted](no runs found)[/]")
        console.print()
        return 0

    entries = sorted(runs_dir.glob("pypes-*"), key=lambda p: p.stat().st_mtime, reverse=True)
    entries = entries[:limit]

    tbl = Table(
        box=box.ROUNDED, show_header=True, header_style="bold cyan",
        border_style="dim", expand=True,
    )
    tbl.add_column("Run ID",        min_width=18, style="bold white")
    tbl.add_column("Manifest",      min_width=26)
    tbl.add_column("Status",        width=12, justify="center")
    tbl.add_column("Steps",         width=7,  justify="right")
    tbl.add_column("Duration",      width=10, justify="right", style="muted")
    tbl.add_column("Started",       width=24, style="muted")

    for run_dir in entries:
        receipt_path = run_dir / "receipt.json"
        if not receipt_path.exists():
            continue
        try:
            r = json.loads(receipt_path.read_text(encoding="utf-8"))
        except Exception:
            continue
        run_id   = r.get("run_id", run_dir.name.replace("pypes-", ""))
        status   = r.get("status", "?")
        duration = r.get("duration_ms")
        dur_text = f"{duration/1000:.2f}s" if duration else "-"
        tbl.add_row(
            run_id,
            r.get("manifest_id", ""),
            _status_text(status),
            str(len(r.get("step_results", {}))),
            dur_text,
            r.get("started_at", ""),
        )

    console.print(tbl)
    console.print()
    return 0


def _cmd_runs_show(args: argparse.Namespace) -> int:
    workspace    = getattr(args, "workspace", None) or "default"
    receipt_path = _workspace_root(workspace) / "runs" / f"pypes-{args.run_id}" / "receipt.json"
    if not receipt_path.exists():
        console.print(f"[bold red]Run not found:[/] {args.run_id}")
        return 1
    try:
        receipt = RunReceipt.model_validate_json(receipt_path.read_text(encoding="utf-8"))
    except Exception:
        console.print(receipt_path.read_text(encoding="utf-8"))
        return 0
    _print_receipt_panel(receipt)
    return 0


def _cmd_drilldown(args: argparse.Namespace) -> int:
    ws_root = _workspace_root(args.workspace)
    run_dir = ws_root / "runs" / f"pypes-{args.run_id}"
    if not run_dir.exists():
        console.print(f"[bold red]Run not found:[/] {args.run_id}")
        return 1
    store = CheckpointStore(run_dir)
    if not store.has(args.step_id):
        console.print(f"[bold red]No checkpoint for step[/] '{args.step_id}' in run {args.run_id}")
        return 1
    manifest = _load_run_manifest(run_dir)
    step = manifest.step(args.step_id) if manifest else None

    engine = get_engine(EngineType.PANDAS)
    df = store.read(engine, args.step_id)
    row_count = engine.row_count(df)
    columns = engine.columns(df)
    rows = engine.to_records(df, limit=args.rows)

    if args.json:
        print(json.dumps({
            "run_id":      args.run_id,
            "step_id":     args.step_id,
            "row_count":   row_count,
            "columns":     columns,
            "clp_binding": (step.clp_binding if step else {}) or {},
            "rows":        rows,
        }, indent=2, default=str))
        return 0

    # ── Header ───────────────────────────────────────────────────────────────
    step_stage = step.stage.value.upper() if step else "?"
    stage_style = _STAGE_STYLE.get(step.stage.value, "white") if step else "white"

    console.print()
    console.print(Panel.fit(
        f"[bold white]Run ID[/]    [accent]{args.run_id}[/]\n"
        f"[bold white]Step[/]      [bold white]{args.step_id}[/]  "
        f"[{stage_style}] {step_stage} [/{stage_style}]\n"
        f"[bold white]Rows[/]      [white]{row_count:,}[/]  "
        f"[muted]({len(columns)} columns, showing {min(args.rows, row_count)})[/]",
        title="[bold cyan]  Pypes — Step Drilldown [/]",
        border_style="cyan",
        padding=(0, 2),
    ))
    console.print()

    # ── CLP binding ──────────────────────────────────────────────────────────
    if step and step.clp_binding:
        clp_tbl = Table(box=box.SIMPLE, show_header=True, header_style="clp",
                        border_style="dim", expand=False)
        clp_tbl.add_column("Column",      min_width=22, style="bold white")
        clp_tbl.add_column("CLP Binding", min_width=32, style="clp")
        for col, ref in step.clp_binding.items():
            clp_tbl.add_row(col, ref)
        console.print(Panel(clp_tbl, title="[clp] CLP Lineage Binding [/]",
                            border_style="dim #818cf8", padding=(0, 1)))
        console.print()

    # ── Data table ───────────────────────────────────────────────────────────
    data_tbl = Table(
        box=box.SIMPLE_HEAD, show_header=True,
        header_style="bold cyan", border_style="dim",
        expand=True,
    )
    for col in columns:
        data_tbl.add_column(col, no_wrap=True, min_width=max(len(col), 8))
    for row in rows:
        data_tbl.add_row(*[str(row.get(c, "")) for c in columns])

    console.print(Panel(data_tbl, title=f"[bold] Checkpoint Data — {args.step_id} [/]",
                        border_style="dim", padding=(0, 1)))
    console.print()
    return 0


def _cmd_rerun(args: argparse.Namespace) -> int:
    ws_root = _workspace_root(args.workspace)
    run_dir = ws_root / "runs" / f"pypes-{args.run_id}"
    manifest = _load_run_manifest(run_dir)
    if manifest is None:
        console.print(f"[bold red]Cannot load manifest snapshot from run[/] {args.run_id}")
        return 1

    # Compute steps to re-execute: ``from_step`` and all downstream
    producers: Dict[str, str] = {}
    for s in manifest.steps:
        for o in s.outputs or [s.id]:
            producers[o] = s.id
    reverse: Dict[str, List[str]] = {s.id: [] for s in manifest.steps}
    for s in manifest.steps:
        for name in s.inputs:
            prod = producers.get(name)
            if prod and prod != s.id:
                reverse.setdefault(prod, []).append(s.id)

    only: List[str] = []
    stack = [args.from_step]
    while stack:
        cur = stack.pop()
        if cur in only:
            continue
        only.append(cur)
        stack.extend(reverse.get(cur, []))

    console.print()
    console.print(Panel.fit(
        f"[bold white]Prior Run[/]   [accent]{args.run_id}[/]\n"
        f"[bold white]Resume from[/] [bold white]{args.from_step}[/]\n"
        f"[bold white]Replay[/]      [white]{' -> '.join(only)}[/]",
        title="[bold cyan]  Benny Pypes — Rerun [/]",
        border_style="cyan",
        padding=(0, 2),
    ))
    console.print()

    if args.json:
        receipt = Orchestrator(workspace_root=ws_root).run(
            manifest,
            resume_from_run_id=args.run_id,
            only_steps=only,
        )
        print(receipt.model_dump_json(indent=2))
        return 0 if receipt.status != "FAILED" else 1

    # Live progress (reuse run logic)
    step_status: Dict[str, str] = {s.id: "PENDING" for s in manifest.steps}
    step_rows:   Dict[str, Optional[int]] = {s.id: None for s in manifest.steps}
    step_ms:     Dict[str, Optional[float]] = {s.id: None for s in manifest.steps}
    step_checks: Dict[str, int] = {s.id: 0 for s in manifest.steps}

    for sid in only:
        step_status[sid] = "RUNNING"

    def _build_live_table() -> Table:
        tbl = Table(box=box.ROUNDED, show_header=True, header_style="bold cyan",
                    border_style="dim", expand=True)
        tbl.add_column("Stage",    width=7,  justify="center")
        tbl.add_column("Step",     min_width=22, style="bold white")
        tbl.add_column("Status",   width=14, justify="center")
        tbl.add_column("Rows",     width=9,  justify="right")
        tbl.add_column("Duration", width=10, justify="right", style="muted")
        for s in manifest.steps:
            st   = step_status[s.id]
            rows = step_rows[s.id]
            ms   = step_ms[s.id]
            stage_style = _STAGE_STYLE.get(s.stage.value, "white")
            tbl.add_row(
                Text(f" {s.stage.value.upper()} ", style=stage_style),
                s.id, _status_text(st),
                Text(f"{rows:,}" if rows is not None else "-", style="muted"),
                Text(f"{ms/1000:.2f}s" if ms is not None else "...", style="muted"),
            )
        return tbl

    _log_handler = _capture_pypes_logs()

    with Live(console=console, refresh_per_second=10) as live:
        live.update(_build_live_table())
        orch = Orchestrator(workspace_root=ws_root)
        receipt = orch.run(manifest, resume_from_run_id=args.run_id, only_steps=only)
        total_ms = receipt.duration_ms or 1
        for sid, vr in receipt.step_results.items():
            fails = sum(1 for c in (vr.checks or []) if c.get("status") == "FAILED")
            step_status[sid] = vr.status
            step_rows[sid] = vr.row_count
            step_ms[sid] = total_ms / max(len(receipt.step_results), 1)
            step_checks[sid] = fails
        live.update(_build_live_table())

    _release_pypes_logs(_log_handler)

    console.print()
    _print_receipt_panel(receipt)
    return 0 if receipt.status != "FAILED" else 1


def _cmd_report(args: argparse.Namespace) -> int:
    ws_root = _workspace_root(args.workspace)
    run_dir = ws_root / "runs" / f"pypes-{args.run_id}"
    if not run_dir.exists():
        console.print(f"[bold red]Run not found:[/] {args.run_id}")
        return 1
    manifest = _load_run_manifest(run_dir)
    if manifest is None:
        console.print("[bold red]Cannot load manifest snapshot[/]")
        return 1
    report = manifest.report(args.report_id)
    if report is None:
        console.print(f"[bold red]Report[/] '{args.report_id}' [bold red]not declared in manifest[/]")
        return 1
    receipt_path = run_dir / "receipt.json"
    receipt = RunReceipt.model_validate_json(receipt_path.read_text(encoding="utf-8"))
    store = CheckpointStore(run_dir)

    with console.status(f"[cyan]Rendering report[/] [bold white]{args.report_id}[/]..."):
        path = render_report(
            engine=get_engine(EngineType.PANDAS),
            manifest=manifest,
            spec=report,
            store=store,
            receipt=receipt,
        )

    console.print()
    console.print(Panel.fit(
        f"[bold white]Report[/]   [accent]{args.report_id}[/]  [muted]({report.kind})[/]\n"
        f"[bold white]Written[/]  [link=file://{path}]{path}[/link]",
        title="[bold green]  Report Written [OK] [/]",
        border_style="green",
        padding=(0, 2),
    ))
    console.print()
    return 0


def _cmd_registry(args: argparse.Namespace) -> int:
    engines = available_engines()
    ops = list(default_registry.names())

    console.print()
    console.print(Rule("[bold cyan] Benny Pypes — Registry [/]"))
    console.print()

    # Engines panel
    eng_tbl = Table(box=box.SIMPLE, show_header=False, border_style="dim", expand=False)
    eng_tbl.add_column("", style="bold cyan", width=3)
    eng_tbl.add_column("Engine", style="bold white")
    for e in engines:
        eng_tbl.add_row(">>", e)
    console.print(Panel(eng_tbl, title="[accent] Available Engines [/]",
                        border_style="dim cyan", padding=(0, 1)))
    console.print()

    # Operations panel
    ops_per_row = 3
    ops_tbl = Table(box=box.SIMPLE, show_header=False, border_style="dim", expand=True)
    for _ in range(ops_per_row):
        ops_tbl.add_column("", style="white", ratio=1)
    for i in range(0, len(ops), ops_per_row):
        chunk = ops[i:i + ops_per_row]
        while len(chunk) < ops_per_row:
            chunk.append("")
        ops_tbl.add_row(*[f"[dim]>>[/] {op}" if op else "" for op in chunk])
    console.print(Panel(ops_tbl, title="[accent] Registered Operations [/]",
                        border_style="dim cyan", padding=(0, 1)))
    console.print()
    return 0


# =============================================================================
# RICH RECEIPT PANEL
# =============================================================================


def _print_run_header(manifest: PypesManifest, args: argparse.Namespace) -> None:
    resume_line = f"\n[bold white]Resume[/]     [accent]{args.resume_run_id}[/]" if getattr(args, "resume_run_id", None) else ""
    only_line   = f"\n[bold white]Only[/]       [white]{', '.join(args.only)}[/]" if getattr(args, "only", None) else ""
    console.print(Panel.fit(
        f"[bold white]Manifest[/]   [accent]{manifest.id}[/]  [muted]v{manifest.schema_version}[/]\n"
        f"[bold white]Name[/]       [white]{manifest.name}[/]\n"
        f"[bold white]Workspace[/]  [accent]{manifest.workspace}[/]\n"
        f"[bold white]Steps[/]      [white]{len(manifest.steps)}[/]  "
        f"[muted]bronze={sum(1 for s in manifest.steps if s.stage.value=='bronze')}  "
        f"silver={sum(1 for s in manifest.steps if s.stage.value=='silver')}  "
        f"gold={sum(1 for s in manifest.steps if s.stage.value=='gold')}[/]"
        f"{resume_line}{only_line}",
        title="[bold cyan]  Benny Pypes — Transformation Engine [/]",
        border_style="cyan",
        padding=(0, 2),
    ))


def _print_receipt_panel(receipt: RunReceipt) -> None:
    ok = receipt.status not in ("FAILED", "FAIL")
    status_text = _status_text(receipt.status)
    dur = f"{receipt.duration_ms/1000:.2f}s" if receipt.duration_ms else "-"

    # ── Step results table ───────────────────────────────────────────────────
    step_tbl = Table(box=box.SIMPLE, show_header=True, header_style="bold cyan",
                     border_style="dim", expand=True)
    step_tbl.add_column("Step",          min_width=22, style="bold white")
    step_tbl.add_column("Status",        width=12, justify="center")
    step_tbl.add_column("Rows",          width=9,  justify="right")
    step_tbl.add_column("Columns",       width=8,  justify="right", style="muted")
    step_tbl.add_column("Failed Checks", width=14, justify="center")

    for sid, vr in receipt.step_results.items():
        fails = sum(1 for c in (vr.checks or []) if c.get("status") == "FAILED")
        chk_cell = Text("-", style="muted") if not fails else Text(f"!! {fails}", style="bold red")
        step_tbl.add_row(
            sid,
            _status_text(vr.status),
            Text(f"{vr.row_count:,}" if vr.row_count is not None else "-"),
            Text(str(vr.column_count) if vr.column_count else "-"),
            chk_cell,
        )

    border = "green" if ok else "red"
    icon   = "Complete" if ok else "Failed"
    title  = f"[bold {'green' if ok else 'red'}]  Run {icon} [/]"

    # Print the summary panel
    console.print(Panel(
        step_tbl,
        title=title,
        subtitle=f"[muted]run {receipt.run_id}  ·  {dur}[/]",
        border_style=border,
        padding=(0, 1),
    ))

    if receipt.reports:
        console.print()
        rep_tbl = Table(box=box.SIMPLE, show_header=False, border_style="dim", expand=False)
        rep_tbl.add_column("", style="bold green", width=3)
        rep_tbl.add_column("Report", min_width=22, style="bold white")
        rep_tbl.add_column("Path", style="dim cyan")
        for rid, path in receipt.reports.items():
            rep_tbl.add_row("[cyan]>>[/]", rid, str(path))
        console.print(Panel(rep_tbl, title="[bold] Reports Written [/]",
                            border_style="dim green", padding=(0, 1)))

    if receipt.errors:
        console.print()
        console.print(Panel(
            "\n".join(f"[red]XX[/]  {e}" for e in receipt.errors),
            title="[bold red] Errors [/]",
            border_style="red",
            padding=(0, 1),
        ))

    console.print()


# =============================================================================
# SANDBOX EXTENSIONS — planner + agent-report
#
# Both commands sit OUTSIDE the deterministic flow. The declarative pipeline
# (run/inspect/rerun/report) remains the source of truth. ``plan`` only emits
# a draft manifest the user reviews; ``agent-report`` only reads finished gold
# artifacts and writes a separate narrative file. Neither can mutate run data.
# =============================================================================


def _cmd_plan(args: argparse.Namespace) -> int:
    from .planner import plan_pypes_manifest

    swarm_models: Optional[List[str]] = None
    if getattr(args, "swarm_models", None):
        swarm_models = [m.strip() for m in args.swarm_models.split(",") if m.strip()]
    judge_model = getattr(args, "judge_model", None)
    strategy = getattr(args, "strategy", "auto")

    plan_kwargs = dict(
        requirement=args.requirement,
        workspace=args.workspace,
        model=args.model,
        strategy=strategy,
        swarm_models=swarm_models,
        judge_model=judge_model,
        manifest_id=args.manifest_id,
        extra_notes=args.notes,
    )

    # ── Header ───────────────────────────────────────────────────────────────
    if not args.json:
        console.print()
        console.print(Panel.fit(
            f"[bold white]Requirement[/]\n[white]{args.requirement}[/]\n\n"
            f"[bold white]Workspace[/]   [accent]{args.workspace}[/]\n"
            f"[bold white]Model[/]       [accent]{args.model or 'auto'}[/]\n"
            f"[bold white]Strategy[/]    [accent]{strategy}[/]"
            + (f"  [muted]swarm={','.join(swarm_models)}[/]" if swarm_models else "")
            + (f"  [muted]judge={judge_model}[/]" if judge_model else "")
            + "\n"
            f"[bold white]Mode[/]        [muted]sandbox  ·  draft only (no execution unless --run)[/]",
            title="[bold cyan]  Benny Pypes — Planner [/]",
            border_style="cyan",
            padding=(0, 2),
        ))
        console.print()

    # ── LLM call ─────────────────────────────────────────────────────────────
    try:
        if args.json:
            manifest, meta = plan_pypes_manifest(**plan_kwargs)
        else:
            spinner_label = {
                "oneshot":     "Calling LLM to draft manifest...",
                "incremental": "Authoring manifest incrementally (outline -> CLP -> steps -> reports -> validate)...",
                "swarm":       "Running swarm of models + Judge synthesis...",
                "auto":        "Calling LLM to draft manifest...",
            }.get(strategy, "Calling LLM to draft manifest...")
            with console.status(f"[cyan]{spinner_label}[/]", spinner="dots"):
                manifest, meta = plan_pypes_manifest(**plan_kwargs)
    except Exception as exc:
        console.print(Panel(
            f"[red]{exc}[/]",
            title="[bold red] Planner Failed [/]",
            border_style="red",
            padding=(0, 1),
        ))
        return 1

    # ── JSON mode: dump and exit ─────────────────────────────────────────────
    if args.json:
        print(manifest.model_dump_json(indent=2))
        return 0

    # ── Render the draft summary panel ───────────────────────────────────────
    bronze = sum(1 for s in manifest.steps if s.stage.value == "bronze")
    silver = sum(1 for s in manifest.steps if s.stage.value == "silver")
    gold   = sum(1 for s in manifest.steps if s.stage.value == "gold")

    strategy_used = meta.get("strategy", "?")
    strategy_detail = ""
    if strategy_used == "incremental":
        st = meta.get("stages") or {}
        strategy_detail = (
            f"  [muted]outline_steps={st.get('outline_steps','?')}  "
            f"clp_entities={st.get('clp_entities','?')}  "
            f"steps_expanded={st.get('steps_expanded','?')}  "
            f"reports={st.get('reports','?')}  "
            f"repair_iters={st.get('repair_iterations',0)}[/]"
        )
    elif strategy_used == "swarm":
        strategy_detail = (
            f"  [muted]drafts={meta.get('swarm_drafts','?')}  "
            f"failures={len(meta.get('swarm_failures', []))}  "
            f"judge={meta.get('judge') or 'n/a'}[/]"
        )

    console.print(Panel.fit(
        f"[bold white]Draft id[/]    [accent]{manifest.id}[/]\n"
        f"[bold white]Name[/]        [white]{manifest.name}[/]\n"
        f"[bold white]Steps[/]       [white]{len(manifest.steps)}[/]  "
        f"[muted]bronze={bronze}  silver={silver}  gold={gold}[/]\n"
        f"[bold white]Reports[/]     [white]{len(manifest.reports)}[/]\n"
        f"[bold white]Strategy[/]    [accent]{strategy_used}[/]{strategy_detail}\n"
        f"[bold white]Resolved model[/] [muted]{meta.get('model')}[/]",
        title="[bold green]  Draft Manifest [/]",
        border_style="green",
        padding=(0, 2),
    ))
    console.print()

    # Compact step table
    step_tbl = Table(box=box.ROUNDED, show_header=True, header_style="bold cyan",
                     border_style="dim", expand=True, title="[bold]Generated Pipeline DAG[/]")
    step_tbl.add_column("Stage",   width=8,  justify="center")
    step_tbl.add_column("Step ID", min_width=22, style="bold white")
    step_tbl.add_column("Engine",  width=8,  justify="center", style="muted")
    step_tbl.add_column("Inputs",  ratio=1,  style="muted")
    step_tbl.add_column("Outputs", ratio=1)
    for s in manifest.steps:
        stage_style = _STAGE_STYLE.get(s.stage.value, "white")
        step_tbl.add_row(
            Text(f" {s.stage.value.upper()} ", style=stage_style),
            s.id, s.engine.value,
            ", ".join(s.inputs) if s.inputs else "[source]",
            ", ".join(s.outputs) if s.outputs else "-",
        )
    console.print(step_tbl)

    # ── Persistence ──────────────────────────────────────────────────────────
    out_path: Optional[Path] = None
    if args.out:
        out_path = Path(args.out)
    elif args.save:
        drafts_dir = Path.cwd() / "manifests" / "drafts"
        drafts_dir.mkdir(parents=True, exist_ok=True)
        out_path = drafts_dir / f"{manifest.id}.json"

    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
        console.print()
        console.print(Panel.fit(
            f"[bold white]Saved draft[/]  [link=file://{out_path}]{out_path}[/link]",
            title="[bold green]  Persisted [/]",
            border_style="green",
            padding=(0, 2),
        ))

    # ── Optional immediate run ───────────────────────────────────────────────
    if args.run:
        console.print()
        console.print(Rule("[bold cyan] Executing draft manifest [/]"))
        run_args = argparse.Namespace(
            manifest=str(out_path) if out_path else None,
            workspace=args.workspace,
            resume_run_id=None,
            only=[],
            var=[],
            json=False,
        )
        # If the caller didn't ask to save, materialise a temp file so the
        # orchestrator's manifest snapshot path stays intact.
        if not out_path:
            tmp_dir = Path.cwd() / "manifests" / "drafts"
            tmp_dir.mkdir(parents=True, exist_ok=True)
            tmp_path = tmp_dir / f"{manifest.id}.json"
            tmp_path.write_text(manifest.model_dump_json(indent=2), encoding="utf-8")
            run_args.manifest = str(tmp_path)
            console.print(f"[muted](draft persisted to {tmp_path} for execution)[/]")
        return _cmd_run(run_args)

    console.print()
    console.print("[muted]Tip: re-run with [/][accent]--run[/][muted] to execute, or pass the saved file to[/] [accent]benny pypes run[/]")
    console.print()
    return 0


def _cmd_agent_report(args: argparse.Namespace) -> int:
    from .agent_report import RiskAnalystAgent, generate_risk_narrative

    ws_root = _workspace_root(args.workspace)
    run_dir = ws_root / "runs" / f"pypes-{args.run_id}"
    if not run_dir.exists():
        console.print(f"[bold red]Run not found:[/] {args.run_id}  [muted](looked in {run_dir})[/]")
        return 1

    agent = RiskAnalystAgent()

    console.print()
    console.print(Panel.fit(
        f"[bold white]Run[/]         [accent]{args.run_id}[/]\n"
        f"[bold white]Workspace[/]   [accent]{args.workspace}[/]\n"
        f"[bold white]Agent[/]       [accent]{agent.name}[/]  [muted](v2 sandbox; advisory only)[/]\n"
        f"[bold white]Skills[/]      [muted]{', '.join(agent.skills[:4])}...[/]",
        title="[bold cyan]  Benny Pypes — Agent Risk Report (v2) [/]",
        border_style="cyan",
        padding=(0, 2),
    ))
    console.print()

    out_path = Path(args.out) if args.out else None
    try:
        with console.status("[cyan]Risk-analyst agent reasoning over gold artifacts...[/]", spinner="dots"):
            markdown, written, meta = generate_risk_narrative(
                workspace_root=ws_root,
                run_id=args.run_id,
                model=args.model,
                agent=agent,
                out_path=out_path,
            )
    except Exception as exc:
        console.print(Panel(
            f"[red]{exc}[/]",
            title="[bold red] Agent Report Failed [/]",
            border_style="red",
            padding=(0, 1),
        ))
        return 1

    # Compact preview (first 2k chars) so the user sees the narrative inline
    preview = markdown if len(markdown) <= 2400 else markdown[:2400] + "\n\n... [truncated — full narrative in file]"
    console.print(Panel(
        preview,
        title=f"[bold green]  Risk Narrative — preview [/]",
        border_style="green",
        padding=(1, 2),
    ))

    console.print()
    console.print(Panel.fit(
        f"[bold white]Written[/]   [link=file://{written}]{written}[/link]\n"
        f"[bold white]Model[/]     [muted]{meta.get('model')}[/]\n"
        f"[bold white]Tables[/]    [muted]{', '.join(meta.get('tables_consumed', []))}[/]",
        title="[bold green]  Narrative Saved [/]",
        border_style="green",
        padding=(0, 2),
    ))
    console.print()
    return 0


def _cmd_bench(args: argparse.Namespace) -> int:
    from .bench import parity_diff, run_bench, speedup_vs

    # Parse "label=path" or bare path (auto-label from filename stem).
    pairs: List[tuple] = []
    seen_labels: set = set()
    for item in args.manifests:
        if "=" in item:
            label, path = item.split("=", 1)
        else:
            path = item
            label = Path(path).stem
        # Disambiguate duplicates so the comparison table stays readable.
        base = label
        n = 2
        while label in seen_labels:
            label = f"{base}-{n}"
            n += 1
        seen_labels.add(label)
        pairs.append((label, path))

    if len(pairs) < 2:
        console.print("[bold red]bench requires at least two manifests[/]")
        return 2

    if not args.json:
        console.print()
        console.print(Panel.fit(
            f"[bold white]Manifests[/]   [white]{len(pairs)}[/]  [muted]({', '.join(p[0] for p in pairs)})[/]\n"
            f"[bold white]Workspace[/]   [accent]{args.workspace or '(per-manifest)'}[/]\n"
            f"[bold white]Repeats[/]     [white]{args.repeats}[/]  [muted](best wall time per label wins)[/]\n"
            f"[bold white]Sampler[/]     [muted]{args.sample_interval}s interval, psutil RSS+CPU[/]",
            title="[bold cyan]  Benny Pypes — Performance Bench [/]",
            border_style="cyan",
            padding=(0, 2),
        ))
        console.print()

    # Capture pypes log noise so per-run output doesn't tear up the report.
    _log_handler = _capture_pypes_logs()
    try:
        if args.json:
            results = run_bench(pairs, workspace=args.workspace, repeats=args.repeats,
                                sample_interval=args.sample_interval)
        else:
            with console.status("[cyan]Running benchmarks...[/]", spinner="dots"):
                results = run_bench(pairs, workspace=args.workspace, repeats=args.repeats,
                                    sample_interval=args.sample_interval)
    finally:
        _release_pypes_logs(_log_handler)

    if args.json:
        import json as _json
        payload = []
        for r in results:
            payload.append({
                "label": r.label, "manifest_id": r.manifest_id, "engine": r.engine,
                "status": r.status, "wall_seconds": r.wall_seconds,
                "cpu_seconds": r.cpu_seconds, "cpu_percent_mean": r.cpu_percent_mean,
                "cpu_percent_max": r.cpu_percent_max, "rss_mb_baseline": r.rss_mb_baseline,
                "rss_mb_peak": r.rss_mb_peak, "rss_mb_delta": r.rss_mb_delta,
                "samples": r.samples, "cost_usd": r.cost_usd,
                "total_rows": r.total_rows, "error": r.error,
            })
        print(_json.dumps(payload, indent=2))
        return 0 if all(r.status != "FAILED" for r in results) else 1

    # ── Headline comparison table ───────────────────────────────────────────
    fastest = min(results, key=lambda r: r.wall_seconds if not r.error else float("inf"))
    cheapest = min(results, key=lambda r: r.cost_usd if not r.error else float("inf"))
    smallest = min(results, key=lambda r: r.rss_mb_peak if not r.error else float("inf"))

    bench_tbl = Table(box=box.ROUNDED, show_header=True, header_style="bold cyan",
                      border_style="dim", expand=False, title="[bold]Head-to-Head Results[/]",
                      pad_edge=False)
    bench_tbl.add_column("Label",       min_width=10, style="bold white")
    bench_tbl.add_column("Engine",      min_width=7,  justify="center", style="muted")
    bench_tbl.add_column("Status",      min_width=10, justify="center")
    bench_tbl.add_column("Wall s",      justify="right")
    bench_tbl.add_column("CPU s",       justify="right", style="muted")
    bench_tbl.add_column("CPU%avg",     justify="right", style="muted")
    bench_tbl.add_column("CPU%max",     justify="right", style="muted")
    bench_tbl.add_column("RSS MB",      justify="right")
    bench_tbl.add_column("RSS Δ",       justify="right", style="muted")
    bench_tbl.add_column("Cost $",      justify="right")
    bench_tbl.add_column("Rows",        justify="right", style="muted")

    for r in results:
        wall_cell = Text(f"{r.wall_seconds:.3f}", style="bold green") if r is fastest else Text(f"{r.wall_seconds:.3f}")
        rss_cell  = Text(f"{r.rss_mb_peak:,.1f}", style="bold green") if r is smallest else Text(f"{r.rss_mb_peak:,.1f}")
        cost_cell = Text(f"{r.cost_usd:.6f}", style="bold green") if r is cheapest else Text(f"{r.cost_usd:.6f}")
        bench_tbl.add_row(
            r.label, r.engine, _status_text(r.status),
            wall_cell, f"{r.cpu_seconds:.2f}",
            f"{r.cpu_percent_mean:.0f}%", f"{r.cpu_percent_max:.0f}%",
            rss_cell, f"{r.rss_mb_delta:+,.1f}",
            cost_cell, f"{r.total_rows:,}",
        )
    console.print(bench_tbl)

    # ── Verdict panel ────────────────────────────────────────────────────────
    if len(results) == 2 and not any(r.error for r in results):
        a, b = results[0], results[1]
        speedup_b = speedup_vs(a, b)
        rss_ratio = round(a.rss_mb_peak / b.rss_mb_peak, 3) if b.rss_mb_peak else 0
        cost_ratio = round(a.cost_usd / b.cost_usd, 3) if b.cost_usd else 0
        verdict = (
            f"[bold white]Wall speed[/]   [accent]{b.label}[/] is "
            f"[bold green]{speedup_b}x[/] vs [accent]{a.label}[/]\n"
            f"[bold white]Peak RSS[/]     [accent]{a.label}[/] / [accent]{b.label}[/] = [bold]{rss_ratio}[/]\n"
            f"[bold white]Cost ratio[/]   [accent]{a.label}[/] / [accent]{b.label}[/] = [bold]{cost_ratio}[/]\n"
            f"[bold white]Fastest[/]      [bold green]{fastest.label}[/]\n"
            f"[bold white]Cheapest[/]     [bold green]{cheapest.label}[/]\n"
            f"[bold white]Smallest mem[/] [bold green]{smallest.label}[/]"
        )
        console.print()
        console.print(Panel.fit(verdict, title="[bold cyan]  Verdict [/]",
                                border_style="cyan", padding=(0, 2)))

    # ── Parity diff (only if engines disagree) ──────────────────────────────
    diffs = parity_diff(results)
    if diffs:
        console.print()
        diff_tbl = Table(box=box.SIMPLE, show_header=True, header_style="bold yellow",
                         border_style="dim", expand=False, title="[bold yellow]Parity Disagreement[/]")
        diff_tbl.add_column("Step", style="bold white")
        for r in results:
            diff_tbl.add_column(r.label, justify="right")
        for d in diffs:
            row = [d["step"]]
            for r in results:
                row.append(str(d.get(r.label, "?")))
            diff_tbl.add_row(*row)
        console.print(Panel(diff_tbl, title="[bold yellow]  Engines disagree on row counts — investigate before trusting the headline  [/]",
                            border_style="yellow", padding=(0, 1)))
    elif len(results) >= 2 and all(not r.error for r in results):
        console.print()
        console.print(Panel.fit(
            f"[bold green]Row-count parity confirmed across {len(results)} runs.[/]",
            border_style="green", padding=(0, 2),
        ))

    console.print()
    return 0 if all(r.status != "FAILED" for r in results) else 1


def _cmd_model_bench(args: argparse.Namespace) -> int:
    """Cross-model planner / agent / chat-qa head-to-head.

    Reads a JSON spec, runs every (model, repeat) trial sequentially, then
    renders a Rich scorecard covering wall time, tokens in/out, content size,
    cost, auto-rubric accuracy, and (optional) LLM-judge quality.
    """
    from .model_compare import (
        load_spec, run_model_comparison,
    )

    try:
        spec = load_spec(args.spec)
    except Exception as exc:
        console.print(f"[bold red]Bad spec:[/] {exc}")
        return 2

    if args.workspace:
        spec.workspace = args.workspace
    if args.repeats is not None:
        spec.repeats = max(1, args.repeats)
    if args.judge:
        spec.judge.enabled = True
    if args.no_judge:
        spec.judge.enabled = False

    if not args.json:
        models_str = ", ".join(m.label for m in spec.models)
        console.print()
        console.print(Panel.fit(
            f"[bold white]Spec[/]         [accent]{spec.id}[/]  [muted]({spec.name})[/]\n"
            f"[bold white]Task[/]         [accent]{spec.task}[/]\n"
            f"[bold white]Workspace[/]    [accent]{spec.workspace}[/]\n"
            f"[bold white]Models[/]       [white]{len(spec.models)}[/]  [muted]({models_str})[/]\n"
            f"[bold white]Repeats[/]      [white]{spec.repeats}[/]  [muted](best wall time per model wins)[/]\n"
            f"[bold white]Judge[/]        " + (
                f"[accent]{spec.judge.model}[/]" if spec.judge.enabled else "[muted]disabled[/]"
            ),
            title="[bold cyan]  Benny Pypes — Model Comparison [/]",
            border_style="cyan",
            padding=(0, 2),
        ))
        console.print()

    _log_handler = _capture_pypes_logs()
    try:
        if args.json:
            result = run_model_comparison(spec)
        else:
            with console.status("[cyan]Running trials...[/]", spinner="dots"):
                result = run_model_comparison(spec)
    finally:
        _release_pypes_logs(_log_handler)

    if args.json:
        print(json.dumps(result.to_dict(), indent=2, default=str))
        return 0 if all(t.status == "OK" for t in result.trials) else 1

    best = result.best_per_model()
    ok_trials = [t for t in best if not t.error]

    # Highlight winners per metric
    fastest  = min(ok_trials, key=lambda t: t.wall_seconds, default=None)
    cheapest = min(ok_trials, key=lambda t: t.cost_usd,     default=None)
    leanest  = min(ok_trials, key=lambda t: t.total_tokens, default=None)
    sharpest = max(ok_trials, key=lambda t: t.quality_score, default=None)

    tbl = Table(box=box.ROUNDED, show_header=True, header_style="bold cyan",
                border_style="dim", expand=False, title="[bold]Cross-Model Scorecard[/]",
                pad_edge=False)
    tbl.add_column("Label",        min_width=12, style="bold white")
    tbl.add_column("Status",       min_width=8,  justify="center")
    tbl.add_column("Wall s",       justify="right")
    tbl.add_column("Tok in",       justify="right", style="muted")
    tbl.add_column("Tok out",      justify="right", style="muted")
    tbl.add_column("Resp chars",   justify="right", style="muted")
    tbl.add_column("Cost $",       justify="right")
    tbl.add_column("CPU%avg",      justify="right", style="muted")
    tbl.add_column("RSS MB",       justify="right", style="muted")
    tbl.add_column("Auto",         justify="right")
    tbl.add_column("Judge",        justify="right")
    tbl.add_column("Quality",      justify="right")

    def _hl(t, win, fmt):
        cell = fmt(t)
        if win is not None and t is win and not t.error:
            return Text(cell, style="bold green")
        return Text(cell)

    for t in best:
        judge_cell = "-" if t.judge_score is None else f"{t.judge_score.total:.1f}/10"
        tbl.add_row(
            t.label,
            _status_text(t.status),
            _hl(t, fastest,  lambda x: f"{x.wall_seconds:.2f}"),
            f"{t.prompt_tokens:,}",
            f"{t.completion_tokens:,}",
            f"{t.response_chars:,}",
            _hl(t, cheapest, lambda x: f"{x.cost_usd:.6f}"),
            f"{t.cpu_percent_mean:.0f}%",
            f"{t.rss_mb_peak:,.0f}",
            f"{t.auto_scores.total:.2f}",
            judge_cell,
            _hl(t, sharpest, lambda x: f"{x.quality_score:.2f}"),
        )
    console.print(tbl)

    # Verdict panel
    if ok_trials:
        lines = [
            f"[bold white]Fastest[/]        [bold green]{fastest.label}[/]   [muted]{fastest.wall_seconds:.2f}s[/]",
            f"[bold white]Cheapest[/]       [bold green]{cheapest.label}[/]  [muted]${cheapest.cost_usd:.6f}[/]",
            f"[bold white]Fewest tokens[/]  [bold green]{leanest.label}[/]   [muted]{leanest.total_tokens:,} tok total[/]",
            f"[bold white]Best quality[/]   [bold green]{sharpest.label}[/]  [muted]{sharpest.quality_score:.2f} blended[/]",
        ]
        console.print()
        console.print(Panel.fit("\n".join(lines), title="[bold cyan]  Winners [/]",
                                border_style="cyan", padding=(0, 2)))

    # Failures panel — surface upstream errors so the user knows what to fix.
    failed = [t for t in best if t.error]
    if failed:
        console.print()
        f_tbl = Table(box=box.SIMPLE, show_header=True, header_style="bold red",
                      border_style="dim", expand=False)
        f_tbl.add_column("Label", style="bold white")
        f_tbl.add_column("Error",  style="red")
        for t in failed:
            f_tbl.add_row(t.label, (t.error or "")[:140])
        console.print(Panel(f_tbl, title="[bold red]  Trials that failed [/]",
                            border_style="red", padding=(0, 1)))

    # Pointer to artifacts
    console.print()
    console.print(
        f"[muted]Per-trial outputs:[/] [accent]{result.output_dir}[/]\n"
        f"[muted]Structured results:[/] [accent]{result.output_dir}/results.json[/]"
    )

    if args.save_report:
        md = _render_compare_markdown(result)
        try:
            Path(args.save_report).parent.mkdir(parents=True, exist_ok=True)
            Path(args.save_report).write_text(md, encoding="utf-8")
            console.print(f"[muted]Markdown scorecard:[/] [accent]{args.save_report}[/]")
        except Exception as exc:
            console.print(f"[red]Failed to write report:[/] {exc}")

    console.print()
    return 0 if all(t.status == "OK" for t in result.trials) else 1


def _render_compare_markdown(result) -> str:
    """Stand-alone Markdown scorecard suitable for sharing in PRs / docs."""
    best = result.best_per_model()
    lines: List[str] = [
        f"# Model comparison — {result.spec_name}",
        "",
        f"- Spec id: `{result.spec_id}`",
        f"- Task: `{result.task}`",
        f"- Workspace: `{result.workspace}`",
        f"- Started:  {result.started_at}",
        f"- Finished: {result.finished_at}",
        f"- Output dir: `{result.output_dir}`",
        "",
        "## Scorecard (best run per model)",
        "",
        "| Label | Status | Wall s | Tok in | Tok out | Resp chars | Cost $ | CPU%avg | RSS MB | Auto | Judge | Quality |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for t in best:
        judge_cell = "-" if t.judge_score is None else f"{t.judge_score.total:.1f}/10"
        lines.append(
            f"| {t.label} | {t.status} | {t.wall_seconds:.2f} | "
            f"{t.prompt_tokens:,} | {t.completion_tokens:,} | {t.response_chars:,} | "
            f"{t.cost_usd:.6f} | {t.cpu_percent_mean:.0f}% | {t.rss_mb_peak:.0f} | "
            f"{t.auto_scores.total:.2f} | {judge_cell} | {t.quality_score:.2f} |"
        )
    lines += ["", "## Per-trial detail", ""]
    for t in result.trials:
        lines += [
            f"### {t.label}  (repeat {t.repeat_idx})",
            "",
            f"- model id: `{t.model_id}`",
            f"- status: **{t.status}**" + (f"  — error: `{t.error}`" if t.error else ""),
            f"- wall: {t.wall_seconds:.3f}s   cpu: {t.cpu_seconds:.3f}s   cpu%avg: {t.cpu_percent_mean:.0f}",
            f"- tokens: {t.prompt_tokens:,} in / {t.completion_tokens:,} out  ({t.total_tokens:,} total)",
            f"- response: {t.response_chars:,} chars  -> `{t.response_path}`",
            f"- cost: ${t.cost_usd:.6f}",
            f"- auto-rubric: {t.auto_scores.total:.2f}  detail: `{json.dumps(t.auto_scores.detail, default=str)[:200]}`",
        ]
        if t.judge_score is not None:
            lines.append(
                f"- judge: completeness={t.judge_score.completeness} "
                f"faithfulness={t.judge_score.faithfulness} "
                f"usability={t.judge_score.usability}  -> {t.judge_score.total:.1f}/10"
            )
            if t.judge_score.rationale:
                lines.append(f"- judge rationale: {t.judge_score.rationale}")
        lines.append("")
    return "\n".join(lines)


def _cmd_chat(args: argparse.Namespace) -> int:
    from .agent_chat import ChatHarness

    ws_root = _workspace_root(args.workspace)
    run_dir = ws_root / "runs" / f"pypes-{args.run_id}"
    if not run_dir.exists():
        console.print(f"[bold red]Run not found:[/] {args.run_id}  [muted]({run_dir})[/]")
        return 1

    try:
        harness = ChatHarness(
            workspace_root=ws_root,
            run_id=args.run_id,
            model=args.model,
            system_override=args.system,
            max_history=args.max_history,
            console=console,
        )
    except Exception as exc:
        console.print(Panel(f"[red]{exc}[/]", title="[bold red] Chat init failed [/]",
                            border_style="red", padding=(0, 1)))
        return 1

    harness.run_loop()
    return 0


# =============================================================================
# HELPERS
# =============================================================================


def _parse_vars(items: List[str]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for item in items or []:
        if "=" not in item:
            continue
        k, v = item.split("=", 1)
        out[k.strip()] = v.strip()
    return out


def _workspace_root(workspace: str) -> Path:
    benny_home = os.environ.get("BENNY_HOME")
    base = Path(benny_home) if benny_home else Path.cwd()
    return base / "workspace" / workspace


def _load_run_manifest(run_dir: Path) -> Optional[PypesManifest]:
    snap = run_dir / "manifest_snapshot.json"
    if not snap.exists():
        return None
    return PypesManifest.model_validate_json(snap.read_text(encoding="utf-8"))
