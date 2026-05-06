"""
Benny CLI — declarative manifest driver.

Usage:
    benny plan "Generate a 10k-word analyst report comparing X and Y" \\
        --workspace default --output report.md --word-count 10000 \\
        --save manifest.json

    benny run manifest.json

    benny runs ls [--manifest MANIFEST_ID]
    benny runs show RUN_ID

    benny migrate --from <path> [--to $BENNY_HOME] [--apply]

Design: this is the user's main interface to the plan-then-run loop. The
same JSON that appears in `manifest.json` is what the UI canvas renders
and what past runs reference. Share the file -> share the workflow.
"""

from __future__ import annotations

import sys
if sys.platform == "win32":
    try:
        import msvcrt
        msvcrt.setmaxstdio(2048)
    except Exception:
        pass

import argparse
import asyncio
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from benny.core.manifest import (
    InputSpec,
    ManifestConfig,
    OutputFormat,
    OutputSpec,
    SwarmManifest,
)


# =============================================================================
# COMMANDS
# =============================================================================


async def cmd_plan(args: argparse.Namespace) -> int:
    from benny.core.models import get_active_model
    from benny.graph.manifest_runner import plan_from_requirement
    from benny.persistence import run_store

    output_spec = OutputSpec(
        files=args.output or [],
        format=OutputFormat(args.format) if args.format else OutputFormat.MARKDOWN,
        word_count_target=args.word_count,
        spec=args.spec or "",
    )

    # Resolve model from manager if not provided
    model = args.model
    if not model:
        model = await get_active_model(args.workspace)

    print(f"[plan] requirement: {args.requirement[:120]}{'...' if len(args.requirement) > 120 else ''}")
    print(f"[plan] workspace={args.workspace} model={model} max_concurrency={args.max_concurrency}")
    if args.input:
        print(f"[plan] inputs: {args.input}")
    if output_spec.word_count_target:
        print(f"[plan] target: {output_spec.word_count_target} words -> {output_spec.format.value}")

    manifest = await plan_from_requirement(
        requirement=args.requirement,
        workspace=args.workspace,
        model=model,
        input_files=args.input or [],
        output_spec=output_spec,
        max_concurrency=args.max_concurrency,
        max_depth=args.max_depth,
        name=args.name,
    )
    manifest.inputs = InputSpec(files=args.input or [])

    if args.save:
        run_store.save_manifest(manifest)
        print(f"[plan] saved to run_store id={manifest.id}")

    out_path = Path(args.out) if args.out else None
    rendered = manifest.model_dump_json(indent=2)
    if out_path:
        out_path.write_text(rendered, encoding="utf-8")
        print(f"[plan] wrote manifest -> {out_path}")
    else:
        print(rendered)

    print(f"[plan] tasks={len(manifest.plan.tasks)} waves={len(manifest.plan.waves)}")
    if manifest.plan.ascii_dag:
        print("\n" + manifest.plan.ascii_dag)
    return 0


async def cmd_run(args: argparse.Namespace) -> int:
    from benny.graph.manifest_runner import execute_manifest
    from benny.persistence import run_store

    manifest = _load_manifest(args.manifest)
    if args.workspace:
        manifest.workspace = args.workspace

    # Persist so runs reference a real, resolvable manifest id.
    run_store.save_manifest(manifest)

    print(f"[run] manifest_id={manifest.id} name={manifest.name!r}")
    print(f"[run] tasks={len(manifest.plan.tasks)} workspace={manifest.workspace}")

    record = await execute_manifest(manifest)
    print(f"[run] run_id={record.run_id} status={record.status.value}")
    if record.duration_ms:
        print(f"[run] duration={record.duration_ms}ms")
    if record.errors:
        print(f"[run] errors: {record.errors}", file=sys.stderr)
    if record.artifact_paths:
        print(f"[run] artifacts: {record.artifact_paths}")
    if record.governance_url:
        print(f"[run] lineage: {record.governance_url}")

    if args.json:
        print(record.model_dump_json(indent=2))
    return 0 if record.status.value in ("completed", "partial_success") else 1


def cmd_runs_ls(args: argparse.Namespace) -> int:
    from benny.persistence import run_store

    recs = run_store.list_runs(
        manifest_id=args.manifest, workspace=args.workspace, limit=args.limit
    )
    if not recs:
        print("[runs] (none)")
        return 0

    print(f"{'RUN ID':<20} {'MANIFEST':<24} {'STATUS':<12} {'STARTED':<26} DURATION")
    for r in recs:
        dur = f"{r.duration_ms}ms" if r.duration_ms else "-"
        started = r.started_at or "-"
        print(f"{r.run_id:<20} {r.manifest_id[:22]:<24} {r.status.value:<12} {started:<26} {dur}")
    return 0


def cmd_runs_show(args: argparse.Namespace) -> int:
    from benny.persistence import run_store

    rec = run_store.get_run(args.run_id)
    if not rec:
        print(f"[runs] not found: {args.run_id}", file=sys.stderr)
        return 1
    print(rec.model_dump_json(indent=2))
    return 0


def cmd_manifests_ls(args: argparse.Namespace) -> int:
    from benny.persistence import run_store

    ms = run_store.list_manifests()
    if not ms:
        print("[manifests] (none)")
        return 0

    print(f"{'ID':<32} {'NAME':<40} TASKS")
    for m in ms:
        print(f"{m.id[:30]:<32} {m.name[:38]:<40} {len(m.plan.tasks)}")
    return 0


