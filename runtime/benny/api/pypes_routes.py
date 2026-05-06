"""HTTP routes for the Pypes transformation engine.

Every CLI action has a matching endpoint so the Studio frontend
(``PipelineCanvas.tsx``) can render DAGs, trigger runs, stream
progress, and drill down into checkpoints without shelling out.

Routes:
    GET    /api/pypes/registry                       — list operations + engines
    POST   /api/pypes/validate                       — validate a manifest (JSON body)
    POST   /api/pypes/run                            — execute a manifest
    GET    /api/pypes/runs?workspace=W               — list prior runs
    GET    /api/pypes/runs/{run_id}?workspace=W      — receipt for one run
    GET    /api/pypes/runs/{run_id}/steps/{step_id}  — drill-down (rows + CLP)
    POST   /api/pypes/runs/{run_id}/rerun            — re-execute from a step
    POST   /api/pypes/runs/{run_id}/reports/{report_id}  — re-render a report
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field

from ..pypes.checkpoints import CheckpointStore
from ..pypes.engines import available_engines, get_engine
from ..pypes.models import EngineType, PypesManifest, RunReceipt
from ..pypes.orchestrator import Orchestrator
from ..pypes.registry import default_registry
from ..pypes.reports import render_report

router = APIRouter()


# =============================================================================
# REQUEST MODELS
# =============================================================================


class RunRequest(BaseModel):
    manifest: PypesManifest
    variables: Dict[str, Any] = Field(default_factory=dict)
    resume_from_run_id: Optional[str] = None
    only_steps: Optional[List[str]] = None


class RerunRequest(BaseModel):
    from_step: str
    workspace: str = "default"


# =============================================================================
# HELPERS
# =============================================================================


def _workspace_root(workspace: str) -> Path:
    benny_home = os.environ.get("BENNY_HOME")
    base = Path(benny_home) if benny_home else Path.cwd()
    root = base / "workspace" / workspace
    root.mkdir(parents=True, exist_ok=True)
    return root


def _load_receipt(run_dir: Path) -> RunReceipt:
    rp = run_dir / "receipt.json"
    if not rp.exists():
        raise HTTPException(404, "receipt not found")
    return RunReceipt.model_validate_json(rp.read_text(encoding="utf-8"))


def _load_snapshot(run_dir: Path) -> PypesManifest:
    sp = run_dir / "manifest_snapshot.json"
    if not sp.exists():
        raise HTTPException(404, "manifest snapshot not found")
    return PypesManifest.model_validate_json(sp.read_text(encoding="utf-8"))


# =============================================================================
# ROUTES
# =============================================================================


@router.get("/registry")
async def get_registry() -> Dict[str, Any]:
    return {
        "engines": available_engines(),
        "operations": default_registry.names(),
        "schema_version": "1.0",
    }


@router.post("/validate")
async def validate_manifest(manifest: PypesManifest = Body(...)) -> Dict[str, Any]:
    """Return the topological order + any CLP gaps without executing."""
    from ..pypes.orchestrator import _topological_order

    try:
        order = _topological_order(manifest.steps)
    except ValueError as exc:
        raise HTTPException(400, f"DAG error: {exc}") from exc
    gaps: List[str] = []
    for s in manifest.steps:
        if s.stage.value == "gold" and not s.clp_binding:
            gaps.append(f"step '{s.id}' (gold stage) has no clp_binding — drill-back is blind")
    return {
        "valid": True,
        "step_count": len(manifest.steps),
        "topological_order": order,
        "clp_gaps": gaps,
        "engines_requested": sorted({s.engine.value for s in manifest.steps}),
    }


@router.post("/run")
async def run_pypes(request: RunRequest) -> Dict[str, Any]:
    receipt = Orchestrator().run(
        request.manifest,
        variables=request.variables,
        resume_from_run_id=request.resume_from_run_id,
        only_steps=request.only_steps,
    )
    return receipt.model_dump(mode="json")


@router.get("/runs")
async def list_runs(
    workspace: str = Query("default"), limit: int = Query(20, ge=1, le=500)
) -> Dict[str, Any]:
    runs_dir = _workspace_root(workspace) / "runs"
    if not runs_dir.exists():
        return {"workspace": workspace, "runs": []}
    entries = sorted(runs_dir.glob("pypes-*"), key=lambda p: p.stat().st_mtime, reverse=True)
    out: List[Dict[str, Any]] = []
    for run_dir in entries[:limit]:
        rp = run_dir / "receipt.json"
        if not rp.exists():
            continue
        try:
            payload = json.loads(rp.read_text(encoding="utf-8"))
        except Exception:
            continue
        out.append(
            {
                "run_id": payload.get("run_id"),
                "manifest_id": payload.get("manifest_id"),
                "status": payload.get("status"),
                "started_at": payload.get("started_at"),
                "completed_at": payload.get("completed_at"),
                "duration_ms": payload.get("duration_ms"),
                "step_count": len(payload.get("step_results", {})),
                "reports": list((payload.get("reports") or {}).keys()),
            }
        )
    return {"workspace": workspace, "runs": out}


@router.get("/runs/{run_id}")
async def get_run(run_id: str, workspace: str = Query("default")) -> Dict[str, Any]:
    run_dir = _workspace_root(workspace) / "runs" / f"pypes-{run_id}"
    receipt = _load_receipt(run_dir)
    snapshot = _load_snapshot(run_dir)
    return {
        "receipt": receipt.model_dump(mode="json"),
        "manifest": snapshot.model_dump(mode="json"),
    }


@router.get("/runs/{run_id}/steps/{step_id}")
async def drilldown(
    run_id: str,
    step_id: str,
    workspace: str = Query("default"),
    rows: int = Query(50, ge=1, le=5000),
) -> Dict[str, Any]:
    run_dir = _workspace_root(workspace) / "runs" / f"pypes-{run_id}"
    if not run_dir.exists():
        raise HTTPException(404, "run not found")
    store = CheckpointStore(run_dir)
    if not store.has(step_id):
        raise HTTPException(404, f"no checkpoint for step '{step_id}'")
    engine = get_engine(EngineType.PANDAS)
    df = store.read(engine, step_id)
    snapshot = _load_snapshot(run_dir)
    step = snapshot.step(step_id)
    return {
        "run_id": run_id,
        "step_id": step_id,
        "row_count": engine.row_count(df),
        "columns": engine.columns(df),
        "clp_binding": (step.clp_binding if step else {}) or {},
        "stage": step.stage.value if step else None,
        "rows": engine.to_records(df, limit=rows),
    }


@router.post("/runs/{run_id}/rerun")
async def rerun(run_id: str, request: RerunRequest) -> Dict[str, Any]:
    run_dir = _workspace_root(request.workspace) / "runs" / f"pypes-{run_id}"
    manifest = _load_snapshot(run_dir)

    # Same downstream-closure computation as the CLI rerun command.
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
    stack = [request.from_step]
    while stack:
        cur = stack.pop()
        if cur in only:
            continue
        only.append(cur)
        stack.extend(reverse.get(cur, []))

    receipt = Orchestrator(workspace_root=_workspace_root(request.workspace)).run(
        manifest, resume_from_run_id=run_id, only_steps=only
    )
    return receipt.model_dump(mode="json")


@router.post("/runs/{run_id}/reports/{report_id}")
async def rerender_report(
    run_id: str, report_id: str, workspace: str = Query("default")
) -> Dict[str, Any]:
    run_dir = _workspace_root(workspace) / "runs" / f"pypes-{run_id}"
    manifest = _load_snapshot(run_dir)
    report = manifest.report(report_id)
    if report is None:
        raise HTTPException(404, f"report '{report_id}' not declared in manifest")
    receipt = _load_receipt(run_dir)
    store = CheckpointStore(run_dir)
    try:
        path = render_report(
            engine=get_engine(EngineType.PANDAS),
            manifest=manifest,
            spec=report,
            store=store,
            receipt=receipt,
        )
    except KeyError as exc:
        raise HTTPException(400, str(exc)) from exc
    return {"report_id": report_id, "path": path}
