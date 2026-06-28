"""
opencode execution route — Open-Studio Phase 3.

POST /api/opencode/run delegates a coding task to opencode inside a workspace
working directory, lineage-tracked like any other Benny run.

ADR-001 determinism boundary: the run is confined to the workspace root (the review/
sandbox zone). A ``subdir`` may scope it further but may not escape the workspace.
"""

import logging
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..core.task_manager import task_manager
from ..core.workspace import get_workspace_path
from ..governance.lineage import (
    track_workflow_complete,
    track_workflow_fail,
    track_workflow_start,
)
from ..tools.opencode import opencode_available, run_opencode_task

logger = logging.getLogger(__name__)
router = APIRouter()


class OpencodeRunRequest(BaseModel):
    prompt: str
    workspace: str = "default"
    subdir: Optional[str] = None  # optional dir inside the workspace to run in
    model: Optional[str] = None  # provider/model, e.g. "ollama/gpt-oss:20b"
    agent: Optional[str] = None  # opencode agent override
    timeout: float = 600.0


@router.get("/status")
async def opencode_status():
    """Whether opencode is installed on this host."""
    return {"available": opencode_available()}


@router.post("/run")
async def opencode_run(req: OpencodeRunRequest):
    if not opencode_available():
        raise HTTPException(503, "opencode CLI not installed on this host")

    # Confine to the workspace root (ADR-001 review zone). Resolve and verify the
    # target never escapes it.
    ws_root = Path(get_workspace_path(req.workspace)).resolve()
    target = (ws_root / req.subdir).resolve() if req.subdir else ws_root
    if ws_root not in target.parents and target != ws_root:
        raise HTTPException(400, "subdir escapes the workspace root")
    target.mkdir(parents=True, exist_ok=True)

    run_id = str(uuid.uuid4())
    task_manager.create_task(req.workspace, "opencode_run", task_id=run_id)
    try:
        track_workflow_start(run_id, "opencode_run", req.workspace, inputs=[req.prompt])
    except Exception as e:  # lineage is best-effort
        logger.warning("opencode lineage start failed: %s", e)

    result = await run_opencode_task(
        req.prompt,
        str(target),
        model=req.model,
        agent=req.agent,
        timeout=req.timeout,
    )

    status = "completed" if result.get("ok") else "failed"
    task_manager.update_task(
        run_id,
        status=status,
        progress=100,
        message="opencode run finished" if result.get("ok") else "opencode run failed",
    )
    try:
        if result.get("ok"):
            track_workflow_complete(
                run_id,
                "opencode_run",
                req.workspace,
                ["opencode"],
                0,
                outputs=result.get("git", {}).get("changed_files", []),
            )
        else:
            track_workflow_fail(
                run_id,
                "opencode_run",
                req.workspace,
                result.get("stderr") or result.get("error") or "opencode failed",
            )
    except Exception as e:
        logger.warning("opencode lineage finalize failed: %s", e)

    return {"run_id": run_id, "status": status, **result}