async def cmd_req(args: argparse.Namespace) -> int:
    """benny req — Requirements Analyst: free-text → PRD JSON + Gherkin (AOS-F20).

    Usage:
        benny req "Build a VRAM-aware worker pool" --workspace default
        benny req "..." --model local_lemonade --out prd.json
    """
    import os
    import re as _re
    from pathlib import Path as _Path
    from benny.sdlc.requirements import PrdValidationError, generate_prd

    requirement = args.requirement
    model = args.model or "local_lemonade"

    print(f"[req] requirement: {requirement[:120]}{'...' if len(requirement) > 120 else ''}")
    print(f"[req] model={model}")

    try:
        prd, gherkin = generate_prd(requirement, model=model)
    except PrdValidationError as exc:
        print(f"[req] ERROR: PRD validation failed (AOS-F22): {exc}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as exc:
        print(f"[req] ERROR: LLM returned invalid JSON: {exc}", file=sys.stderr)
        return 1

    # Derive a URL-safe slug from the PRD title
    slug = _re.sub(r"[^a-z0-9]+", "_", prd.get("title", "prd").lower()).strip("_") or "prd"

    if args.workspace:
        home = os.environ.get("BENNY_HOME", ".")
        out_dir = _Path(home) / "workspaces" / args.workspace / "data_out" / "prd"
        out_dir.mkdir(parents=True, exist_ok=True)
        prd_path = out_dir / f"{slug}.json"
        feature_path = out_dir / f"{slug}.feature"
        prd_path.write_text(json.dumps(prd, indent=2), encoding="utf-8")
        feature_path.write_text(gherkin, encoding="utf-8")
        print(f"[req] PRD     → {prd_path}")
        print(f"[req] Gherkin → {feature_path}")
    else:
        # No workspace — print to stdout
        print(json.dumps(prd, indent=2))
        print("---")
        print(gherkin)

    return 0


async def cmd_enrich(args: argparse.Namespace) -> int:  # noqa: C901 — intentionally long; each section is a clear phase
    """Knowledge enrichment pipeline with Rich live display, OpenLineage events,
    local run folder, and GDPR-compliant audit trail.

    Executes 7 tasks across 5 waves via direct API calls so each task gets its
    own spinner, elapsed time, and lineage event — no LLM planning needed.

    Usage:
        benny enrich --workspace c5_test --src src/dangpy --out plans/enrich.json
        benny enrich --workspace c5_test --src src/dangpy --run
        benny enrich --workspace c5_test --src src/dangpy --json
    """
    import hashlib
    import os
    import time
    import uuid
    from datetime import datetime, timezone

    import httpx
    from rich import box
    from rich.console import Console, Group
    from rich.live import Live
    from rich.panel import Panel
    from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn
    from rich.rule import Rule
    from rich.table import Table
    from rich.text import Text

    from benny.core.manifest import ManifestEdge, ManifestPlan, ManifestTask
    from benny.core.manifest_hash import sign_manifest
    from benny.governance.audit import emit_governance_event
    from benny.governance.lineage import BennyLineageClient

    console = Console()

    API_BASE = os.environ.get("BENNY_API_URL", "http://127.0.0.1:8005")
    API_KEY  = os.environ.get("BENNY_API_KEY",  "benny-mesh-2026-auth")
    _H = {"X-Benny-API-Key": API_KEY}
    _HJ = {**_H, "Content-Type": "application/json"}

    # ─── 0. Load declarative manifest (if --manifest given) ─────────────────
    # Everything we learn here — timeouts, thresholds, endpoints, model — is
    # applied as an override on top of CLI flags / env defaults, so a single
    # JSON manifest can fully describe the pipeline.
    loaded_manifest: Optional[Dict[str, Any]] = None
    task_timeouts:   Dict[str, float]        = {}  # per-task read timeout (s) from manifest

    def _subst(value: Any, ctx: Dict[str, Any]) -> Any:
        """Recursively replace ${name} tokens from ctx. Leaves literals intact."""
        if isinstance(value, str):
            out = value
            for _ in range(4):  # allow nested substitution up to 4 levels
                prev = out
                for k, v in ctx.items():
                    token = "${" + k + "}"
                    if token in out:
                        out = out.replace(token, "" if v is None else str(v))
                if out == prev:
                    break
            return out
        if isinstance(value, list):
            return [_subst(v, ctx) for v in value]
        if isinstance(value, dict):
            return {k: _subst(v, ctx) for k, v in value.items()}
        return value

    if getattr(args, "manifest", None):
        mpath = Path(args.manifest)
        if not mpath.exists():
            console.print(f"[bold red]Manifest not found:[/] {mpath}")
            return 1
        try:
            raw = json.loads(mpath.read_text(encoding="utf-8"))
        except Exception as e:
            console.print(f"[bold red]Failed to parse manifest {mpath}:[/] {e}")
            return 1

        # Build substitution context: CLI flags > env vars > manifest.variables defaults.
        mvars: Dict[str, Any] = dict(raw.get("variables", {}) or {})
        ctx: Dict[str, Any] = {}
        ctx.update(mvars)
        ctx.update({k: os.environ.get(k) for k in ("BENNY_HOME", "BENNY_API_URL", "BENNY_API_KEY") if os.environ.get(k)})
        if args.workspace:          ctx["workspace"]             = args.workspace
        if args.src:                ctx["src_path"]              = args.src.rstrip("/")
        if args.model:              ctx["model"]                 = args.model
        if args.threshold is not None:   ctx["correlation_threshold"] = args.threshold
        if args.strategy:           ctx["correlation_strategy"]  = args.strategy
        if getattr(args, "resume_run_id", None): ctx["resume_from_run_id"] = args.resume_run_id
        # run_id / task_run_id are filled later; leave literal tokens for them
        loaded_manifest = _subst(raw, ctx)

        # Apply top-level overrides from the manifest
        api_cfg = (loaded_manifest.get("execution", {}) or {}).get("api", {}) or {}
        if api_cfg.get("base"):         API_BASE = api_cfg["base"]
        if api_cfg.get("auth_value"):   API_KEY  = api_cfg["auth_value"]
        _H  = {api_cfg.get("auth_header", "X-Benny-API-Key"): API_KEY}
        _HJ = {**_H, "Content-Type": api_cfg.get("content_type", "application/json")}

        # Sync CLI args with manifest context (so downstream code using args.* still works)
        m_cfg = loaded_manifest.get("config", {}) or {}
        if m_cfg.get("model"):                 args.model     = m_cfg["model"]
        m_ctx = (loaded_manifest.get("inputs", {}) or {}).get("context", {}) or {}
        if m_ctx.get("src_path"):              args.src       = m_ctx["src_path"]
        try:
            if m_ctx.get("correlation_threshold") is not None:
                args.threshold = float(m_ctx["correlation_threshold"])
        except (TypeError, ValueError):
            pass
        if m_ctx.get("correlation_strategy"):  args.strategy  = m_ctx["correlation_strategy"]

        # Extract per-task read timeouts so _run_task can honour them
        for t in (loaded_manifest.get("plan", {}) or {}).get("tasks", []) or []:
            tid = t.get("id")
            if not tid:
                continue
            ex = t.get("execution", {}) or {}
            # blocking-ish kinds put their timeout under .request.timeout.read or .request.timeout_s
            req = ex.get("request") or ex.get("start") or {}
            to  = req.get("timeout")
            if isinstance(to, dict) and "read" in to:
                try:
                    task_timeouts[tid] = float(to["read"])
                except (TypeError, ValueError):
                    pass
            elif isinstance(req.get("timeout_s"), (int, float)):
                task_timeouts[tid] = float(req["timeout_s"])

        console.print(f"[dim]Loaded manifest:[/] {mpath}  [dim]({len(task_timeouts)} per-task timeouts resolved)[/]")

    # ─── 0b. Prior-run inspection for --resume ───────────────────────────────
    # Reads workspace/<ws>/runs/enrich-<resume_run_id>/task_*.json and builds
    # a {task_id -> (status, result_dict)} map. Tasks whose status is in
    # skip_if_status are skipped in the wave loop and their `result` is
    # rehydrated into the shared task_results dict so downstream tasks can
    # still find e.g. pdf_files.
    prior_results: Dict[str, Dict[str, Any]] = {}
    # "reused" is included so resume-of-resume chains stay idempotent: if a
    # prior run reused a task from an even-earlier run, the underlying result
    # is still valid and must not force a re-execution of an 1800s endpoint.
    _resume_skip_statuses = {"done", "completed", "completed_after_timeout", "reused"}
    # Tasks that must always re-execute even when --resume would otherwise reuse
    # them. `generate_report` is the canonical example: it reads live graph state
    # and is cheap to regenerate, so reusing a stale/empty prior report is always
    # wrong.
    _always_rerun: set = {"generate_report"}
    if loaded_manifest:
        _rcfg = (loaded_manifest.get("execution", {}) or {}).get("resume", {}) or {}
        if isinstance(_rcfg.get("skip_if_status"), list):
            _resume_skip_statuses = {str(s).lower() for s in _rcfg["skip_if_status"]}
        if isinstance(_rcfg.get("always_rerun"), list):
            _always_rerun = {str(s) for s in _rcfg["always_rerun"]}

    if getattr(args, "resume_run_id", None):
        _benny_home_resume = Path(os.environ.get("BENNY_HOME", "."))
        _prior_folder = _benny_home_resume / "workspaces" / args.workspace / "runs" / f"enrich-{args.resume_run_id}"
        if not _prior_folder.exists():
            console.print(f"[bold yellow]⚠  --resume {args.resume_run_id}: run folder not found[/] ({_prior_folder}). Running fresh.")
        else:
            found = 0
            for pj in _prior_folder.glob("task_*.json"):
                try:
                    rec = json.loads(pj.read_text(encoding="utf-8"))
                    tid = rec.get("task_id") or pj.stem.removeprefix("task_")
                    status = str(rec.get("status", "")).lower()
                    prior_results[tid] = {"status": status, "result": rec.get("result") or {}}
                    found += 1
                except Exception as e:
                    console.print(f"[dim]  skipped unreadable {pj.name}: {e}[/]")
            reusable = sum(1 for r in prior_results.values() if r["status"] in _resume_skip_statuses)
            console.print(
                f"[cyan]⟲  Resuming from[/] [bold]{args.resume_run_id}[/]  "
                f"[dim]({reusable}/{found} tasks reusable from {_prior_folder.name})[/]"
            )

    # ─── 1. Resolve model ────────────────────────────────────────────────────
    model = args.model
    if not model:
        try:
            from benny.core.models import get_active_model
            model = await get_active_model(args.workspace)
        except Exception:
            model = "lemonade/qwen3-tk-4b-FLM"

    run_it   = args.run_after or args.json
    src_path = args.src.rstrip("/")
    ts       = datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")
    manifest_id = f"enrich-{args.workspace}-{ts}"
    run_id      = uuid.uuid4().hex[:12]
    started_at  = datetime.now(timezone.utc)

    # ─── 2. Build manifest ───────────────────────────────────────────────────
    tasks = [
        ManifestTask(
            id="pdf_extract",
            description="[DETERMINISTIC] Convert staging/ PDFs/docs to Markdown via Docling.",
            skill_hint="extract_pdf",
            deterministic=True,
            skill_args={"src_dir": "staging/"},
            wave=0, complexity="medium", node_type="task",
            files_touched=["staging/"],
        ),
        ManifestTask(
            id="code_scan",
            description=f"[DETERMINISTIC] Tree-Sitter scan of {src_path}/ -> Neo4j code graph.",
            skill_hint="code_scan",
            deterministic=True,
            skill_args={"root_dir": src_path, "deep_scan": True},
            wave=0, complexity="high", node_type="task",
            files_touched=[f"{src_path}/"],
        ),
        ManifestTask(
            id="rag_ingest",
            description="[DETERMINISTIC] Chunk + embed Markdown -> ChromaDB.",
            skill_hint="rag_ingest",
            deterministic=True,
            skill_args={"deep_synthesis": False, "strategy": args.strategy},
            dependencies=["pdf_extract"],
            wave=1, complexity="medium", node_type="task",
        ),
        ManifestTask(
            id="deep_synthesis",
            description="[AGENTIC] Extract knowledge triples (Concept -> Concept) -> Neo4j REL edges.",
            skill_hint="rag_ingest",
            assigned_model=model,
            dependencies=["rag_ingest"],
            wave=2, complexity="high", node_type="task",
        ),
        ManifestTask(
            id="semantic_correlate",
            description=(
                f"[DETERMINISTIC] Neural Spark semantic correlation -> CORRELATES_WITH edges. "
                f"threshold={args.threshold} strategy={args.strategy}."
            ),
            skill_hint="kg3d_ingest",          # registered skill that calls run_full_correlation_suite
            deterministic=True,
            skill_args={"threshold": args.threshold, "strategy": args.strategy},
            dependencies=["code_scan", "deep_synthesis"],
            wave=3, complexity="medium", node_type="task",
        ),
        ManifestTask(
            id="validate_enrichment",
            description="[DETERMINISTIC] Assert CORRELATES_WITH edges > 0 in Neo4j.",
            skill_hint="validate_enrichment",
            deterministic=True,
            skill_args={},
            dependencies=["semantic_correlate"],
            wave=4, complexity="low", node_type="task",
        ),
        ManifestTask(
            id="generate_report",
            description="[AGENTIC] Write enrichment_report.md with statistics and concept-to-code mapping.",
            skill_hint="rag_ingest",
            assigned_model=model,
            dependencies=["validate_enrichment"],
            wave=4, complexity="medium", node_type="output",
            files_touched=["data_out/enrichment_report.md"],
        ),
    ]

    edges = [
        ManifestEdge(id="e_pdf_rag",    source="pdf_extract",        target="rag_ingest",         label="extracted markdown", animated=True),
        ManifestEdge(id="e_rag_synth",  source="rag_ingest",         target="deep_synthesis",      label="indexed corpus",     animated=True),
        ManifestEdge(id="e_code_corr",  source="code_scan",          target="semantic_correlate",  label="code entities",      animated=True),
        ManifestEdge(id="e_synth_corr", source="deep_synthesis",     target="semantic_correlate",  label="knowledge triples",  animated=True),
        ManifestEdge(id="e_corr_val",   source="semantic_correlate", target="validate_enrichment", label="CORRELATES_WITH",    animated=True),
        ManifestEdge(id="e_val_report", source="validate_enrichment",target="generate_report",     label="validated",          animated=True),
    ]

    plan = ManifestPlan(
        tasks=tasks,
        edges=edges,
        waves=[
            ["pdf_extract", "code_scan"],
            ["rag_ingest"],
            ["deep_synthesis"],
            ["semantic_correlate"],
            ["validate_enrichment", "generate_report"],
        ],
        ascii_dag=(
            "pdf_extract --+\n"
            "              +--> rag_ingest --> deep_synthesis --+\n"
            "              |                                    +--> semantic_correlate --> validate_enrichment --> generate_report\n"
            "code_scan ----+--------------------------------------------+\n"
        ),
    )

    manifest = SwarmManifest(
        id=manifest_id,
        name=f"Knowledge Enrichment \u2014 {args.workspace}",
        description="Knowledge enrichment pipeline: extract \u2192 ingest \u2192 synthesise \u2192 correlate \u2192 validate \u2192 report.",
        requirement=(
            "Build the knowledge enrichment overlay for the Studio ENRICH toggle: "
            f"scan source code in {src_path}/, extract knowledge triples from ingested documents, "
            "and create CORRELATES_WITH edges linking concepts to code symbols."
        ),
        workspace=args.workspace,
        inputs=InputSpec(
            files=["staging/", f"{src_path}/"],
            context={
                "src_path": src_path,
                "correlation_threshold": args.threshold,
                "correlation_strategy": args.strategy,
            },
        ),
        outputs=OutputSpec(
            files=["data_out/enrichment_report.md"],
            format=OutputFormat.MARKDOWN,
            spec="Enrichment summary: concept count, code entity count, CORRELATES_WITH edges, confidence distribution.",
        ),
        plan=plan,
        config=ManifestConfig(
            model=model,
            max_concurrency=2,
            max_depth=3,
            skills_allowed=["extract_pdf", "rag_ingest", "code_scan", "kg3d_ingest", "validate_enrichment"],
        ),
        tags=["enrichment", "code-analysis", "knowledge-graph"],
        metadata={
            "src_path": src_path,
            "correlation_threshold": args.threshold,
            "correlation_strategy": args.strategy,
        },
    )
    sign_manifest(manifest)
    rendered = manifest.model_dump_json(indent=2)

    # ─── 3. Write --out path ─────────────────────────────────────────────────
    out_path = Path(args.out) if args.out else None
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(rendered, encoding="utf-8")

    # Plan-only mode: show a nice panel and exit
    if not run_it:
        plan_tbl = Table(box=box.SIMPLE, show_header=True, header_style="bold cyan", expand=True)
        plan_tbl.add_column("Wave", justify="center", width=5)
        plan_tbl.add_column("Task ID", min_width=22)
        plan_tbl.add_column("Type", width=14)
        plan_tbl.add_column("Skill hint", width=22)
        plan_tbl.add_column("Description", style="dim")
        for t in tasks:
            tag = "[magenta]AGENTIC[/]" if "[AGENTIC]" in t.description else "[blue]DETERMINISTIC[/]"
            plan_tbl.add_row(str(t.wave), t.id, tag, t.skill_hint or "", t.description[:60])
        console.print()
        console.print(Panel(
            plan_tbl,
            title=f"[bold cyan]Knowledge Enrichment Plan[/]  [dim]{args.workspace}[/]",
            border_style="cyan", padding=(0, 2),
        ))
        if out_path:
            console.print(f"  [dim]Manifest written \u2192[/] {out_path}")
        console.print(f"  [dim]Run with:[/] benny enrich --workspace {args.workspace} --src {args.src} --run\n")
        return 0

    # ─── 4. Create local run folder ──────────────────────────────────────────
    benny_home = Path(os.environ.get("BENNY_HOME", "."))
    run_folder = benny_home / "workspaces" / args.workspace / "runs" / f"enrich-{run_id}"
    run_folder.mkdir(parents=True, exist_ok=True)

    (run_folder / "manifest.json").write_text(rendered, encoding="utf-8")

    gdpr: Dict[str, Any] = {
        "schema": "GDPR-data-processing-record-v1",
        "data_controller": "Benny Platform Operator",
        "processing_purpose": (
            "Knowledge graph enrichment — semantic correlation of architecture "
            "documents to source code symbols for developer tooling."
        ),
        "legal_basis": "Legitimate interests (Article 6(1)(f) GDPR) — technical system analysis",
        "data_categories": [
            "Source code file paths, class names, function names (no personal data)",
            "Architecture document text fragments (no personal data)",
            "Graph relationship metadata (no personal data)",
        ],
        "personal_data": False,
        "ai_disclosure": f"AI model used: {model}",
        "retention_days": 90,
        "right_to_erasure": (
            f"Delete run folder: {run_folder}; "
            f"run Cypher: MATCH (c:Concept)-[r:CORRELATES_WITH]->(e:CodeEntity {{workspace: '{args.workspace}'}}) DELETE r"
        ),
        "generated_at": started_at.isoformat(),
        "run_id": run_id,
        "manifest_id": manifest_id,
        "workspace": args.workspace,
    }
    (run_folder / "GDPR_notice.json").write_text(
        json.dumps(gdpr, indent=2, default=str), encoding="utf-8"
    )

    # ─── 5. Header panel ─────────────────────────────────────────────────────
    console.print()
    console.print(Panel.fit(
        f"[bold white]Workspace[/]    [cyan]{args.workspace}[/]\n"
        f"[bold white]Source path[/]  [cyan]{src_path}/[/]\n"
        f"[bold white]Model[/]        [cyan]{model}[/]\n"
        f"[bold white]Threshold[/]    [cyan]{args.threshold}[/]  "
        f"[dim]strategy={args.strategy}[/]\n"
        f"[bold white]Run folder[/]   [dim]{run_folder}[/]\n"
        f"[bold white]Lineage[/]      [link=http://localhost:3010]http://localhost:3010[/link]  "
        f"[dim](Marquez)[/]",
        title="[bold cyan] Benny Knowledge Enrichment [/]",
        border_style="cyan",
        padding=(0, 2),
    ))
    console.print()

    # ─── 5b. Pre-flight: verify API is reachable ────────────────────────────
    try:
        async with httpx.AsyncClient(timeout=5.0) as _hc:
            _probe = await _hc.get(f"{API_BASE}/api/system/pulse", headers=_H)
            _probe.raise_for_status()
    except Exception as _probe_err:
        console.print(
            f"\n[bold red]✗  Cannot reach Benny API at {API_BASE}[/]\n"
            f"   [red]{type(_probe_err).__name__}: {_probe_err}[/]\n\n"
            f"   [dim]Start the server first:[/]\n"
            f"   [bold cyan]benny up --home $BENNY_HOME[/]\n"
        )
        return 1

    # ─── 6. Start OpenLineage workflow ───────────────────────────────────────
    lineage = BennyLineageClient()
    try:
        lineage.start_workflow(
            workflow_id=manifest_id,
            workflow_name=f"Knowledge Enrichment \u2014 {args.workspace}",
            workspace=args.workspace,
            inputs=["staging/", f"{src_path}/"],
            outputs=["data_out/enrichment_report.md"],
            metadata={"run_id": run_id, "model": model, "threshold": args.threshold},
        )
    except Exception:
        pass  # lineage is best-effort; never crash the pipeline

    # ─── 7. Task status state ────────────────────────────────────────────────
    TASK_DEFS = [
        {"id": "pdf_extract",        "wave": 0, "desc": "Convert staging/ PDFs \u2192 Markdown (Docling)"},
        {"id": "code_scan",          "wave": 0, "desc": "Tree-Sitter code scan \u2192 Neo4j graph"},
        {"id": "rag_ingest",         "wave": 1, "desc": "Chunk + embed \u2192 ChromaDB"},
        {"id": "deep_synthesis",     "wave": 2, "desc": "Extract knowledge triples \u2192 Neo4j REL"},
        {"id": "semantic_correlate", "wave": 3, "desc": "Neural Spark \u2192 CORRELATES_WITH edges"},
        {"id": "validate_enrichment","wave": 4, "desc": "Assert CORRELATES_WITH edges exist"},
        {"id": "generate_report",    "wave": 4, "desc": "Write enrichment_report.md"},
    ]

    task_status:  Dict[str, str]             = {t["id"]: "pending"  for t in TASK_DEFS}
    task_elapsed: Dict[str, Optional[float]] = {t["id"]: None       for t in TASK_DEFS}
    task_note:    Dict[str, str]             = {t["id"]: ""         for t in TASK_DEFS}
    task_error:   Dict[str, Optional[str]]   = {t["id"]: None       for t in TASK_DEFS}

    def _make_table() -> Table:
        tbl = Table(
            box=box.ROUNDED, show_header=True, header_style="bold cyan",
            expand=True, border_style="dim",
        )
        tbl.add_column("W", style="dim cyan", width=3, justify="center")
        tbl.add_column("Task", style="bold white", min_width=22)
        tbl.add_column("Status", width=14, justify="center")
        tbl.add_column("Description", style="dim white", ratio=1)
        tbl.add_column("Elapsed", width=8, justify="right")
        tbl.add_column("Notes", style="dim", width=22, no_wrap=True)
        for t in TASK_DEFS:
            st = task_status[t["id"]]
            el = task_elapsed[t["id"]]
            el_str = f"{el:.1f}s" if el is not None else "-"
            st_cell: Text
            if   st == "pending":  st_cell = Text("\u25cb  pending",  style="dim")
            elif st == "running":  st_cell = Text("\u25c9  running",  style="bold yellow")
            elif st == "done":     st_cell = Text("\u2713  done",     style="bold green")
            elif st == "reused":   st_cell = Text("\u21ba  reused",   style="bold cyan")
            elif st == "skipped":  st_cell = Text("\u2296  skipped",  style="dim yellow")
            else:                  st_cell = Text("\u2717  failed",   style="bold red")
            tbl.add_row(str(t["wave"]), t["id"], st_cell, t["desc"], el_str, task_note[t["id"]])
        return tbl

    # ─── 8. Per-task API executor ────────────────────────────────────────────
    # Shared state used to pass discovered artefacts between tasks
    # (e.g. pdf_extract finds nested PDFs; rag_ingest uses them)
    task_results: Dict[str, Any] = {}

    async def _run_task(tid: str, client: httpx.AsyncClient) -> Dict[str, Any]:
        async def _diagnose_dead_server(orig_exc: BaseException) -> RuntimeError:
            """When a ReadTimeout hits, probe /api/system/pulse to tell the
            user whether the backend is dead or just slow."""
            try:
                # Use a dedicated short timeout for the pulse check
                p = await client.get(f"{API_BASE}/api/system/pulse", headers=_H, timeout=3.0)
                if p.status_code == 200:
                    return RuntimeError(
                        f"{type(orig_exc).__name__} — /pulse still OK, but this "
                        "endpoint is stalling. Backend may have an FD leak from "
                        "the prior crash; restart with `benny down && benny up`."
                    )
            except Exception:
                pass
            return RuntimeError(
                f"{type(orig_exc).__name__} — backend is unreachable. "
                "Restart with `benny down && benny up` then retry."
            )

        if tid == "pdf_extract":
            # Recursive scan finds files at ANY depth (handles data_in/staging/*.pdf).
            # Workspaces with chromadb/ + runs/ can have thousands of files, so 90 s.
            try:
                rr = await client.get(
                    f"{API_BASE}/api/files/recursive-scan", headers=_H,
                    params={"workspace": args.workspace}, timeout=90.0,
                )
            except httpx.ReadTimeout as e:
                raise await _diagnose_dead_server(e)
            rr.raise_for_status()
            all_files = rr.json().get("files", [])

            def _rel_to(prefix: str, p: str) -> Optional[str]:
                """If path starts with prefix (Windows or POSIX), return it stripped."""
                for sep in ("\\", "/"):
                    head = f"{prefix}{sep}"
                    if p.startswith(head):
                        return p[len(head):].replace("\\", "/")
                return None

            # Collect ingestible docs already under data_in/ (any depth)
            data_in_ingestible: List[str] = []       # relative to data_in/
            data_in_md:         List[str] = []
            staging_top:        List[str] = []       # top-level staging/
            for f in all_files:
                path = f.get("path", "") or ""
                name = f.get("name", "") or ""
                ext  = name.lower().rsplit(".", 1)[-1] if "." in name else ""
                rel = _rel_to("data_in", path)
                if rel is not None:
                    if ext in ("pdf", "docx", "pptx", "txt", "html"):
                        data_in_ingestible.append(rel)
                    if ext == "md":
                        data_in_md.append(rel)
                elif _rel_to("staging", path) is not None:
                    if ext in ("pdf", "docx", "pptx", "txt", "html", "md"):
                        staging_top.append(_rel_to("staging", path) or name)

            # Case A: top-level staging/ has raw docs → flag for later handling
            if staging_top:
                task_results["staging_files"] = staging_top
                return {
                    "staging_files": len(staging_top),
                    "files":         staging_top[:5],
                    "status":        "converted",
                }

            # Case B: markdown already in data_in/ (any depth) → nothing to do
            if data_in_md and not data_in_ingestible:
                return {
                    "md_files": len(data_in_md),
                    "status":   "already_converted",
                }

            # Case C: ingestible docs in data_in/ (pdfs in staging/ subdir, etc.)
            # Hand them to rag_ingest via shared task_results
            if data_in_ingestible:
                task_results["pdf_files"] = data_in_ingestible
                return {
                    "pdf_count": len(data_in_ingestible),
                    "paths":     data_in_ingestible[:3],
                    "status":    "pdfs_found",
                }

            # Case D: ChromaDB already has chunks from a previous run
            try:
                rs = await client.get(
                    f"{API_BASE}/api/rag/status", headers=_H,
                    params={"workspace": args.workspace}, timeout=10.0,
                )
                if rs.status_code == 200:
                    chunks = rs.json().get("total_chunks", 0)
                    if chunks > 0:
                        return {
                            "status":     "already_ingested",
                            "rag_chunks": chunks,
                        }
            except Exception:
                pass

            raise RuntimeError(
                "No ingestible docs found anywhere under the workspace and "
                "ChromaDB is empty — upload architecture docs first "
                "(Studio → Notebook → Upload)."
            )

        elif tid == "code_scan":
            # Start the background Tree-Sitter scan (returns immediately).
            try:
                r = await client.post(
                    f"{API_BASE}/api/graph/code/generate", headers=_HJ,
                    json={"workspace": args.workspace, "root_dir": src_path},
                    timeout=90.0,
                )
            except httpx.ReadTimeout as e:
                raise await _diagnose_dead_server(e)
            r.raise_for_status()
            scan_run_id = r.json().get("run_id", "")
            # Poll GET /api/graph/code until nodes appear
            for _attempt in range(72):
                await asyncio.sleep(5)
                try:
                    gr = await client.get(
                        f"{API_BASE}/api/graph/code", headers=_H,
                        params={"workspace": args.workspace},
                        timeout=10.0,
                    )
                    if gr.status_code == 200:
                        gdata = gr.json()
                        nodes = gdata.get("nodes", [])
                        if nodes:
                            return {
                                "code_nodes": len(nodes),
                                "run_id":     scan_run_id,
                                "status":     "complete",
                            }
                except Exception:
                    pass
            return {"status": "scan_started", "run_id": scan_run_id}

        elif tid == "rag_ingest":
            # /api/rag/ingest is a SYNCHRONOUS endpoint.
            pdf_files = task_results.get("pdf_files")
            ingest_run_id = str(uuid.uuid4())
            body: Dict[str, Any] = {
                "workspace":      args.workspace,
                "deep_synthesis": False,
                "run_id":         ingest_run_id,
            }
            if pdf_files:
                body["files"] = pdf_files

            # Dedicated long-timeout for this one call (30 min read).
            try:
                r = await client.post(
                    f"{API_BASE}/api/rag/ingest", headers=_HJ, json=body,
                    timeout=httpx.Timeout(connect=10.0, read=1800.0, write=120.0, pool=10.0)
                )
                r.raise_for_status()
                out = r.json()
            except (httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.ConnectError) as net_err:
                # POST died — fall back to task_manager status lookup.
                try:
                    tr = await client.get(
                        f"{API_BASE}/api/tasks/tasks/{ingest_run_id}",
                        headers=_H, timeout=10.0,
                    )
                    if tr.status_code == 200:
                        td = tr.json()
                        st = str(td.get("status", "")).lower()
                        if st in ("completed", "complete", "done"):
                            return {
                                "status":     "completed_after_timeout",
                                "rag_chunks": td.get("total_steps", 0),
                                "task_id":    ingest_run_id,
                            }
                except httpx.HTTPError:
                    pass
                raise RuntimeError(f"rag_ingest failed: {net_err}")
            return out

        elif tid == "deep_synthesis":
            # /api/graph/synthesize now runs in background on server.
            try:
                r = await client.post(
                    f"{API_BASE}/api/graph/synthesize", headers=_HJ,
                    json={"workspace": args.workspace, "model": model},
                    timeout=httpx.Timeout(connect=10.0, read=1800.0, write=60.0, pool=10.0)
                )
                r.raise_for_status()
                return r.json()
            except (httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.ConnectError) as net_err:
                # Fallback: check if a synthesis task completed server-side
                try:
                    tr = await client.get(
                        f"{API_BASE}/api/tasks",
                        headers=_H,
                        params={"workspace": args.workspace},
                        timeout=10.0,
                    )
                    if tr.status_code == 200:
                        tasks = tr.json() or []
                        synth = [t for t in tasks if str(t.get("type", "")).lower() == "synthesis"]
                        synth.sort(key=lambda t: t.get("updated_at", ""), reverse=True)
                        if synth:
                            latest = synth[0]
                            st = str(latest.get("status", "")).lower()
                            if st in ("completed", "complete", "done"):
                                return {
                                    "status": "completed_after_timeout",
                                    "task_id": latest.get("task_id"),
                                    "message": latest.get("message", ""),
                                }
                except httpx.HTTPError:
                    pass
                raise RuntimeError(f"deep_synthesis failed: {net_err}")

        elif tid == "semantic_correlate":
            # Correlation runs similarity over ALL Concept × CodeEntity pairs.
            # With aggressive strategy on a large corpus (>100k chunks) this can
            # exceed the client read timeout even though the server is making
            # progress — so we fall back to (a) the task_manager task list and
            # (b) a direct Neo4j edge-count probe before declaring failure.
            try:
                r = await client.post(
                    f"{API_BASE}/api/rag/correlate", headers=_H,
                    params={
                        "workspace": args.workspace,
                        "threshold": args.threshold,
                        "top_k":     getattr(args, "top_k", 32),
                        "use_ann":   str(getattr(args, "use_ann", True)).lower(),
                    },
                    timeout=httpx.Timeout(connect=10.0, read=1800.0, write=60.0, pool=10.0)
                )
                r.raise_for_status()
                return r.json()
            except (httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.ConnectError) as net_err:
                # Fallback A: look for a correlation task on the task manager.
                try:
                    tr = await client.get(
                        f"{API_BASE}/api/tasks",
                        headers=_H,
                        params={"workspace": args.workspace},
                        timeout=10.0,
                    )
                    if tr.status_code == 200:
                        tasks = tr.json() or []
                        corr = [
                            t for t in tasks
                            if any(k in str(t.get("type", "")).lower()
                                   for k in ("correlat", "spark", "link"))
                        ]
                        corr.sort(key=lambda t: t.get("updated_at", ""), reverse=True)
                        if corr:
                            latest = corr[0]
                            st = str(latest.get("status", "")).lower()
                            if st in ("completed", "complete", "done"):
                                return {
                                    "status":  "completed_after_timeout",
                                    "task_id": latest.get("task_id"),
                                    "source":  "task_manager",
                                    "message": latest.get("message", ""),
                                }
                except httpx.HTTPError:
                    pass
                # Fallback B: probe the graph directly — if CORRELATES_WITH
                # edges exist for this workspace, the server finished even
                # though it didn't send a response.
                try:
                    gr = await client.get(
                        f"{API_BASE}/api/graph/code/lod", headers=_H,
                        params={"workspace": args.workspace, "tier": 1},
                        timeout=60.0,
                    )
                    if gr.status_code == 200:
                        gd = gr.json() or {}
                        corr_edges = [
                            e for e in (gd.get("edges") or [])
                            if e.get("type") == "CORRELATES_WITH"
                        ]
                        if corr_edges:
                            return {
                                "status":      "completed_after_timeout",
                                "source":      "graph_probe",
                                "total_links": len(corr_edges),
                            }
                except httpx.HTTPError:
                    pass
                raise RuntimeError(f"semantic_correlate failed: {net_err}")

        elif tid == "validate_enrichment":
            r = await client.get(
                f"{API_BASE}/api/graph/code/lod", headers=_H,
                params={"workspace": args.workspace, "tier": 1},
            )
            r.raise_for_status()
            data = r.json()
            corr = [e for e in data.get("edges", []) if e.get("type") == "CORRELATES_WITH"]
            if not corr:
                raise RuntimeError("Zero CORRELATES_WITH edges found.")
            return {"correlates_with_count": len(corr)}

        elif tid == "generate_report":
            # Pull graph stats (for concept/source/relationship aggregates) AND
            # the code-LOD view (same source the validator uses, so the two
            # numbers can never disagree). Then write a rich Markdown report.
            stats: Dict[str, Any] = {}
            try:
                r = await client.get(
                    f"{API_BASE}/api/graph/stats", headers=_H,
                    params={"workspace": args.workspace},
                )
                r.raise_for_status()
                stats = r.json() or {}
            except Exception as _e:
                stats = {"_error": str(_e)}

            # /api/graph/stats returns: concepts, sources, relationships, conflicts, analogies
            concept_cnt      = int(stats.get("concepts", 0) or 0)
            source_cnt       = int(stats.get("sources", 0) or 0)
            rel_total        = int(stats.get("relationships", 0) or 0)
            conflict_cnt     = int(stats.get("conflicts", 0) or 0)
            analogy_cnt      = int(stats.get("analogies", 0) or 0)

            # Pull the same code-LOD view the validator uses so CORRELATES_WITH
            # count + node/edge-type breakdowns are guaranteed consistent.
            lod_nodes: List[Dict[str, Any]] = []
            lod_edges: List[Dict[str, Any]] = []
            try:
                r2 = await client.get(
                    f"{API_BASE}/api/graph/code/lod", headers=_H,
                    params={"workspace": args.workspace, "tier": 1},
                )
                r2.raise_for_status()
                _lod = r2.json() or {}
                lod_nodes = list(_lod.get("nodes") or [])
                lod_edges = list(_lod.get("edges") or [])
            except Exception:
                pass

            from collections import Counter
            node_type_counts: Counter = Counter()
            for n in lod_nodes:
                lbl = n.get("label") or n.get("type") or (n.get("labels") or [None])[0] or "Unknown"
                node_type_counts[str(lbl)] += 1
            edge_type_counts: Counter = Counter()
            for e in lod_edges:
                edge_type_counts[str(e.get("type") or "UNKNOWN")] += 1

            corr_cnt = edge_type_counts.get("CORRELATES_WITH", 0)
            # CodeEntity = Function + Class + File (the code-side labels)
            code_entity_cnt = sum(node_type_counts.get(k, 0) for k in ("Function", "Class", "File"))

            # Top-N correlations by confidence/score if present on the edges
            def _edge_score(e: Dict[str, Any]) -> float:
                try:
                    return float(
                        e.get("score")
                        or e.get("confidence")
                        or (e.get("properties") or {}).get("score")
                        or (e.get("properties") or {}).get("confidence")
                        or 0.0
                    )
                except Exception:
                    return 0.0

            corr_edges = [e for e in lod_edges if e.get("type") == "CORRELATES_WITH"]
            top_corr = sorted(corr_edges, key=_edge_score, reverse=True)[:20]

            # Similarity histogram (0.70–1.00 in 0.02 buckets)
            buckets: List[int] = [0] * 15  # 0.70–1.00 step 0.02 → 15 bins
            for e in corr_edges:
                s = _edge_score(e)
                if 0.70 <= s <= 1.0001:
                    idx = min(14, max(0, int((s - 0.70) / 0.02)))
                    buckets[idx] += 1
            hist_rows = []
            for i, cnt in enumerate(buckets):
                lo = 0.70 + i * 0.02
                hi = lo + 0.02
                bar = "█" * max(0, min(40, int(cnt / max(1, max(buckets)) * 40)))
                hist_rows.append(f"| `{lo:0.2f}–{hi:0.2f}` | {cnt} | `{bar}` |")

            generated = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
            lines: List[str] = [
                f"# Knowledge Enrichment Report — `{args.workspace}`",
                "",
                f"**Generated**: {generated}  ",
                f"**Model**: `{model}`  ",
                f"**Threshold**: `{args.threshold}`  |  **Strategy**: `{args.strategy}`  ",
                f"**Run ID**: `{run_id}`  |  **Manifest ID**: `{manifest_id}`",
                "",
                "## 1. Graph Statistics",
                "",
                "| Metric | Count |",
                "|--------|------:|",
                f"| Concept nodes | {concept_cnt} |",
                f"| Source / Document nodes | {source_cnt} |",
                f"| Code-side entities (File + Class + Function) | {code_entity_cnt} |",
                f"| `CORRELATES_WITH` edges | {corr_cnt} |",
                f"| Total relationships (all types) | {rel_total} |",
                f"| `CONFLICTS_WITH` edges | {conflict_cnt} |",
                f"| `ANALOGOUS_TO` edges | {analogy_cnt} |",
                "",
                "## 2. Node-type Distribution (code-LOD view)",
                "",
                "| Label | Count |",
                "|-------|------:|",
                *[f"| `{k}` | {v} |" for k, v in sorted(node_type_counts.items(), key=lambda kv: -kv[1])],
                "",
                "## 3. Edge-type Distribution (code-LOD view)",
                "",
                "| Type | Count |",
                "|------|------:|",
                *[f"| `{k}` | {v} |" for k, v in sorted(edge_type_counts.items(), key=lambda kv: -kv[1])],
                "",
                "## 4. CORRELATES_WITH Similarity Histogram",
                "",
                "| Bucket | Count | |",
                "|--------|------:|--|",
                *hist_rows,
                "",
                "## 5. Top 20 Correlations (by score/confidence)",
                "",
                "| # | Source | Target | Score |",
                "|--:|--------|--------|------:|",
            ]
            for i, e in enumerate(top_corr, start=1):
                src = e.get("source") or e.get("from") or (e.get("properties") or {}).get("source") or "—"
                dst = e.get("target") or e.get("to")   or (e.get("properties") or {}).get("target") or "—"
                sc  = _edge_score(e)
                lines.append(f"| {i} | `{src}` | `{dst}` | {sc:0.3f} |")
            if not top_corr:
                lines.append("| — | _(no CORRELATES_WITH edges found)_ | | |")

            lines += [
                "",
                "## 6. Interpretation",
                "",
                f"{corr_cnt:,} semantic correlation edge(s) now link {concept_cnt} architecture "
                f"concept node(s) to {code_entity_cnt} code entity node(s) in workspace `{args.workspace}`.",
                "",
                "Enable the **ENRICH** toggle in Benny Studio → Code Graph to see amber-dashed "
                "overlays connecting architecture concepts to source code symbols.",
                "",
                "## 7. Run Provenance",
                "",
                f"- Run folder: `{run_folder}`",
                f"- Lineage (Marquez): http://localhost:3010",
                f"- GDPR notice: `{run_folder / 'GDPR_notice.json'}`",
            ]
            if stats.get("_error"):
                lines += ["", f"> ⚠  `/api/graph/stats` error: `{stats['_error']}`"]

            report = "\n".join(lines)
            # Write to BOTH the run folder (audit/immutable) and the workspace
            # data_out dir (stable path referenced by manifest templates).
            (run_folder / "enrichment_report.md").write_text(report, encoding="utf-8")
            try:
                _data_out = benny_home / "workspaces" / args.workspace / "data_out"
                _data_out.mkdir(parents=True, exist_ok=True)
                (_data_out / "enrichment_report.md").write_text(report, encoding="utf-8")
            except Exception:
                pass
            return {
                "report_path":      str(run_folder / "enrichment_report.md"),
                "corr_count":       corr_cnt,
                "concept_count":    concept_cnt,
                "code_count":       code_entity_cnt,
                "top_score":        _edge_score(top_corr[0]) if top_corr else 0.0,
            }

        else:
            raise ValueError(f"Unknown task id: {tid!r}")

    # ─── 9. Execute waves with Rich Live display ──────────────────────────────
    completed_tasks: List[str] = []
    all_errors:      List[str] = []
    final_status = "completed"

    wave_groups: Dict[int, List[str]] = {}
    for t in TASK_DEFS:
        wave_groups.setdefault(t["wave"], []).append(t["id"])

    progress = Progress(
        SpinnerColumn(spinner_name="dots2"),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=28),
        TextColumn("[bold]{task.completed}[/]/[dim]{task.total}[/]"),
        TimeElapsedColumn(),
        console=console,
        transient=False,
    )
    overall = progress.add_task("[cyan]Enrichment pipeline", total=len(TASK_DEFS))

    with Live(console=console, refresh_per_second=8) as live:
        live.update(Group(progress, _make_table()))

        for wave_num in sorted(wave_groups.keys()):
            wave_tids = wave_groups[wave_num]

            if final_status == "failed":
                for tid in [t["id"] for t in TASK_DEFS if task_status[t["id"]] == "pending"]:
                    task_status[tid] = "skipped"
                live.update(Group(progress, _make_table()))
                break

            progress.update(
                overall,
                description=f"[cyan]Wave {wave_num}[/]  [dim]{', '.join(wave_tids)}[/]",
            )

            # --- Resume: split this wave into (reused, to_execute) ---
            to_execute: List[str] = []
            reused_map: Dict[str, Dict[str, Any]] = {}
            for tid in wave_tids:
                pr = prior_results.get(tid)
                if pr and pr["status"] in _resume_skip_statuses and tid not in _always_rerun:
                    reused_map[tid] = pr["result"] or {}
                    task_status[tid] = "running"  # cosmetic, updated to 'done' below
                    # Rehydrate known cross-task artefacts so dependents can run
                    if isinstance(pr["result"], dict):
                        for _key in ("pdf_files", "staging_files"):
                            if _key in pr["result"] and pr["result"][_key]:
                                task_results[_key] = pr["result"][_key]
                else:
                    # Rehydrate cross-task artefacts even when we're re-executing
                    # (e.g. generate_report needs upstream emits to render links).
                    if pr and isinstance(pr["result"], dict):
                        for _key in ("pdf_files", "staging_files"):
                            if _key in pr["result"] and pr["result"][_key] and _key not in task_results:
                                task_results[_key] = pr["result"][_key]
                    to_execute.append(tid)
                    task_status[tid] = "running"
            live.update(Group(progress, _make_table()))

            async with httpx.AsyncClient(timeout=360.0) as shared_client:
                wave_t0 = time.monotonic()
                exec_results = await asyncio.gather(
                    *[_run_task(tid, shared_client) for tid in to_execute], return_exceptions=True
                ) if to_execute else []

            # Merge reused + freshly-executed results, preserving wave order
            exec_iter = iter(zip(to_execute, exec_results))
            merged: List[tuple] = []
            for tid in wave_tids:
                if tid in reused_map:
                    merged.append((tid, reused_map[tid], True))   # True = reused
                else:
                    _tid, _res = next(exec_iter)
                    merged.append((_tid, _res, False))
            results    = [m[1] for m in merged]
            reused_set = {m[0] for m in merged if m[2]}

            for tid, result in zip(wave_tids, results):
                is_reused = tid in reused_set
                elapsed = 0.0 if is_reused else (time.monotonic() - wave_t0)
                task_elapsed[tid] = elapsed
                task_ts = datetime.now(timezone.utc).isoformat()

                if is_reused:
                    task_status[tid] = "reused"
                    completed_tasks.append(tid)
                    task_note[tid] = "reused from prior run"
                    # Persist a pointer so the new run folder records the reuse
                    try:
                        (run_folder / f"task_{tid}.json").write_text(
                            json.dumps({
                                "task_id":     tid,
                                "wave":        wave_num,
                                "status":      "reused",
                                "timestamp":   task_ts,
                                "elapsed_s":   0.0,
                                "result":      result,
                                "reused_from": args.resume_run_id,
                                "lineage_ref": manifest_id,
                                "run_id":      run_id,
                            }, indent=2, default=str),
                            encoding="utf-8",
                        )
                    except Exception:
                        pass
                    progress.advance(overall)
                    live.update(Group(progress, _make_table()))
                    continue

                if isinstance(result, Exception):
                    task_status[tid] = "failed"
                    _raw = str(result)
                    err  = _raw if _raw else f"{type(result).__name__} (no message)"
                    task_error[tid] = err
                    task_note[tid]  = (err[:20] + "\u2026") if len(err) > 20 else err
                    all_errors.append(f"{tid}: {err}")
                    final_status = "failed"
                    try:
                        lineage.emit_tool_execution(
                            manifest_id, tid, {"workspace": args.workspace}, False, err
                        )
                    except Exception:
                        pass
                else:
                    task_status[tid] = "done"
                    completed_tasks.append(tid)
                    # Build a short note from meaningful result keys
                    note_parts: List[str] = []
                    if isinstance(result, dict):
                        s = result.get("status", "")
                        if s == "already_converted":
                            note_parts.append(f"{result.get('data_in_files', 0)} files in data_in")
                        elif result.get("staging_files"):
                            note_parts.append(f"{result['staging_files']} staging files")
                        for key, label in [
                            ("staging_files",        "{v} staging files"),
                            ("data_in_files",        "{v} data_in files"),
                            ("md_files",             "{v} md files"),
                            ("rag_chunks",           "{v} rag chunks"),
                            ("pdf_count",            "{v} PDFs found"),
                            ("code_nodes",           "{v} code nodes"),
                            ("correlates_with_count", "{v} corr. edges"),
                            ("corr_count",            "{v} corr. edges"),
                            ("concept_count",         "{v} concepts"),
                            ("report_path",           "report written"),
                        ]:
                            if key in result:
                                val = result[key]
                                note_parts.append(label.format(v=val) if "{v}" in label else label)
                    task_note[tid] = ", ".join(note_parts[:2])
                    try:
                        lineage.emit_tool_execution(
                            manifest_id, tid, {"workspace": args.workspace}, True
                        )
                    except Exception:
                        pass

                # Write per-task audit record
                task_record: Dict[str, Any] = {
                    "task_id":     tid,
                    "wave":        wave_num,
                    "status":      task_status[tid],
                    "timestamp":   task_ts,
                    "elapsed_s":   round(elapsed, 3),
                    "result":      None if isinstance(result, Exception) else result,
                    "error":       task_error[tid],
                    "lineage_ref": manifest_id,
                    "run_id":      run_id,
                }
                record_json = json.dumps(task_record, indent=2, default=str)
                # SHA-256 integrity seal
                task_record["_sha256"] = hashlib.sha256(record_json.encode()).hexdigest()
                (run_folder / f"task_{tid}.json").write_text(
                    json.dumps(task_record, indent=2, default=str), encoding="utf-8"
                )
                try:
                    emit_governance_event(
                        event_type="ENRICH_TASK_DONE" if task_status[tid] == "done" else "ENRICH_TASK_FAILED",
                        data=task_record,
                        workspace_id=args.workspace,
                    )
                except Exception:
                    pass

                progress.advance(overall)
                live.update(Group(progress, _make_table()))

    # ─── 10. Write summary.json + close lineage ───────────────────────────────
    duration_s = (datetime.now(timezone.utc) - started_at).total_seconds()
    summary: Dict[str, Any] = {
        "run_id":           run_id,
        "manifest_id":      manifest_id,
        "workspace":        args.workspace,
        "src_path":         src_path,
        "model":            model,
        "threshold":        args.threshold,
        "strategy":         args.strategy,
        "status":           final_status,
        "started_at":       started_at.isoformat(),
        "duration_s":       round(duration_s, 2),
        "tasks_completed":  completed_tasks,
        "tasks_failed":     [k for k, v in task_status.items() if v == "failed"],
        "errors":           all_errors,
        "run_folder":       str(run_folder),
        "marquez_url":      "http://localhost:3010",
        "gdpr_notice":      str(run_folder / "GDPR_notice.json"),
    }
    sum_json = json.dumps(summary, indent=2, default=str)
    summary["_sha256"] = hashlib.sha256(sum_json.encode()).hexdigest()
    (run_folder / "summary.json").write_text(
        json.dumps(summary, indent=2, default=str), encoding="utf-8"
    )

    try:
        if final_status == "completed":
            lineage.complete_workflow(
                manifest_id,
                f"Knowledge Enrichment \u2014 {args.workspace}",
                args.workspace,
                completed_tasks,
                int(duration_s * 1000),
                ["data_out/enrichment_report.md"],
            )
        else:
            lineage.fail_workflow(
                manifest_id,
                f"Knowledge Enrichment \u2014 {args.workspace}",
                args.workspace,
                "; ".join(all_errors),
            )
    except Exception:
        pass

    try:
        emit_governance_event(
            "ENRICH_RUN_COMPLETE", summary, workspace_id=args.workspace
        )
    except Exception:
        pass

    # ─── 11. Final summary panel ─────────────────────────────────────────────
    ok = final_status == "completed"
    console.print()
    console.print(Rule(f"[bold {'green' if ok else 'red'}]Enrichment {'Complete \u2713' if ok else 'Failed \u2717'}"))

    sum_tbl = Table(box=box.SIMPLE, show_header=False, expand=True)
    sum_tbl.add_column("Key",   style="dim",        width=22)
    sum_tbl.add_column("Value", style="bold white")

    sum_tbl.add_row(
        "Status",
        f"[bold {'green' if ok else 'red'}]{final_status.upper()}[/]",
    )
    sum_tbl.add_row("Duration",        f"{duration_s:.1f}s")
    sum_tbl.add_row("Tasks completed", f"{len(completed_tasks)} / {len(TASK_DEFS)}")
    sum_tbl.add_row("Run ID",          run_id)
    sum_tbl.add_row("Manifest ID",     manifest_id)
    sum_tbl.add_row("Run folder",      str(run_folder))
    sum_tbl.add_row("Lineage",         "[link=http://localhost:3010]http://localhost:3010[/link]  [dim](Marquez)[/dim]")
    if ok:
        sum_tbl.add_row(
            "Studio ENRICH toggle",
            "[link=http://localhost:3000]http://localhost:3000[/link]  \u2192 Studio \u2192 Code Graph \u2192 [cyan]ENRICH[/cyan]",
        )
    sum_tbl.add_row("GDPR notice",     str(run_folder / "GDPR_notice.json"))

    console.print(Panel(
        sum_tbl,
        title="[bold]Run Summary[/]",
        border_style="green" if ok else "red",
        padding=(0, 2),
    ))

    if all_errors:
        console.print()
        console.print("[bold red]Errors:[/]")
        for err in all_errors:
            console.print(f"  [red]\u2717[/] {err}")

    if args.json:
        console.print()
        console.print(json.dumps(summary, indent=2, default=str))

    console.print()
    return 0 if ok else 1


