"""
Manifest Routes — declarative plan-then-run API.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from ..core.manifest import (
    InputSpec,
    ManifestConfig,
    OutputSpec,
    RunRecord,
    RunStatus,
    SwarmManifest,
    should_trigger_swarm,
)
from ..core.models import get_active_model
from ..graph.manifest_runner import execute_manifest, plan_from_requirement
from ..persistence import run_store

logger = logging.getLogger(__name__)
router = APIRouter()


# =============================================================================
# REQUEST / RESPONSE MODELS
# =============================================================================


class PlanRequest(BaseModel):
    requirement: str = Field(..., description="Natural-language requirement")
    name: Optional[str] = Field(None, description="Human-readable manifest name")
    workspace: str = "default"
    model: Optional[str] = None
    max_concurrency: int = 1
    max_depth: int = 3
    inputs: InputSpec = Field(default_factory=InputSpec)
    outputs: OutputSpec = Field(default_factory=OutputSpec)
    config: Optional[ManifestConfig] = None
    save: bool = Field(
        default=True,
        description="If True, persist the manifest to the run_store so it appears in /api/manifests",
    )


class RunResponse(BaseModel):
    run_id: str
    manifest_id: str
    status: str
    governance_url: Optional[str] = None


class TriggerCheckRequest(BaseModel):
    message: str
    input_files: List[str] = Field(default_factory=list)
    outputs: Optional[OutputSpec] = None


class TriggerCheckResponse(BaseModel):
    should_swarm: bool
    reason: str


# =============================================================================
# PLAN
# =============================================================================


@router.post("/plan", response_model=SwarmManifest)
async def plan_manifest(req: PlanRequest) -> SwarmManifest:
    """Run the planner and return a SwarmManifest WITHOUT executing."""
    try:
        model = req.model or (req.config.model if req.config else None)
        if not model:
            model = await get_active_model(req.workspace, role="swarm")

        manifest = await plan_from_requirement(
            requirement=req.requirement,
            workspace=req.workspace,
            model=model,
            input_files=list(req.inputs.files),
            output_spec=req.outputs,
            max_concurrency=(req.config.max_concurrency if req.config else req.max_concurrency),
            max_depth=(req.config.max_depth if req.config else req.max_depth),
            name=req.name,
        )
    except Exception as e:
        logger.exception("manifest plan failed")
        raise HTTPException(500, f"Planner failed: {e}")

    if req.inputs:
        manifest.inputs = req.inputs
    if req.config:
        manifest.config = req.config
    if req.outputs:
        manifest.outputs = req.outputs

    if req.save:
        run_store.save_manifest(manifest)
    return manifest


# =============================================================================
# MANIFEST CRUD
# =============================================================================


@router.get("", response_model=List[SwarmManifest])
async def list_manifests() -> List[SwarmManifest]:
    return run_store.list_manifests()


@router.get("/{manifest_id}", response_model=SwarmManifest)
async def get_manifest(manifest_id: str) -> SwarmManifest:
    m = run_store.get_manifest(manifest_id)
    if not m:
        raise HTTPException(404, f"Manifest not found: {manifest_id}")
    return m


@router.post("", response_model=SwarmManifest)
async def upsert_manifest(manifest: SwarmManifest) -> SwarmManifest:
    return run_store.save_manifest(manifest)


@router.delete("/{manifest_id}")
async def delete_manifest(manifest_id: str) -> Dict[str, Any]:
    ok = run_store.delete_manifest(manifest_id)
    if not ok:
        raise HTTPException(404, f"Manifest not found: {manifest_id}")
    return {"status": "deleted", "id": manifest_id}


# =============================================================================
# EXECUTION
# =============================================================================


async def _run_and_record(manifest: SwarmManifest, run_id: str) -> None:
    """Background task wrapper around execute_manifest."""
    try:
        await execute_manifest(manifest, run_id=run_id)
    except Exception as e:
        logger.exception("manifest run failed: %s", run_id)
        run_store.update_run_status(run_id, RunStatus.FAILED, errors=[str(e)])


@router.post("/{manifest_id}/run", response_model=RunResponse)
async def run_manifest(
    manifest_id: str, background_tasks: BackgroundTasks
) -> RunResponse:
    manifest = run_store.get_manifest(manifest_id)
    if not manifest:
        raise HTTPException(404, f"Manifest not found: {manifest_id}")

    run_id = f"run-{uuid.uuid4().hex[:12]}"
    from datetime import datetime

    pending = RunRecord(
        run_id=run_id,
        manifest_id=manifest.id,
        workspace=manifest.workspace,
        status=RunStatus.PENDING,
        started_at=datetime.utcnow().isoformat(),
        manifest_snapshot=manifest.model_dump(),
    )
    run_store.save_run(pending)

    background_tasks.add_task(_run_and_record, manifest, run_id)
    return RunResponse(run_id=run_id, manifest_id=manifest.id, status="pending")


@router.post("/run", response_model=RunResponse)
async def run_inline_manifest(
    manifest: SwarmManifest, background_tasks: BackgroundTasks
) -> RunResponse:
    """Execute a manifest passed in the request body. Also saves it."""
    run_store.save_manifest(manifest)

    run_id = f"run-{uuid.uuid4().hex[:12]}"
    from datetime import datetime

    pending = RunRecord(
        run_id=run_id,
        manifest_id=manifest.id,
        workspace=manifest.workspace,
        status=RunStatus.PENDING,
        started_at=datetime.utcnow().isoformat(),
        manifest_snapshot=manifest.model_dump(),
    )
    run_store.save_run(pending)

    background_tasks.add_task(_run_and_record, manifest, run_id)
    return RunResponse(run_id=run_id, manifest_id=manifest.id, status="pending")


# =============================================================================
# RUN HISTORY
# =============================================================================


@router.get("/runs", response_model=List[RunRecord])
async def list_runs(
    workspace: Optional[str] = None, limit: int = 100
) -> List[RunRecord]:
    return run_store.list_runs(workspace=workspace, limit=limit)


@router.get("/{manifest_id}/runs", response_model=List[RunRecord])
async def list_runs_for_manifest(
    manifest_id: str, limit: int = 50
) -> List[RunRecord]:
    return run_store.list_runs(manifest_id=manifest_id, limit=limit)


@router.get("/runs/{run_id}", response_model=RunRecord)
async def get_run(run_id: str) -> RunRecord:
    rec = run_store.get_run(run_id)
    if not rec:
        raise HTTPException(404, f"Run not found: {run_id}")
    return rec


# =============================================================================
# SWARM TRIGGER CHECK — for the chat surface
# =============================================================================


@router.post("/trigger-check", response_model=TriggerCheckResponse)
async def trigger_check(req: TriggerCheckRequest) -> TriggerCheckResponse:
    trigger, reason = should_trigger_swarm(
        message=req.message,
        input_files=req.input_files,
        output_spec=req.outputs,
    )
    return TriggerCheckResponse(should_swarm=trigger, reason=reason)
