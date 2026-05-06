"""Workflow endpoints — the PBR-001 Phase 2 unified surface.

Three routes on top of the manifest/runner primitives already in place:

    POST /api/workflows/plan        → build + sign a manifest
    POST /api/workflows/run         → execute a signed manifest
    GET  /api/runs/{run_id}/events  → SSE stream of run lifecycle events

The *manifest* module still owns CRUD (/api/manifests/*). These endpoints
are the cross-surface contract Claude, the CLI, and the UI all target
identically — the name "workflows" signals "plan + run" as one thing.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException
from fastapi.responses import StreamingResponse

from ..core.event_bus import event_bus
from ..core.manifest import (
    RunRecord,
    RunStatus,
    SwarmManifest,
)
from ..core.manifest_hash import sign_manifest, verify_signature
from ..core.models import get_active_model
from ..graph.manifest_runner import execute_manifest, plan_from_requirement
from ..persistence import run_store
from .manifest_routes import PlanRequest, RunResponse

logger = logging.getLogger(__name__)
router = APIRouter()


# ---- plan ------------------------------------------------------------------


@router.post("/plan", response_model=SwarmManifest)
async def plan_workflow(req: PlanRequest) -> SwarmManifest:
    """Plan without executing; the returned manifest is signed (content_hash
    + signature) so callers can cache and later re-submit it to
    /workflows/run confident nothing changed en route."""
    try:
        model = req.model or (req.config.model if req.config else None)
        if not model:
            model = await get_active_model(req.workspace, role="plan")

        manifest = await plan_from_requirement(
            requirement=req.requirement,
            workspace=req.workspace,
            model=model,
            input_files=list(req.inputs.files),
            output_spec=req.outputs,
            max_concurrency=(
                req.config.max_concurrency if req.config else req.max_concurrency
            ),
            max_depth=(req.config.max_depth if req.config else req.max_depth),
            name=req.name,
        )
    except Exception as exc:
        logger.exception("workflows.plan failed")
        raise HTTPException(500, f"Planner failed: {exc}")

    if req.inputs:
        manifest.inputs = req.inputs
    if req.config:
        manifest.config = req.config
    if req.outputs:
        manifest.outputs = req.outputs

    manifest = sign_manifest(manifest)
    if req.save:
        run_store.save_manifest(manifest)
    return manifest


# ---- run -------------------------------------------------------------------


async def _run_in_background(manifest: SwarmManifest, run_id: str) -> None:
    """Execute and emit lifecycle events to the event_bus.

    Events emitted:
      * workflow_started   — right before execute_manifest is invoked
      * workflow_completed — terminal success
      * workflow_failed    — terminal failure (caught, re-raised to UI)
    """
    event_bus.emit(
        run_id,
        "workflow_started",
        {"manifest_id": manifest.id, "workspace": manifest.workspace},
    )
    try:
        record = await execute_manifest(manifest, run_id=run_id)
    except Exception as exc:
        logger.exception("workflows.run: run %s failed", run_id)
        run_store.update_run_status(run_id, RunStatus.FAILED, errors=[str(exc)])
        event_bus.emit(run_id, "workflow_failed", {"error": str(exc)})
        return

    event_bus.emit(
        run_id,
        "workflow_completed",
        {
            "status": record.status.value if hasattr(record.status, "value") else str(record.status),
            "artifact_paths": list(record.artifact_paths or []),
        },
    )


@router.post("/run", response_model=RunResponse)
async def run_workflow(
    manifest: SwarmManifest, background_tasks: BackgroundTasks
) -> RunResponse:
    """Execute an inline manifest. If the manifest carries a signature, it is
    verified before the run is queued — we refuse to execute tampered
    manifests."""
    if manifest.signature is not None and not verify_signature(manifest):
        raise HTTPException(
            400,
            "Manifest signature does not match content_hash — refusing to run.",
        )

    run_store.save_manifest(manifest)
    run_id = f"run-{uuid.uuid4().hex[:12]}"
    pending = RunRecord(
        run_id=run_id,
        manifest_id=manifest.id,
        workspace=manifest.workspace,
        status=RunStatus.PENDING,
        started_at=datetime.utcnow().isoformat(),
        manifest_snapshot=manifest.model_dump(),
    )
    run_store.save_run(pending)
    background_tasks.add_task(_run_in_background, manifest, run_id)
    return RunResponse(run_id=run_id, manifest_id=manifest.id, status="pending")


# ---- SSE events ------------------------------------------------------------


@router.get("/runs/{run_id}/events")
async def stream_run_events(run_id: str) -> StreamingResponse:
    """Server-Sent Events stream for a run's lifecycle.

    The stream terminates when a ``workflow_completed`` or
    ``workflow_failed`` event is emitted (see ``EventBus.subscribe``), so
    clients can safely await the generator to exhaustion.
    """
    return StreamingResponse(
        event_bus.subscribe(run_id),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ---- last-known run status (used by UI reconnect) --------------------------


@router.get("/runs/{run_id}/record", response_model=Optional[RunRecord])
async def get_run_record(run_id: str) -> Optional[RunRecord]:
    """Convenience: the same record as /api/runs/{id}, exposed on the
    /workflows surface so UIs only need to learn one URL family."""
    return run_store.get_run(run_id)