# =============================================================================
# UTILS
# =============================================================================


def _load_manifest(ref: str) -> SwarmManifest:
    """Load a manifest from a file path OR a manifest id in the run_store."""
    path = Path(ref)
    if path.exists():
        return SwarmManifest.model_validate(json.loads(path.read_text(encoding="utf-8")))

    from benny.persistence import run_store

    m = run_store.get_manifest(ref)
    if m:
        return m
    raise FileNotFoundError(f"Manifest not found by path or id: {ref}")


# =============================================================================
# ARGUMENT PARSER
# =============================================================================


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="benny",
        description="Benny — declarative swarm workflow runner",
    )
    # --tui flag: launch TUI mini-mode (AAMP-F7); bypasses required subcommand
    p.add_argument("--tui", action="store_true", help="Launch AgentAmp TUI mini-mode (AAMP-F7)")
    p.add_argument("--workspace", default="default", help="Active workspace (used with --tui)")
    sub = p.add_subparsers(dest="cmd", required=False)

    # plan
    p_plan = sub.add_parser("plan", help="Build a SwarmManifest from a requirement (no execution)")
    p_plan.add_argument("requirement", help="Natural-language requirement")
    p_plan.add_argument("--workspace", default="default")
    p_plan.add_argument("--model", default=None, help="LLM model ID (defaults to active manager selection)")
    p_plan.add_argument("--name", default=None)
    p_plan.add_argument("--input", "-i", action="append", default=[], help="Input file (repeatable)")
    p_plan.add_argument("--output", "-o", action="append", default=[], help="Output file (repeatable)")
    p_plan.add_argument("--format", choices=[f.value for f in OutputFormat], default="md")
    p_plan.add_argument("--word-count", type=int, default=None)
    p_plan.add_argument("--spec", default=None)
    p_plan.add_argument("--max-concurrency", type=int, default=1)
    p_plan.add_argument("--max-depth", type=int, default=3)
    p_plan.add_argument("--out", default=None, help="Write manifest JSON to this path")
    p_plan.add_argument("--no-save", dest="save", action="store_false", default=True)

    # run
    p_run = sub.add_parser("run", help="Execute a SwarmManifest (by path or by id)")
    p_run.add_argument("manifest", help="Path to manifest.json OR manifest id")
    p_run.add_argument("--workspace", default=None, help="Override the workspace baked into the manifest")
    p_run.add_argument("--json", action="store_true", help="Emit the final RunRecord as JSON")

    # runs
    p_runs = sub.add_parser("runs", help="Inspect past runs")
    runs_sub = p_runs.add_subparsers(dest="runs_cmd", required=True)

    p_runs_ls = runs_sub.add_parser("ls", help="List past runs")
    p_runs_ls.add_argument("--manifest", default=None, help="Filter by manifest id")
    p_runs_ls.add_argument("--workspace", default=None)
    p_runs_ls.add_argument("--limit", type=int, default=20)

    p_runs_show = runs_sub.add_parser("show", help="Show a run record")
    p_runs_show.add_argument("run_id")

    # manifests
    p_manifests = sub.add_parser("manifests", help="Manifest management")
    manifests_sub = p_manifests.add_subparsers(dest="manifests_cmd", required=True)
    manifests_sub.add_parser("ls", help="List saved manifests")

    # portable $BENNY_HOME lifecycle (PBR-001 Phase 1a)
    p_init = sub.add_parser("init", help="Create or refresh a portable $BENNY_HOME on the SSD")
    p_init.add_argument("--home", required=True, help="Absolute path to $BENNY_HOME (e.g. D:/optimus)")
    p_init.add_argument("--profile", choices=["app", "native"], required=True)

    p_doctor = sub.add_parser("doctor", help="Validate the portable $BENNY_HOME layout")
    p_doctor.add_argument("--home", required=True, help="Absolute path to $BENNY_HOME")

    p_uninstall = sub.add_parser(
        "uninstall",
        help="Remove the app/runtime boundary (workspaces survive with --keep-data)",
    )
    p_uninstall.add_argument("--home", required=True, help="Absolute path to $BENNY_HOME")
    p_uninstall.add_argument(
        "--keep-data",
        action="store_true",
        help="Preserve workspaces, data, models, config, and state",
    )

    # Service lifecycle (PBR-001 Phase 1b)
    p_up = sub.add_parser("up", help="Start the portable service stack (neo4j, lemonade, api, ui)")
    p_up.add_argument("--home", required=True, help="Absolute path to $BENNY_HOME")
    p_up.add_argument("--only", action="append", default=[], help="Only start the named service (repeatable)")
    p_up.add_argument("--no-wait", dest="wait_healthy", action="store_false", default=True)

    p_down = sub.add_parser("down", help="Stop the portable service stack")
    p_down.add_argument("--home", required=True, help="Absolute path to $BENNY_HOME")
    p_down.add_argument("--only", action="append", default=[], help="Only stop the named service (repeatable)")

    p_status = sub.add_parser("status", help="Report service status")
    p_status.add_argument("--home", required=True, help="Absolute path to $BENNY_HOME")
    p_status.add_argument("--only", action="append", default=[], help="Only report the named service (repeatable)")

    # MCP server (PBR-001 Phase 4)
    p_mcp = sub.add_parser("mcp", help="Start the Model Context Protocol (MCP) server")
    p_mcp.add_argument("--stdio", action="store_true", default=True, help="Use stdio transport (default)")
    p_mcp.add_argument("--port", type=int, default=8000, help="Benny API port to proxy to")

    # req — Requirements Analyst: free-text → PRD + Gherkin (AOS-F20)
    p_req = sub.add_parser(
        "req",
        help="Requirements Analyst: convert a free-text requirement to PRD JSON + Gherkin (AOS-F20)",
    )
    p_req.add_argument("requirement", help="Free-text requirement (e.g. 'Build a VRAM-aware worker pool')")
    p_req.add_argument("--workspace", default=None, help="Write PRD + feature file to this workspace's data_out/prd/")
    p_req.add_argument("--model", default=None, help="LLM model ID (default: local_lemonade)")

    # enrich — knowledge enrichment pipeline
    p_enrich = sub.add_parser(
        "enrich",
        help="Build and optionally run the knowledge enrichment pipeline (code scan -> synthesis -> correlate)",
    )
    p_enrich.add_argument("--workspace", default="c5_test", help="Target workspace (default: c5_test)")
    p_enrich.add_argument("--src", default="src/", help="Source path to scan with Tree-Sitter (relative to workspace, default: src/)")
    p_enrich.add_argument("--model", default=None, help="LLM model ID (defaults to active manager selection)")
    p_enrich.add_argument("--threshold", type=float, default=0.82, help="Semantic correlation confidence threshold (default: 0.82, raised from 0.70 — the 0.70 knee produced ~36x noise-tail edges)")
    p_enrich.add_argument("--strategy", choices=["safe", "aggressive"], default="aggressive", help="Correlation strategy (default: aggressive)")
    p_enrich.add_argument("--top-k", dest="top_k", type=int, default=32, help="Max symbol matches per concept (default: 32). Caps CORRELATES_WITH fan-out — upper bound on edges is N_concepts * top_k.")
    p_enrich.add_argument("--no-ann", dest="use_ann", action="store_false", default=True, help="Force the numpy top-K fallback even if hnswlib is installed (default: use HNSW when available).")
    p_enrich.add_argument("--out", default=None, help="Write manifest JSON to this path (skips execution)")
    p_enrich.add_argument("--run", dest="run_after", action="store_true", default=False, help="Execute the manifest immediately after building it")
    p_enrich.add_argument("--json", action="store_true", help="Emit the final RunRecord as JSON (implies --run)")
    p_enrich.add_argument("--manifest", default=None, help="Load a declarative manifest from disk (e.g. manifests/templates/knowledge_enrichment_pipeline.json) instead of building one inline. Variables (workspace, src_path, model, threshold, strategy, api_base, api_key, benny_home, resume_from_run_id) are substituted from CLI flags + env.")
    p_enrich.add_argument("--resume", dest="resume_run_id", default=None, help="Reuse already-completed tasks from a prior run (e.g. --resume 6d0856035fe6). Reads workspace/<ws>/runs/enrich-<run_id>/task_*.json and skips any task whose status is in execution.resume.skip_if_status.")

    # pypes — declarative transformation engine (manifest-driven DAG)
    from benny.pypes.cli import add_subparser as _pypes_add_subparser
    _pypes_add_subparser(sub)

    # agentamp — skinnable, pluggable agentic cockpit (AAMP-001 Phase 1)
    from benny.agentamp.cli import add_subparser as _agentamp_add_subparser
    _agentamp_add_subparser(sub)

    # tui — AgentAmp mini-mode (AAMP-001 Phase 4, AAMP-F7)
    p_tui = sub.add_parser("tui", help="Launch AgentAmp TUI mini-mode (alias for benny --tui)")
    p_tui.add_argument("--workspace", default="default", help="Active workspace")

    # migrate (PBR-001 Phase 8)
    p_mig = sub.add_parser("migrate", help="Import legacy installs or relocate workspaces")
    p_mig.add_argument("--from-path", "--from", required=True, help="Source directory to migrate")
    p_mig.add_argument("--to-home", "--to", default=None, help="Target $BENNY_HOME (defaults to current)")
    p_mig.add_argument("--apply", action="store_true", help="Perform actual changes (default is dry-run)")
    p_mig.add_argument("--dry-run", dest="apply", action="store_false")

    return p


