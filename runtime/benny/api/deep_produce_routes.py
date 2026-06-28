"""Deep-produce routes — launch an orchestrated multi-panel view generation and
read its result. The fan-out trace shows up in the Bridge Runs mode via the
existing /governance/events + /manifests/runs surfaces (deep_produce records a
run and emits per-stage NODE_EXECUTION_STATE events).
"""

from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field

from ..core.manifest import RunRecord, RunStatus
from ..deepproduce import deep_produce, load_run_result
from ..deepproduce.producer import DEFAULT_PANEL_COUNT, MANIFEST_ID
from ..persistence import run_store

logger = logging.getLogger(__name__)
router = APIRouter()


class DeepProduceRequest(BaseModel):
    goal: str
    workspace: str = "default"
    model: str | None = None
    panels: int = Field(default=DEFAULT_PANEL_COUNT, ge=1, le=8)


class DeepProduceResponse(BaseModel):
    run_id: str
    status: str


async def _run_and_record(
    goal: str, workspace: str, model: str | None, panels: int, run_id: str
) -> None:
    try:
        await deep_produce(
            goal=goal, workspace=workspace, model=model, panel_count=panels, run_id=run_id
        )
    except Exception as exc:  # deep_produce already marks the run FAILED
        logger.exception("deep-produce run failed: %s", run_id)


@router.post("/deep-produce", response_model=DeepProduceResponse)
async def start_deep_produce(
    req: DeepProduceRequest, background_tasks: BackgroundTasks
) -> DeepProduceResponse:
    goal = (req.goal or "").strip()
    if not goal:
        raise HTTPException(status_code=400, detail="goal is required")

    run_id = f"dp-{uuid.uuid4().hex[:12]}"
    # Pre-record a PENDING run so the Bridge can poll /manifests/runs immediately,
    # even before the first model call returns.
    run_store.save_run(
        RunRecord(
            run_id=run_id,
            manifest_id=MANIFEST_ID,
            workspace=req.workspace,
            status=RunStatus.PENDING,
            manifest_snapshot={"goal": goal, "panel_count": req.panels, "model": req.model},
        )
    )
    background_tasks.add_task(_run_and_record, goal, req.workspace, req.model, req.panels, run_id)
    return DeepProduceResponse(run_id=run_id, status="pending")


@router.get("/deep-produce/{run_id}")
async def get_deep_produce(run_id: str, workspace: str = "default") -> dict:
    return load_run_result(run_id, workspace=workspace)