def main(argv: Optional[List[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    # --tui / benny tui (AAMP-F7)
    if getattr(args, "tui", False) or args.cmd == "tui":
        from benny.agentamp.tui import run_tui, _default_palette
        ws = getattr(args, "workspace", "default")
        return run_tui(_default_palette(), workspace=ws)

    if args.cmd is None:
        parser.print_help()
        return 1

    if args.cmd == "plan":
        return asyncio.run(cmd_plan(args))
    if args.cmd == "run":
        return asyncio.run(cmd_run(args))
    if args.cmd == "runs":
        if args.runs_cmd == "ls":
            return cmd_runs_ls(args)
        if args.runs_cmd == "show":
            return cmd_runs_show(args)
    if args.cmd == "manifests":
        if args.manifests_cmd == "ls":
            return cmd_manifests_ls(args)
    if args.cmd == "init":
        return cmd_init(args)
    if args.cmd == "doctor":
        return cmd_doctor(args)
    if args.cmd == "uninstall":
        return cmd_uninstall(args)
    if args.cmd == "up":
        return cmd_up(args)
    if args.cmd == "down":
        return cmd_down(args)
    if args.cmd == "status":
        return cmd_status(args)
    if args.cmd == "mcp":
        return cmd_mcp(args)
    if args.cmd == "migrate":
        return cmd_migrate(args)
    if args.cmd == "req":
        return asyncio.run(cmd_req(args))
    if args.cmd == "enrich":
        return asyncio.run(cmd_enrich(args))
    if args.cmd == "pypes":
        from benny.pypes.cli import cmd_pypes
        return cmd_pypes(args)
    if args.cmd == "agentamp":
        from benny.agentamp.cli import cmd_agentamp
        return cmd_agentamp(args)

    parser.print_help()
    return 1


# =============================================================================
# PORTABLE LIFECYCLE COMMANDS (PBR-001 Phase 1a)
# =============================================================================


def cmd_init(args: argparse.Namespace) -> int:
    from benny.portable import home as home_mod

    try:
        bh = home_mod.init(Path(args.home), profile=args.profile)
    except home_mod.PortableHomeError as exc:
        print(f"benny init failed: {exc}", file=sys.stderr)
        return 1

    project_root = Path(__file__).parent
    is_win = sys.platform == "win32"
    launcher = str(project_root / ("benny.bat" if is_win else "benny.sh"))
    bin_launcher = str(bh.root / "bin" / ("benny.cmd" if is_win else "benny"))

    print(f"""
Benny initialised at {bh.root}  (profile={bh.profile})
Python: {sys.executable}

Quick-start (run from the project directory):
  {launcher} up --home {bh.root} --only api --only ui

Or add {bh.root / 'bin'} to your PATH, then:
  benny{''.join(['.cmd' if is_win else ''])} up --home {bh.root} --only api --only ui

Run benny doctor --home {bh.root} to verify the install.
""".strip())
    return 0


def cmd_uninstall(args: argparse.Namespace) -> int:
    from benny.portable import home as home_mod

    home_mod.uninstall(Path(args.home), keep_data=bool(args.keep_data))
    print(
        f"uninstalled from {args.home} "
        f"({'data preserved' if args.keep_data else 'data removed'})"
    )
    return 0


def _resolve_home(path_arg: str) -> Any:
    from benny.portable import home as home_mod

    root = Path(path_arg)
    report = home_mod.validate(root)
    if not report.ok:
        raise home_mod.PortableHomeError(
            "home is not initialised or is corrupt: " + "; ".join(report.problems)
        )
    profile = (root / "state" / "profile-lock").read_text(encoding="utf-8").strip()
    return home_mod.BennyHome(root=root, profile=profile)  # type: ignore[arg-type]


def cmd_up(args: argparse.Namespace) -> int:
    from benny.portable import config as cfg_mod
    from benny.portable import runner as runner_mod
    from benny.portable import services as svc_mod

    bh = _resolve_home(args.home)
    cfg = cfg_mod.load(bh.root)
    registry = svc_mod.default_services(cfg)

    selected = args.only or list(registry.keys())
    missing = [n for n in selected if n not in registry]
    if missing:
        print(f"benny up: unknown service(s): {missing}", file=sys.stderr)
        return 2

    specs = [registry[n] for n in selected]
    statuses = runner_mod.up(bh, specs, wait_healthy=args.wait_healthy)
    failed = 0
    for s in statuses:
        state = "healthy" if s.healthy else ("alive" if s.alive else "down")
        print(f"{s.name:<12} {state:<8} pid={s.pid}  {s.health_detail}")
        if not s.alive:
            failed += 1
    return 0 if failed == 0 else 1


def cmd_down(args: argparse.Namespace) -> int:
    from benny.portable import runner as runner_mod

    bh = _resolve_home(args.home)
    stopped = runner_mod.down(bh, args.only or None)
    if not stopped:
        print("benny down: nothing to stop")
        return 0
    for name in stopped:
        print(f"stopped {name}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    from benny.portable import runner as runner_mod

    bh = _resolve_home(args.home)
    statuses = runner_mod.status(bh, args.only or None)
    if not statuses:
        print("benny status: no services tracked (nothing has been started yet)")
        return 0
    print(f"{'SERVICE':<12} {'STATE':<8} {'PID':<8} DETAIL")
    for s in statuses:
        state = "healthy" if s.healthy else ("alive" if s.alive else "down")
        pid = str(s.pid) if s.pid else "-"
        print(f"{s.name:<12} {state:<8} {pid:<8} {s.health_detail}")
    return 0


def cmd_mcp(args: argparse.Namespace) -> int:
    import subprocess
    import os

    # Implementation invokes python -m benny.mcp.server --stdio
    cmd = [sys.executable, "-m", "benny.mcp.server"]
    if args.stdio:
        cmd.append("--stdio")
    
    # Forward the API port via environment if needed, though server.py 
    # should probably handle config resolution itself.
    env = os.environ.copy()
    env["BENNY_API_PORT"] = str(args.port)

    print(f"[mcp] starting server (stdio transport)...")
    try:
        # MCP server typically communicates over stdin/stdout, so we 
        # replace the current process or use run. 
        # Using subprocess.run so it waits for completion.
        subprocess.run(cmd, env=env, check=True)
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        print(f"[mcp] failed: {e}", file=sys.stderr)
        return 1
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    import asyncio
    import os
    from rich.console import Console
    from rich.table import Table
    from benny.ops.doctor import run_doctor

    console = Console()
    with console.status("[bold green]Running diagnostics..."):
        if args.home:
            os.environ["BENNY_HOME"] = os.path.abspath(args.home)
        report = asyncio.run(run_doctor())

    table = Table(title="Benny System Health (Phase 6)")
    table.add_column("Check", style="cyan")
    table.add_column("Status", style="bold")
    table.add_column("Message")

    for c in report.checks:
        color = "green" if c.status == "OK" else ("yellow" if c.status == "WARN" else "red")
        table.add_row(c.name, f"[{color}]{c.status}[/{color}]", c.message)

    console.print(table)
    if report.status_code == 0:
        console.print("[bold green]✓ All systems optimal.[/bold green]")
    elif report.status_code == 2:
        console.print("[bold yellow]! System operational with warnings.[/bold yellow]")
    else:
        console.print("[bold red]× Diagnostic errors found.[/bold red]")

    return report.status_code


def cmd_migrate(args: argparse.Namespace) -> int:
    from benny.migrate.importer import MigrationEngine
    import os

    source = Path(args.from_path)
    target = Path(args.to_home or os.environ.get("BENNY_HOME", ".")).absolute()
    
    engine = MigrationEngine(target)
    print(f"[migrate] source={source}")
    print(f"[migrate] target_home={target}")
    print(f"[migrate] mode={'APPLY' if args.apply else 'DRY-RUN'}")
    
    report = engine.migrate_workspace(source, target, dry_run=not args.apply)
    
    for t in report.transforms:
        print(f"  [{t['action']}] {t['file']} {t['details']}")
    
    if report.errors:
        print("\n[migrate] errors:", file=sys.stderr)
        for e in report.errors:
            print(f"  - {e}", file=sys.stderr)
            
    print(f"\n[migrate] complete. rewrites={report.count_rewrites}")
    if not args.apply:
        print("[migrate] DRY-RUN complete. Use --apply to commit changes.")
    return 0 if not report.errors else 1


if __name__ == "__main__":
    sys.exit(main())
